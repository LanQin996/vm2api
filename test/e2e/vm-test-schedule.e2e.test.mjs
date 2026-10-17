/**
 * E2E: panel VM test schedule CRUD, validation, and SQLite persistence.
 * The saved plan is disabled so this test never invokes a model.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'

test('panel VM test schedule validates structured fields, persists, syncs, and deletes', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-test-schedule-e2e-'))
  let gw = await startGateway({ project })
  const endpoint = '/api/panel/vms/vm-sim-01/test-schedule'
  const plan = {
    enabled: false,
    frequency: 'daily',
    time: '09:00',
    timezone: 'UTC',
    model: 'claude-haiku-4-5-20251001',
    prompt: 'scheduled test e2e prompt',
    max_tokens: 64,
    reasoning_effort: null,
  }

  try {
    const initial = await api(gw, 'GET', endpoint)
    assert.equal(initial.status, 200, initial.text)
    assert.equal(initial.json.data.schedule, null)

    const saved = await api(gw, 'PUT', endpoint, { body: plan })
    assert.equal(saved.status, 200, saved.text)
    assert.equal(saved.json.data.schedule.frequency, 'daily')
    assert.equal(saved.json.data.schedule.time, '09:00')
    assert.equal(saved.json.data.schedule.timezone, 'UTC')
    assert.equal(saved.json.data.schedule.prompt, plan.prompt)
    assert.equal(saved.json.data.schedule.cron, undefined)
    assert.equal(saved.json.data.schedule.next_run_at, null)
    assert.equal(saved.json.data.schedule.running, false)

    const invalid = await api(gw, 'PUT', endpoint, {
      body: { ...plan, time: '25:99' },
    })
    assert.equal(invalid.status, 400, invalid.text)
    assert.equal(invalid.json.error.code, 'invalid_test_schedule')

    const defaultSaved = await api(gw, 'PUT', '/api/panel/test-schedule/default', {
      body: {
        schedule: { frequency: 'hourly', minute: 5, timezone: 'Asia/Shanghai' },
      },
    })
    assert.equal(defaultSaved.status, 200, defaultSaved.text)
    assert.equal(defaultSaved.json.data.schedule.minute, 5)

    const synced = await api(gw, 'POST', '/api/panel/test-schedule/sync', {
      body: {
        scope: 'ids',
        vm_ids: ['vm-sim-01'],
        schedule: { frequency: 'hourly', minute: 10, timezone: 'UTC' },
      },
    })
    assert.equal(synced.status, 200, synced.text)
    assert.deepEqual(synced.json.data.updated, ['vm-sim-01'])

    const afterSync = await api(gw, 'GET', endpoint)
    assert.equal(afterSync.json.data.schedule.frequency, 'hourly')
    assert.equal(afterSync.json.data.schedule.minute, 10)
    assert.equal(afterSync.json.data.schedule.prompt, plan.prompt)
    assert.equal(afterSync.json.data.schedule.enabled, false)
  } finally {
    await gw.stop()
  }

  gw = await startGateway({ project })
  try {
    const restored = await api(gw, 'GET', endpoint)
    assert.equal(restored.status, 200, restored.text)
    assert.equal(restored.json.data.schedule.frequency, 'hourly')
    assert.equal(restored.json.data.schedule.minute, 10)

    const removed = await api(gw, 'DELETE', endpoint)
    assert.equal(removed.status, 200, removed.text)
    assert.equal(removed.json.data.schedule, null)

    const afterDelete = await api(gw, 'GET', endpoint)
    assert.equal(afterDelete.status, 200, afterDelete.text)
    assert.equal(afterDelete.json.data.schedule, null)
  } finally {
    await gw.stop()
  }
})
