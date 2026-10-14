/**
 * Per-slot working window (`vm.policy.active_hours`). Outside the window the
 * slot is simply not a candidate — the rest of the pool absorbs its traffic.
 * Human simulation: a window like 08:00–22:00 in the slot's own timezone (the
 * zone already synced from its proxy exit) reads as a day shift, not 24/7.
 *
 * Stored shape — every field validated on write:
 *   { start: 'HH:MM', end: 'HH:MM', timezone?: IANA, days?: number[] }
 * `start` may be later than `end` (20:00–08:00 is an overnight shift). `days`
 * lists the weekdays a window may *start* on (0 = Sunday); absent = every day.
 */
import { validTimezone, zonedParts } from '../core/timezone.mjs'

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const DAY_MS = 24 * 60 * 60 * 1000

function minutesOf(value) {
  const match = TIME_RE.exec(String(value || '').trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

function hhmm(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function normalizeDays(raw) {
  if (raw == null) return null
  if (!Array.isArray(raw)) return undefined
  const days = [...new Set(raw.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
  return days.length ? days.sort((a, b) => a - b) : undefined
}

/** Strict parse of a panel PATCH `active_hours` body. `null` clears the window. */
export function parseActiveHoursInput(raw) {
  if (raw == null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'active_hours must be an object or null' }
  }
  const start = minutesOf(raw.start)
  const end = minutesOf(raw.end)
  if (start == null || end == null) {
    return { ok: false, error: 'active_hours.start and active_hours.end must be "HH:MM"' }
  }
  if (start === end) {
    return { ok: false, error: 'active_hours.start and active_hours.end must differ' }
  }
  const out = { start: hhmm(start), end: hhmm(end) }
  if (raw.timezone != null && String(raw.timezone).trim() !== '') {
    const zone = validTimezone(raw.timezone)
    if (!zone) return { ok: false, error: 'active_hours.timezone must be a valid IANA name' }
    out.timezone = zone
  }
  if (raw.days != null) {
    const days = normalizeDays(raw.days)
    if (!days) return { ok: false, error: 'active_hours.days must be a non-empty array of weekday numbers 0–6' }
    out.days = days
  }
  return { ok: true, value: out }
}

/**
 * Lenient read of the stored record: hand-edited invalid fields drop individually.
 * Takes a raw record (`policy.active_hours`) or a `listVms` summary (top-level).
 */
export function activeHoursOf(vm) {
  const raw = vm?.policy ? vm.policy.active_hours : vm?.active_hours
  if (!raw || typeof raw !== 'object') return null
  const start = minutesOf(raw.start)
  const end = minutesOf(raw.end)
  if (start == null || end == null || start === end) return null
  const out = { start: hhmm(start), end: hhmm(end) }
  const zone = validTimezone(raw.timezone)
  if (zone) out.timezone = zone
  const days = normalizeDays(raw.days)
  if (days) out.days = days
  return out
}

/** Effective zone: the window's own pin, else the slot's synced zone, else UTC. */
export function activeHoursZoneOf(config, vm = null) {
  return validTimezone(config?.timezone) || validTimezone(vm?.timezone) || 'UTC'
}

function internalize(config) {
  if (!config) return null
  const start = minutesOf(config.start)
  const end = minutesOf(config.end)
  if (start == null || end == null || start === end) return null
  const days = normalizeDays(config.days)
  return {
    startMin: start,
    endMin: end,
    timezone: validTimezone(config.timezone) || null,
    days: days ? new Set(days) : null,
  }
}

function weekdayOf(parts, dayOffset) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset)).getUTCDay()
}

const HOUR_MS = 60 * 60 * 1000

/** Local wall clock of `ms` in `timeZone`, as a UTC-encoded ms at minute precision. */
function wallOf(ms, timeZone) {
  const p = zonedParts(ms, timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
}

function offsetAt(ms, timeZone) {
  return wallOf(ms, timeZone) - Math.floor(ms / 60000) * 60000
}

/**
 * First instant whose local wall clock reaches `wall` (UTC-encoded). A time
 * skipped by spring-forward resolves to the jump itself; a time repeated by
 * fall-back resolves to its first occurrence. Assumes ≤ 1 transition per ±1 day.
 */
function wallToInstant(wall, timeZone) {
  const early = wall - offsetAt(wall - DAY_MS, timeZone)
  const late = wall - offsetAt(wall + DAY_MS, timeZone)
  const hits = [early, late].filter((ms) => wallOf(ms, timeZone) === wall)
  if (hits.length) return Math.min(...hits)
  // Gap: the jump lies between the two candidates; find it to the minute.
  let lo = Math.min(early, late)
  let hi = Math.max(early, late)
  while (hi - lo > 60000) {
    const mid = lo + Math.floor((hi - lo) / 120000) * 60000
    if (wallOf(mid, timeZone) >= wall) hi = mid
    else lo = mid
  }
  return hi
}

/** Window opening on local day `parts.day + dayOffset`, as exact instants. */
function windowOn(hours, parts, dayOffset, timeZone) {
  const day = Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset)
  const endDay = hours.startMin > hours.endMin ? day + DAY_MS : day
  return {
    allowed: !hours.days || hours.days.has(weekdayOf(parts, dayOffset)),
    startMs: wallToInstant(day + hours.startMin * 60000, timeZone),
    endMs: wallToInstant(endDay + hours.endMin * 60000, timeZone),
  }
}

/** Soonest instant an allowed window opens after `now`. */
function nextWindowStartMs(hours, parts, now, timeZone) {
  for (let offset = 0; offset <= 8; offset++) {
    const window = windowOn(hours, parts, offset, timeZone)
    if (window.allowed && window.startMs > now) return window.startMs
  }
  return now + DAY_MS
}

/** Wall-clock test; exact whenever no UTC offset change sits within the window span. */
function inWindowByWall(hours, parts) {
  const t = parts.hour * 60 + parts.minute
  const { startMin: s, endMin: e } = hours
  const overnight = s > e
  const inWindow = overnight ? t >= s || t < e : t >= s && t < e
  // The day the running window opened; past-midnight halves belong to yesterday.
  const startDayOffset = overnight && t < e ? -1 : 0
  return inWindow && (!hours.days || hours.days.has(weekdayOf(parts, startDayOffset)))
}

/**
 * Is the slot inside its working window at `now`?
 * `days` gates the day the window *starts* on: an overnight shift opened on an
 * allowed day keeps running past midnight into an unlisted day. Around a DST
 * transition the windows are compared as exact instants, so a start inside a
 * skipped hour opens at the jump and a repeated hour does not cut a shift.
 * @returns {{active:true}|{active:false, until:number}}
 */
export function evaluateActiveHours(config, now = Date.now(), fallbackTz = 'UTC') {
  const hours = internalize(config)
  if (!hours) return { active: true }
  const timeZone = validTimezone(hours.timezone) || validTimezone(fallbackTz) || 'UTC'
  const parts = zonedParts(now, timeZone)
  // A window spans < 24h, so a stable offset across ±36h makes wall time exact.
  const stable = offsetAt(now - 36 * HOUR_MS, timeZone) === offsetAt(now + 36 * HOUR_MS, timeZone)
  let active
  if (stable) active = inWindowByWall(hours, parts)
  else {
    active = [-1, 0].some((offset) => {
      const window = windowOn(hours, parts, offset, timeZone)
      return window.allowed && window.startMs <= now && now < window.endMs
    })
  }
  if (active) return { active: true }
  return { active: false, until: nextWindowStartMs(hours, parts, now, timeZone) }
}
