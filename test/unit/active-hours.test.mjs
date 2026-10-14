import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseActiveHoursInput,
  activeHoursOf,
  activeHoursZoneOf,
  evaluateActiveHours,
} from '../../src/lib/pool/active-hours.mjs'

// Fixed UTC instants; windows below use simple zones so expectations stay legible.
// 2024-06-03 is a Monday.
const MON = (h, m = 0) => Date.UTC(2024, 5, 3, h, m)
const TUE = (h, m = 0) => Date.UTC(2024, 5, 4, h, m)
const SAT = (h, m = 0) => Date.UTC(2024, 5, 8, h, m)

test('parseActiveHoursInput accepts a plain daily window', () => {
  const parsed = parseActiveHoursInput({ start: '08:00', end: '22:00' })
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.value, { start: '08:00', end: '22:00' })
})

test('parseActiveHoursInput clears on null', () => {
  assert.deepEqual(parseActiveHoursInput(null), { ok: true, value: null })
  assert.deepEqual(parseActiveHoursInput(undefined), { ok: true, value: null })
})

test('parseActiveHoursInput rejects malformed input', () => {
  for (const raw of [
    'always',
    [],
    {},
    { start: '08:00' },
    { start: '8:00', end: '22:00' },
    { start: '25:00', end: '22:00' },
    { start: '08:00', end: '22:60' },
    { start: '08:00', end: '08:00' },
    { start: '08:00', end: '22:00', timezone: 'Mars/Olympus' },
    { start: '08:00', end: '22:00', days: 'weekday' },
    { start: '08:00', end: '22:00', days: [] },
    { start: '08:00', end: '22:00', days: [7] },
  ]) {
    assert.equal(parseActiveHoursInput(raw).ok, false, JSON.stringify(raw))
  }
})

