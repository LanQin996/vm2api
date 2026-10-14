import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LOGIN_GUARD_DEFAULTS,
  createLoginGuard,
  loginClientIp,
  loginGuardOptionsFromEnv,
} from '../../src/lib/admin/login-guard.mjs'

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t }
  return c
}

test('in-flight cap rejects immediately and frees on release', () => {
  const guard = createLoginGuard({ max_in_flight: 2 })
  const a = guard.acquire()
  const b = guard.acquire()
  assert.equal(typeof a, 'function')
  assert.equal(typeof b, 'function')
  assert.equal(guard.acquire(), null)
  a()
  a() // double release is a no-op
  assert.equal(guard.stats().in_flight, 1)
  const c = guard.acquire()
  assert.equal(typeof c, 'function')
  assert.equal(guard.acquire(), null)
  b()
  c()
  assert.equal(guard.stats().in_flight, 0)
})

test('per-IP bucket limits attempts and refills over time', () => {
  const c = clock()
  const guard = createLoginGuard({ ip_burst: 3, ip_per_min: 6 }, { now: c.now })
  for (let i = 0; i < 3; i++) assert.equal(guard.takeIp('1.2.3.4').ok, true)
  const blocked = guard.takeIp('1.2.3.4')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.retryAfter, 10)
  assert.equal(guard.takeIp('5.6.7.8').ok, true, 'other IPs are unaffected')
  c.t += 10_000
  assert.equal(guard.takeIp('1.2.3.4').ok, true)
  assert.equal(guard.takeIp('1.2.3.4').ok, false)
})

test('successful logins refund the IP token so normal use is never limited', () => {
  const guard = createLoginGuard({ ip_burst: 2, ip_per_min: 1 })
  for (let i = 0; i < 20; i++) {
    assert.equal(guard.takeIp('10.0.0.1').ok, true)
    guard.recordSuccess('10.0.0.1', 'admin')
  }
})

test('per-username limiter counts failures only, backs off, recovers, and resets on success', () => {
  const c = clock()
  const guard = createLoginGuard({ user_burst: 3, user_per_min: 2 }, { now: c.now })
  assert.equal(guard.checkUser('Admin').ok, true)
  for (let i = 0; i < 3; i++) guard.recordFailure('1.1.1.1', 'admin')
  const blocked = guard.checkUser('ADMIN ')
  assert.equal(blocked.ok, false, 'username key is case/space-insensitive')
  assert.equal(blocked.retryAfter, 30)
  assert.equal(guard.checkUser('other').ok, true)
  c.t += 30_000
  assert.equal(guard.checkUser('admin').ok, true, 'temporary backoff only')
  guard.recordFailure('1.1.1.1', 'admin')
  assert.equal(guard.checkUser('admin').ok, false)
  guard.recordSuccess('1.1.1.1', 'admin')
  assert.equal(guard.checkUser('admin').ok, true)
})

test('limiter maps stay bounded', () => {
  const guard = createLoginGuard({ ip_burst: 5, ip_per_min: 1, max_entries: 50 })
  for (let i = 0; i < 500; i++) guard.takeIp(`10.0.${i >> 8}.${i & 255}`)
  for (let i = 0; i < 500; i++) guard.recordFailure('x', `user${i}`)
  assert.ok(guard.stats().ip_entries <= 50)
  assert.ok(guard.stats().user_entries <= 50)
})

test('X-Forwarded-For is ignored unless trust_proxy is enabled', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' }, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(loginClientIp(req), '127.0.0.1')
  assert.equal(loginClientIp(req, { trustProxy: true }), '203.0.113.9')
  assert.equal(loginClientIp({ headers: {}, socket: { remoteAddress: '::1' } }, { trustProxy: true }), '::1')
  assert.equal(createLoginGuard({}).clientIp(req), '127.0.0.1')
  assert.equal(createLoginGuard({ trust_proxy: true }).clientIp(req), '203.0.113.9')
})

test('env options: VM2API_* wins, bad values fall back to defaults', () => {
  assert.deepEqual(loginGuardOptionsFromEnv({}), { ...LOGIN_GUARD_DEFAULTS })
  const o = loginGuardOptionsFromEnv({
    KIN_TRUST_PROXY: '1',
    KIN_LOGIN_MAX_INFLIGHT: '3',
    VM2API_LOGIN_IP_BURST: '50',
    KIN_LOGIN_IP_BURST: '7',
    KIN_LOGIN_USER_PER_MIN: 'nope',
  })
  assert.equal(o.trust_proxy, true)
  assert.equal(o.max_in_flight, 3)
  assert.equal(o.ip_burst, 50)
  assert.equal(o.user_per_min, LOGIN_GUARD_DEFAULTS.user_per_min)
  assert.equal(loginGuardOptionsFromEnv({ KIN_TRUST_PROXY: '0' }).trust_proxy, false)
})

