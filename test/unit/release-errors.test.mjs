import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildUpdateStatus,
  clearReleaseCache,
  fetchLatestRelease,
  startHostUpgrade,
} from '../../src/lib/admin/release.mjs'

function fixture(t) {
  clearReleaseCache()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-errors-'))
  fs.writeFileSync(path.join(root, 'VERSION'), '1.3.179\n')
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '')
  t.after(() => {
    clearReleaseCache()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

const goodFetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v1.3.180' }) })

for (const [label, fetchImpl] of [
  [
    'network error',
    async () => {
      throw new Error('network unavailable')
    },
  ],
  ['HTTP failure', async () => ({ ok: false, status: 503 })],
  ['missing tag', async () => ({ ok: true, json: async () => ({}) })],
]) {
  test(`failed release lookup is unknown, not up to date: ${label}`, async (t) => {
    const root = fixture(t)
    const status = await buildUpdateStatus({ projectRoot: root, fetchImpl, cacheMs: 0 })
    assert.equal(status.check_status, 'failed')
    assert.equal(status.latest, null)
    assert.equal(status.latest_tag, null)
    assert.equal(status.update_available, null)
    assert.ok(status.source_error)
  })
}

test('cached stale release preserves refresh failure until a successful retry', async (t) => {
  const root = fixture(t)
  await buildUpdateStatus({ projectRoot: root, fetchImpl: goodFetch, now: () => 1000, cacheMs: 0 })
  const failed = await buildUpdateStatus({
    projectRoot: root,
    fetchImpl: async () => {
      throw new Error('offline')
    },
    now: () => 2000,
    cacheMs: 0,
  })
  let fetched = false
  const cached = await buildUpdateStatus({
    projectRoot: root,
    now: () => 2001,
    fetchImpl: async () => {
      fetched = true
      return goodFetch()
    },
  })
  for (const status of [failed, cached]) {
    assert.equal(status.check_status, 'failed')
    assert.equal(status.latest_tag, null)
    assert.equal(status.update_available, null)
    assert.equal(status.source_error, 'offline')
  }
  assert.equal(fetched, false)
  const recovered = await buildUpdateStatus({ projectRoot: root, fetchImpl: goodFetch, now: () => 2002, cacheMs: 0 })
  assert.equal(recovered.check_status, 'ok')
  assert.equal(recovered.source_error, null)
  assert.equal(recovered.latest_tag, 'v1.3.180')
  assert.equal(recovered.update_available, true)
})

test('successful same-version lookup is explicitly up to date', async (t) => {
  const status = await buildUpdateStatus({
    projectRoot: fixture(t),
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.3.179' }) }),
    cacheMs: 0,
  })
  assert.equal(status.check_status, 'ok')
  assert.equal(status.update_available, false)
})

test('automatic upgrade reports lookup failure without executing host commands', async (t) => {
  const root = fixture(t)
  let executed = false
  const result = await startHostUpgrade({
    projectRoot: root,
    confirm: true,
    fetchImpl: async () => {
      throw new Error('offline')
    },
    execFileImpl: async () => {
      executed = true
      throw new Error('unexpected host command')
    },
  })
  assert.equal(result.status, 502)
  assert.equal(result.error.code, 'release_check_failed')
  assert.equal(executed, false)
})

test('explicit upgrade target remains available during lookup failure', async (t) => {
  const root = fixture(t)
  const result = await startHostUpgrade({
    projectRoot: root,
    version: 'v1.3.180',
    confirm: false,
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  assert.equal(result.status, 200)
  assert.equal(result.data.target, 'v1.3.180')
  assert.equal(result.data.started, false)
  assert.equal(result.data.source_error, 'offline')
})

test('fetch-unavailable error is preserved when a stale release enters the cache', async (t) => {
  const root = fixture(t)
  await buildUpdateStatus({ projectRoot: root, fetchImpl: goodFetch, now: () => 1000, cacheMs: 0 })
  const failed = await fetchLatestRelease({ fetchImpl: null, now: () => 2000, cacheMs: 0 })
  const cached = await fetchLatestRelease({ fetchImpl: goodFetch, now: () => 2001 })
  assert.equal(failed.error, 'fetch_unavailable')
  assert.equal(cached.error, 'fetch_unavailable')
  assert.equal(cached.cached, true)
})
