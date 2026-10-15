import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeModelTraceConfig } from '../../src/lib/admin/modeltrace/config.mjs'
import {
  classifyAttribution,
  createModelTraceMonitor,
  modelTraceChallenges,
} from '../../src/lib/admin/modeltrace/monitor.mjs'

function bank(builtAt = '2026-10-09T06:24:27.469312+00:00') {
  const marginalCentroid = Array(355).fill(0)
  marginalCentroid[0] = 1
  const orderedCentroid = Array(74).fill(0)
  orderedCentroid[0] = 1
  return {
    schema: 'robust-number-fingerprint-bank',
    built_at: builtAt,
    models: [
      {
        id: 'gpt-5.4',
        display_name: 'gpt-5.4',
        family: 'gpt',
        family_name: 'GPT',
        counts: Array(355).fill(1),
      },
    ],
    robust: {
      hellinger: {
        feature_mean: Array(355).fill(0),
        feature_scale: Array(355).fill(1),
        nuisance_basis: [],
        centroids: [marginalCentroid],
      },
      ordered_blocks: {
        feature_mean: Array(74).fill(0),
        feature_scale: Array(74).fill(1),
        nuisance_basis: [],
        centroids: [orderedCentroid],
        environment_centroids: [[orderedCentroid]],
        weight: 0.25,
      },
    },
    calibration: {
      1: { beta: 1, cv_accuracy: 1 },
      2: { beta: 1, cv_accuracy: 1 },
      3: { beta: 1, cv_accuracy: 1 },
    },
  }
}

test('normalizes bounded ModelTrace settings and keeps automatic sampling off by default', () => {
  assert.equal(normalizeModelTraceConfig().enabled, false)
  assert.equal(normalizeModelTraceConfig({ interval_sec: 1, max_tokens: 90000 }).interval_sec, 3600)
  assert.equal(normalizeModelTraceConfig({ interval_sec: 1, max_tokens: 90000 }).max_tokens, 8192)
})

test('creates three calibrated-length number prompts', () => {
  const suite = modelTraceChallenges()
  assert.deepEqual(
    suite.map((item) => item.expected_count),
    [218, 233, 247],
  )
  assert.ok(suite.every((item) => item.prompt.includes('compact JSON array')))
})

test('requires confidence before reporting a requested-model mismatch', () => {
  assert.equal(classifyAttribution({ prediction: 'gpt-5.4', probability: 0.8 }, 'gpt-5.4'), 'match')
  assert.equal(classifyAttribution({ prediction: 'gpt-5.5', probability: 0.8 }, 'gpt-5.4'), 'mismatch')
  assert.equal(classifyAttribution({ prediction: 'gpt-5.5', probability: 0.4 }, 'gpt-5.4'), 'uncertain')
})

test('downloads and persists a valid bank, retaining it when a later update fails', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeltrace-'))
  let fail = false
  const monitor = createModelTraceMonitor({
    dataDir,
    fetchImpl: async () => {
      if (fail) throw new Error('offline')
      return { ok: true, json: async () => bank() }
    },
  })
  try {
    assert.deepEqual(await monitor.refreshBank({ force: true }), { ok: true, updated: true })
    assert.equal(monitor.getBankStatus().model_count, 1)
    assert.ok(fs.existsSync(path.join(dataDir, 'modeltrace', 'unified_bank.json')))
    fail = true
    const result = await monitor.refreshBank({ force: true })
    assert.equal(result.ok, true)
    assert.equal(result.error, 'offline')
    assert.equal(monitor.getBankStatus().built_at, '2026-10-09T06:24:27.469312+00:00')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('runs three GPT samples and writes a classified attribution snapshot', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeltrace-run-'))
  let calls = 0
  const monitor = createModelTraceMonitor({
    dataDir,
    config: { enabled: true, model: 'gpt-5.4' },
    fetchImpl: async () => ({ ok: true, json: async () => bank() }),
    listTargets: () => [{ id: 'vm-gpt-1', platform: 'openai', status: 'running', schedulable: true, has_token: true }],
    runChat: async (_vm, sample) => {
      const count = [218, 233, 247][calls]
      calls += 1
      return {
        ok: true,
        model: sample.model,
        text: JSON.stringify(Array.from({ length: count }, (_, i) => (i % 355) + 1)),
      }
    },
  })
  try {
    const accepted = monitor.startRun()
    assert.equal(accepted.started, true)
    assert.equal(accepted.snapshot.status, 'running')
    const snapshot = await monitor.runOnce()
    assert.equal(calls, 3)
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.status, 'match')
    assert.equal(snapshot.prediction, 'gpt-5.4')
    assert.equal(snapshot.used_outputs, 3)
    assert.equal(snapshot.candidate_only, true)
    const reopened = createModelTraceMonitor({ dataDir })
    assert.equal(reopened.getSnapshot().status, 'match')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