async function loadPanel() {
  process.env.KIN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-login-guard-'))
  const security = await import('../../src/lib/core/security.mjs')
  const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')
  return { security, createPanelHandler }
}

function panelCtx(guard, body) {
  const out = {}
  const ctx = {
    cfg: { paths: { project: os.tmpdir() } },
    routingConfig: {},
    loginGuard: guard,
    requireAuth: () => false,
    readBody: async () => body(),
    json(_res, status, payload) {
      out.status = status
      out.body = payload
      return true
    },
  }
  return { ctx, out }
}

function loginReq(ip = '198.51.100.7') {
  const headers = {}
  return {
    req: { method: 'POST', headers: { 'x-forwarded-for': '1.1.1.1' }, socket: { remoteAddress: ip } },
    res: {
      headers,
      setHeader(k, v) {
        headers[k.toLowerCase()] = v
      },
    },
  }
}

test('login route returns 429 with Retry-After when limited, and verifies asynchronously', async (t) => {
  const { security, createPanelHandler } = await loadPanel()
  let calls = 0
  let gate = null
  security.attachPanelAuth({
    authenticate: async (u, p) => {
      calls += 1
      if (gate) await gate
      return u === 'admin' && p === 'good-pass' ? { username: 'admin', role: 'admin', id: 'u1' } : null
    },
    lookupRole: (u) => (u === 'admin' ? 'admin' : null),
  })
  t.after(() => security.attachPanelAuth({}))
  const url = new URL('http://localhost/api/panel/login')
  let creds = { username: 'admin', password: 'bad-pass' }
  const guard = createLoginGuard({ max_in_flight: 1, ip_burst: 4, ip_per_min: 1, user_burst: 2, user_per_min: 1 })
  const { ctx, out } = panelCtx(guard, () => creds)
  const handle = createPanelHandler(ctx)

  // per-username: two failures, then backoff before any hashing
  for (let i = 0; i < 2; i++) {
    const { req, res } = loginReq()
    await handle(req, res, url)
    assert.equal(out.status, 401)
  }
  {
    const { req, res } = loginReq()
    await handle(req, res, url)
    assert.equal(out.status, 429)
    assert.deepEqual(out.body, { ok: false, error: { message: '登录尝试过于频繁，请稍后再试', type: 'rate_limit' } })
    assert.ok(Number(res.headers['retry-after']) >= 1)
    assert.equal(calls, 2, 'limited attempt never reaches password verification')
  }

  // in-flight cap: a second concurrent check is rejected, not queued
  creds = { username: 'other', password: 'x' }
  let open
  gate = new Promise((r) => {
    open = r
  })
  const first = loginReq('192.0.2.1')
  const pending = handle(first.req, first.res, url)
  await new Promise((r) => setImmediate(r))
  const second = loginReq('192.0.2.2')
  await handle(second.req, second.res, url)
  assert.equal(out.status, 429)
  assert.equal(second.res.headers['retry-after'], '1')
  open()
  gate = null
  await pending
  assert.equal(out.status, 401)

  // per-IP: X-Forwarded-For is not trusted, so the socket address (4 tokens, 3 spent) runs out
  const last = loginReq()
  await handle(last.req, last.res, url)
  assert.equal(out.status, 401)
  const { req, res } = loginReq()
  await handle(req, res, url)
  assert.equal(out.status, 429)
  assert.ok(Number(res.headers['retry-after']) >= 1)
  assert.equal(guard.takeIp('1.1.1.1').ok, true, 'the forwarded address was never charged')
})

test('successful login through the route clears username backoff', async (t) => {
  const { security, createPanelHandler } = await loadPanel()
  security.attachPanelAuth({
    authenticate: async (u, p) => (u === 'admin' && p === 'good-pass' ? { username: 'admin', role: 'admin' } : null),
    lookupRole: (u) => (u === 'admin' ? 'admin' : null),
  })
  t.after(() => security.attachPanelAuth({}))
  const url = new URL('http://localhost/api/panel/login')
  let creds = { username: 'admin', password: 'bad-pass' }
  const guard = createLoginGuard({ user_burst: 2, user_per_min: 1 })
  const { ctx, out } = panelCtx(guard, () => creds)
  const handle = createPanelHandler(ctx)
  const { req, res } = loginReq()
  await handle(req, res, url)
  assert.equal(out.status, 401)
  creds = { username: 'admin', password: 'good-pass' }
  for (let i = 0; i < 5; i++) {
    const r = loginReq()
    await handle(r.req, r.res, url)
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.match(String(r.res.headers['set-cookie']), /kin_panel_token=/)
  }
  assert.equal(guard.checkUser('admin').ok, true)
})