test('parseActiveHoursInput normalizes timezone and days', () => {
  const parsed = parseActiveHoursInput({
    start: '20:00',
    end: '08:00',
    timezone: 'america/new_york',
    days: [5, 1, 5],
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.timezone, 'America/New_York')
  assert.deepEqual(parsed.value.days, [1, 5])
})

test('activeHoursOf reads policy leniently', () => {
  assert.equal(activeHoursOf({}), null)
  assert.equal(activeHoursOf({ policy: {} }), null)
  assert.equal(activeHoursOf({ policy: { active_hours: 'yes' } }), null)
  assert.equal(activeHoursOf({ policy: { active_hours: { start: '08:00', end: '08:00' } } }), null)
  const vm = {
    policy: {
      active_hours: { start: '9:30', end: '22:00', timezone: 'bad/zone', days: 'x' },
    },
  }
  // 9:30 is invalid (strict HH:MM) → whole record dropped.
  assert.equal(activeHoursOf(vm), null)
  const good = activeHoursOf({
    policy: { active_hours: { start: '09:30', end: '22:00', timezone: 'bad/zone', days: 'x' } },
  })
  assert.deepEqual(good, { start: '09:30', end: '22:00' })
})

test('no config means always active', () => {
  for (const now of [MON(3), TUE(12), SAT(23)]) {
    assert.equal(evaluateActiveHours(null, now).active, true)
    assert.equal(evaluateActiveHours({}, now).active, true)
  }
})

const day = { start: '08:00', end: '22:00', timezone: 'UTC' }

test('same-day window gates by local clock', () => {
  assert.equal(evaluateActiveHours(day, MON(7, 59)).active, false)
  assert.equal(evaluateActiveHours(day, MON(8)).active, true)
  assert.equal(evaluateActiveHours(day, MON(21, 59)).active, true)
  assert.equal(evaluateActiveHours(day, MON(22)).active, false)
})

test('until is the next window start in wall time', () => {
  const before = evaluateActiveHours(day, MON(7, 30))
  assert.equal(before.active, false)
  assert.equal(before.until, MON(8))
  const after = evaluateActiveHours(day, MON(23))
  assert.equal(after.active, false)
  assert.equal(after.until, TUE(8))
})

const night = { start: '20:00', end: '08:00', timezone: 'UTC' }

test('overnight window covers both halves of the night', () => {
  assert.equal(evaluateActiveHours(night, MON(19, 59)).active, false)
  assert.equal(evaluateActiveHours(night, MON(20)).active, true)
  assert.equal(evaluateActiveHours(night, MON(23, 30)).active, true)
  assert.equal(evaluateActiveHours(night, TUE(3)).active, true)
  assert.equal(evaluateActiveHours(night, TUE(7, 59)).active, true)
  assert.equal(evaluateActiveHours(night, TUE(8)).active, false)
  assert.equal(evaluateActiveHours(night, TUE(12)).active, false)
})

test('days filter gates the day the window starts', () => {
  // Monday-only night shift: Mon 20:00 → Tue 08:00.
  const mondayNights = { ...night, days: [1] }
  // Monday 21:00 — inside Monday's window.
  assert.equal(evaluateActiveHours(mondayNights, MON(21)).active, true)
  // Tuesday 03:00 — the tail of Monday's window keeps running.
  assert.equal(evaluateActiveHours(mondayNights, TUE(3)).active, true)
  // Tuesday 21:00 — Tuesday is not an allowed start day.
  const tueNight = evaluateActiveHours(mondayNights, TUE(21))
  assert.equal(tueNight.active, false)
})

test('weekday window skips the weekend when computing until', () => {
  const weekdays = { start: '08:00', end: '22:00', timezone: 'UTC', days: [1, 2, 3, 4, 5] }
  const sat = evaluateActiveHours(weekdays, SAT(12))
  assert.equal(sat.active, false)
  // Next allowed start: Monday 2024-06-10 08:00 UTC.
  assert.equal(sat.until, Date.UTC(2024, 5, 10, 8))
})

test('window honors the configured timezone', () => {
  const laDay = { start: '08:00', end: '22:00', timezone: 'America/Los_Angeles' }
  // 2024-06-03 14:00 UTC = 07:00 PDT → before the LA window opens.
  const before = evaluateActiveHours(laDay, MON(14))
  assert.equal(before.active, false)
  assert.equal(before.until, MON(15)) // 08:00 PDT = 15:00 UTC
  // 16:00 UTC = 09:00 PDT → inside.
  assert.equal(evaluateActiveHours(laDay, MON(16)).active, true)
})

test('fallback timezone is the slot zone, then UTC', () => {
  const cfg = { start: '08:00', end: '22:00' }
  // 14:00 UTC = 07:00 PDT → before window under LA fallback.
  assert.equal(evaluateActiveHours(cfg, MON(14), 'America/Los_Angeles').active, false)
  // Same instant under UTC → inside.
  assert.equal(evaluateActiveHours(cfg, MON(14), 'UTC').active, true)
  assert.equal(evaluateActiveHours(cfg, MON(14), 'bad/zone').active, true)
  assert.equal(activeHoursZoneOf(cfg, { timezone: 'Asia/Tokyo' }), 'Asia/Tokyo')
  assert.equal(activeHoursZoneOf({ ...cfg, timezone: 'Europe/Berlin' }, { timezone: 'Asia/Tokyo' }), 'Europe/Berlin')
})

test('activeHoursOf also reads a listVms summary', () => {
  assert.deepEqual(activeHoursOf({ active_hours: { start: '08:00', end: '22:00' } }), {
    start: '08:00',
    end: '22:00',
  })
  // A raw record's policy wins; a stray top-level field is not the stored window.
  assert.equal(activeHoursOf({ policy: {}, active_hours: { start: '08:00', end: '22:00' } }), null)
})

test('spring-forward: a start inside the skipped hour opens at the jump', () => {
  const cfg = { start: '02:30', end: '10:00', timezone: 'America/New_York' }
  // 2026-03-08 02:00 EST jumps to 03:00 EDT (07:00Z).
  const before = evaluateActiveHours(cfg, Date.parse('2026-03-08T06:45:00Z'))
  assert.deepEqual(before, { active: false, until: Date.parse('2026-03-08T07:00:00Z') })
  assert.equal(evaluateActiveHours(cfg, Date.parse('2026-03-08T07:10:00Z')).active, true)
})

test('spring-forward at midnight does not skip the day', () => {
  // Santiago 2026-09-06 00:00 -04 jumps to 01:00 -03 (04:00Z).
  const cfg = { start: '00:00', end: '08:00', timezone: 'America/Santiago' }
  const before = evaluateActiveHours(cfg, Date.parse('2026-09-06T03:30:00Z'))
  assert.deepEqual(before, { active: false, until: Date.parse('2026-09-06T04:00:00Z') })
  assert.equal(evaluateActiveHours(cfg, Date.parse('2026-09-06T04:10:00Z')).active, true)
})

test('fall-back: the repeated hour neither cuts nor extends a shift', () => {
  // 2026-11-01 02:00 EDT falls back to 01:00 EST (06:00Z); 01:00–02:00 repeats.
  const day = { start: '01:30', end: '09:00', timezone: 'America/New_York' }
  assert.deepEqual(evaluateActiveHours(day, Date.parse('2026-11-01T05:20:00Z')), {
    active: false,
    until: Date.parse('2026-11-01T05:30:00Z'),
  })
  assert.equal(evaluateActiveHours(day, Date.parse('2026-11-01T05:40:00Z')).active, true)
  // 01:10 EST, second pass of the repeated hour: still inside.
  assert.equal(evaluateActiveHours(day, Date.parse('2026-11-01T06:10:00Z')).active, true)
  const night = { start: '20:00', end: '01:30', timezone: 'America/New_York' }
  assert.equal(evaluateActiveHours(night, Date.parse('2026-11-01T05:20:00Z')).active, true)
  // The shift ended at the first 01:30 (05:30Z); no extra half hour.
  assert.deepEqual(evaluateActiveHours(night, Date.parse('2026-11-01T06:10:00Z')), {
    active: false,
    until: Date.parse('2026-11-02T01:00:00Z'),
  })
})
