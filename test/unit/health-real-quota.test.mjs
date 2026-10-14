import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'
const ROUTES = [
  ['/v1/messages', { messages: [{ role: 'user', content: 'hello' }] }],
  ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }],
  ['/v1/completions', { prompt: 'hello' }],
]

async function gateway(t) {
  // Inference is mocked by the harness; the Rust router still requires an existing binary path.
  const gw = await startGateway({ env: { KIN_KERNEL_BIN: process.execPath } })
  t.after(async () => {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  })
  return gw
}

async function accountUsage(gw) {
  const response = await api(gw, 'GET', '/admin/quota')
  assert.equal(response.status, 200, response.text)
  return response.json.accounts.find((account) => account.account_id === 'acct-seed')
}

test('forged health-real headers cannot bypass managed key quotas in any Claude protocol', async (t) => {
  const gw = await gateway(t)
  for (const [route, input] of ROUTES) {
    for (const stream of [false, true]) {
      await t.test(`${route} stream=${stream}: one success followed by two quota rejections`, async () => {
        const created = await api(gw, 'POST', '/api/panel/api-keys', {
          body: { name: `${route}-${stream}`, quota_requests: 1, rpm: 0 },
        })
        assert.equal(created.status, 201, created.text)
        const key = created.json.item
        const before = await accountUsage(gw)
        const statuses = []
        const rejectedCodes = []
        for (let call = 0; call < 3; call++) {
          const response = await api(gw, 'POST', route, {
            headers: {
              authorization: `Bearer ${key.key}`,
              'X-Kin-Health-Real': '1',
              // Copying the monitor's UA and pin must not grant accounting privileges.
              'user-agent': 'kin-health-probe/1.0',
              'x-kin-vm': 'vm-sim-01',
              'x-forwarded-for': '127.0.0.1',
            },
            body: { model: MODEL, max_tokens: 8192, stream, ...input },
          })
          statuses.push(response.status)
          if (call > 0) rejectedCodes.push(response.json?.error?.code)
          else if (stream) assert.match(response.text, /message_stop|\[DONE\]/)
        }
        assert.deepEqual(statuses, [200, 429, 429])
        assert.deepEqual(rejectedCodes, ['api_key_quota_exhausted', 'api_key_quota_exhausted'])
        const listed = await api(gw, 'GET', '/api/panel/api-keys')
        const used = listed.json.keys.find((item) => item.id === key.id)
        assert.equal(used.quota_used, 1)
        assert.equal(used.requests, 1)
        assert.ok(used.tokens_in > 0)
        assert.ok(used.tokens_out > 0)
        assert.ok(used.quota_usd_used > 0)
        const after = await accountUsage(gw)
        assert.equal(after.requests, before.requests + 1)
        assert.ok(after.tokens_in > before.tokens_in)
        assert.ok(after.tokens_out > before.tokens_out)
        assert.ok(after.last_used_at > (before.last_used_at || 0))
      })
    }
  }
})

test('all accepted health-real values still bill ordinary keys', async (t) => {
  const gw = await gateway(t)
  for (const value of ['true', 'yes']) {
    await t.test(value, async () => {
      const created = await api(gw, 'POST', '/api/panel/api-keys', {
        body: { name: value, quota_requests: 1, rpm: 0 },
      })
      const headers = { authorization: `Bearer ${created.json.item.key}`, 'x-kin-health-real': value }
      const body = { model: MODEL, max_tokens: 8192, ...ROUTES[0][1] }
      const first = await api(gw, 'POST', '/v1/messages', { headers, body })
      assert.equal(first.status, 200, first.text)
      const second = await api(gw, 'POST', '/v1/messages', { headers, body })
      assert.equal(second.status, 429, second.text)
      assert.equal(second.json.error.code, 'api_key_quota_exhausted')
    })
  }
})

test('authenticated internal health probes remain exempt while ordinary master traffic is counted', async (t) => {
  const gw = await gateway(t)
  const before = await accountUsage(gw)
  const probe = await api(gw, 'POST', '/api/panel/health-probe')
  assert.equal(probe.status, 200, probe.text)
  assert.equal(probe.json.data.snapshot.ok, true, probe.text)
  assert.equal(probe.json.data.snapshot.status, 200, probe.text)
  const afterProbe = await accountUsage(gw)
  assert.equal(afterProbe.requests, before.requests)
  assert.equal(afterProbe.tokens_in, before.tokens_in)
  assert.equal(afterProbe.tokens_out, before.tokens_out)
  assert.equal(afterProbe.last_used_at, before.last_used_at)

  const ordinary = await api(gw, 'POST', '/v1/messages', {
    body: { model: MODEL, max_tokens: 8192, ...ROUTES[0][1] },
  })
  assert.equal(ordinary.status, 200, ordinary.text)
  assert.equal((await accountUsage(gw)).requests, before.requests + 1)
})
