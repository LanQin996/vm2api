import test from 'node:test'
import assert from 'node:assert/strict'
import { createNotifyMonitor, summarizePoolAvailability } from '../../src/lib/admin/notify.mjs'

function fixture(send, options = {}) {
  let available = false
  const monitor = createNotifyMonitor({
    config: {
      enabled: true,
      cooldown_sec: 300,
      events: {
        pool_empty: true,
        pool_recovered: true,
        pool_low: false,
        digest: false,
        revoked: false,
        invalid: false,
      },
      ...options,
    },
    snapshot: async () =>
      summarizePoolAvailability([
        { id: 'vm-test', has_token: true, cred_status: { key: available ? 'ok' : 'bad', text: 'fixture' } },
      ]),
    send,
  })
  return {
    monitor,
    recover: () => {
      available = true
    },
  }
}

test('a quiet check does not erase an earlier delivery exception', async () => {
  const { monitor } = fixture(async () => {
    throw new Error('transport unavailable')
  })
  await monitor.runOnce()
  assert.equal(monitor.getStatus().last_error, 'transport unavailable')
  await monitor.runOnce()
  assert.equal(monitor.getStatus().last_error, 'transport unavailable')
})

test('dispatch returning ok:false is a delivery failure, not a successful health check', async () => {
  const { monitor } = fixture(async () => ({
    ok: false,
    results: [{ channel: 'telegram', ok: false, error: 'telegram_down' }],
  }))
  await monitor.runOnce()
  assert.match(monitor.getStatus().last_error, /telegram_down/)
  await monitor.runOnce()
  assert.match(monitor.getStatus().last_error, /telegram_down/)
})

test('a subsequent successful delivery clears the prior delivery error', async () => {
  let failing = true
  const { monitor, recover } = fixture(async () => {
    if (failing) throw new Error('offline')
    return { ok: true }
  })
  await monitor.runOnce()
  assert.equal(monitor.getStatus().last_error, 'offline')
  failing = false
  recover()
  await monitor.runOnce()
  assert.equal(monitor.getStatus().last_error, null)
})

test('partially successful channel dispatch remains visible as an error', async () => {
  const { monitor } = fixture(async () => ({
    ok: true,
    results: [
      { channel: 'email', ok: true },
      { channel: 'telegram', ok: false, error: 'telegram_down' },
    ],
  }))
  await monitor.runOnce()
  assert.match(monitor.getStatus().last_error, /telegram_down/)
})

test('a later event success in the same check does not hide an earlier failure', async () => {
  let calls = 0
  const { monitor } = fixture(
    async () => {
      calls += 1
      if (calls === 1) throw new Error('first event failed')
      return { ok: true }
    },
    { events: { pool_empty: true, digest: true, revoked: false, invalid: false } },
  )
  await monitor.runOnce()
  assert.equal(calls, 2)
  assert.equal(monitor.getStatus().last_error, 'first event failed')
})

test('resolved failure without details still exposes an explicit error', async () => {
  const { monitor } = fixture(async () => ({ ok: false }))
  await monitor.runOnce()
  assert.equal(monitor.getStatus().last_error, 'notify_delivery_failed')
})

test('cooldown-suppressed checks preserve failure and do not send extra notifications', async () => {
  let calls = 0
  const { monitor } = fixture(async () => {
    calls += 1
    return { ok: false }
  })
  await monitor.runOnce()
  await monitor.runOnce()
  assert.equal(calls, 1)
  assert.equal(monitor.getStatus().last_error, 'notify_delivery_failed')
})
