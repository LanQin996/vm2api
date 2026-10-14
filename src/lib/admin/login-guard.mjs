/**
 * Panel login guard: keeps a login flood from pegging the control plane.
 *
 *   in-flight cap — at most N password checks at once (default 2 of the 4 libuv pool threads); extras get 429 now, never queued
 *   per client IP — token bucket charged per attempt, refunded on success
 *   per username  — token bucket charged per failure only; success clears it (temporary backoff, no lockout)
 *
 * Client IP is the socket peer. The first X-Forwarded-For hop is honoured only
 * with KIN_TRUST_PROXY=1 (a spoofable header otherwise).
 */

export const LOGIN_RATE_LIMITED_MESSAGE = '登录尝试过于频繁，请稍后再试'

export const LOGIN_GUARD_DEFAULTS = Object.freeze({
  trust_proxy: false,
  max_in_flight: 2,
  ip_burst: 20,
  ip_per_min: 10,
  user_burst: 5,
  user_per_min: 1,
  max_entries: 10000,
})

function envFlag(v) {
  return /^(1|true|yes|on)$/i.test(String(v ?? '').trim())
}

function positive(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** cfg.limits.login from env (VM2API_* wins over KIN_*). */
export function loginGuardOptionsFromEnv(env = process.env) {
  const pick = (name) => env[`VM2API_${name}`] ?? env[`KIN_${name}`]
  const d = LOGIN_GUARD_DEFAULTS
  return {
    trust_proxy: envFlag(pick('TRUST_PROXY')),
    max_in_flight: Math.floor(positive(pick('LOGIN_MAX_INFLIGHT'), d.max_in_flight)),
    ip_burst: positive(pick('LOGIN_IP_BURST'), d.ip_burst),
    ip_per_min: positive(pick('LOGIN_IP_PER_MIN'), d.ip_per_min),
    user_burst: positive(pick('LOGIN_USER_BURST'), d.user_burst),
    user_per_min: positive(pick('LOGIN_USER_PER_MIN'), d.user_per_min),
    max_entries: d.max_entries,
  }
}

export function loginClientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const xf = String(req?.headers?.['x-forwarded-for'] || '')
      .split(',')[0]
      .trim()
    if (xf) return xf.slice(0, 64)
  }
  return String(req?.socket?.remoteAddress || 'unknown').slice(0, 64)
}

/** Bounded token buckets; full (idle) buckets are dropped, then oldest-touched. */
function createBuckets({ capacity, perMin, maxEntries, now }) {
  const refillPerMs = perMin / 60000
  const map = new Map()

  function current(key) {
    const b = map.get(key)
    if (!b) return capacity
    return Math.min(capacity, b.tokens + (now() - b.at) * refillPerMs)
  }

  function store(key, tokens) {
    map.delete(key)
    if (tokens >= capacity) return
    map.set(key, { tokens, at: now() })
    if (map.size <= maxEntries) return
    for (const k of map.keys()) {
      if (map.size <= maxEntries) break
      if (current(k) >= capacity) map.delete(k)
    }
    for (const k of map.keys()) {
      if (map.size <= maxEntries) break
      map.delete(k)
    }
  }

  function retryAfterSec(tokens) {
    return Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000))
  }

  return {
    /** Non-consuming check. */
    peek(key) {
      const tokens = current(key)
      return tokens >= 1 ? { ok: true } : { ok: false, retryAfter: retryAfterSec(tokens) }
    },
    take(key) {
      const tokens = current(key)
      if (tokens < 1) return { ok: false, retryAfter: retryAfterSec(tokens) }
      store(key, tokens - 1)
      return { ok: true }
    },
    give(key) {
      store(key, Math.min(capacity, current(key) + 1))
    },
    reset(key) {
      map.delete(key)
    },
    get size() {
      return map.size
    },
  }
}

export function createLoginGuard(options = {}, { now = Date.now } = {}) {
  const o = { ...LOGIN_GUARD_DEFAULTS, ...(options || {}) }
  const maxInFlight = Math.max(1, Math.floor(positive(o.max_in_flight, LOGIN_GUARD_DEFAULTS.max_in_flight)))
  const maxEntries = Math.max(1, Math.floor(positive(o.max_entries, LOGIN_GUARD_DEFAULTS.max_entries)))
  const d = LOGIN_GUARD_DEFAULTS
  const ipBuckets = createBuckets({
    capacity: Math.max(1, positive(o.ip_burst, d.ip_burst)),
    perMin: positive(o.ip_per_min, d.ip_per_min),
    maxEntries,
    now,
  })
  const userBuckets = createBuckets({
    capacity: Math.max(1, positive(o.user_burst, d.user_burst)),
    perMin: positive(o.user_per_min, d.user_per_min),
    maxEntries,
    now,
  })
  let inFlight = 0

  const userKey = (username) =>
    String(username || '')
      .trim()
      .toLowerCase()
      .slice(0, 64)

  return {
    clientIp(req) {
      return loginClientIp(req, { trustProxy: !!o.trust_proxy })
    },
    /** Charge one attempt to the client IP. */
    takeIp(ip) {
      return ipBuckets.take(ip)
    },
    /** Refuse a username that is backing off after repeated failures. */
    checkUser(username) {
      return userBuckets.peek(userKey(username))
    },
    /** @returns {(() => void) | null} release fn, or null when the cap is full */
    acquire() {
      if (inFlight >= maxInFlight) return null
      inFlight += 1
      let released = false
      return () => {
        if (released) return
        released = true
        inFlight -= 1
      }
    },
    /** Hand the IP token back (attempt never reached a password check, or it succeeded). */
    refundIp(ip) {
      ipBuckets.give(ip)
    },
    recordFailure(_ip, username) {
      userBuckets.take(userKey(username))
    },
    recordSuccess(ip, username) {
      ipBuckets.give(ip)
      userBuckets.reset(userKey(username))
    },
    stats() {
      return {
        in_flight: inFlight,
        max_in_flight: maxInFlight,
        ip_entries: ipBuckets.size,
        user_entries: userBuckets.size,
      }
    },
  }
}
