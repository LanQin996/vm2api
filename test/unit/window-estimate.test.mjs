import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateWindow, usedRatioOf } from '../../src/lib/admin/window-estimate.mjs'

const now = Date.parse('2026-10-14T12:00:00Z')
const base = {
  spentUsd: 12,
  tokens: 3_000_000,
  usedRatio: 0.4,
  reset: '2026-10-14T15:00:00Z',
  windowStart: '2026-10-14T10:00:00Z',
  coveredSince: '2026-10-01T00:00:00Z',
  unpricedRequests: 0,
  now,
}

test('window total is spend divided by used ratio, remaining is the rest', () => {
  const est = estimateWindow(base)
  assert.equal(est.status, 'ok')
  assert.equal(est.total_usd, 30)
  assert.equal(est.remaining_usd, 18)
  assert.equal(est.total_tokens, 7_500_000)
})

test('header 0-1 ratios and leftover 0-100 percents normalize to the same ratio', () => {
  assert.equal(usedRatioOf(0.4), 0.4)
  assert.equal(usedRatioOf(40), 0.4)
  assert.equal(usedRatioOf(null), null)
  assert.equal(usedRatioOf(''), null)
})

test('vendor rounding floor: 4.9% has no number, 5% does', () => {
  assert.equal(estimateWindow({ ...base, usedRatio: 0.049 }).status, 'low_usage')
  assert.equal(estimateWindow({ ...base, usedRatio: 0.049 }).total_usd, null)
  assert.equal(estimateWindow({ ...base, usedRatio: 0.05 }).status, 'ok')
  assert.equal(estimateWindow({ ...base, usedRatio: 0.05 }).total_usd, 240)
})

test('a full window has nothing left', () => {
  const est = estimateWindow({ ...base, usedRatio: 1 })
  assert.equal(est.status, 'ok')
  assert.equal(est.total_usd, 12)
  assert.equal(est.remaining_usd, 0)
})

test('missing reading, elapsed reset and short logs never produce a number', () => {
  assert.equal(estimateWindow({ ...base, usedRatio: null }).status, 'no_data')
  assert.equal(estimateWindow({ ...base, reset: null }).status, 'no_reset')
  assert.equal(estimateWindow({ ...base, reset: '2026-10-14T11:59:00Z' }).status, 'no_reset')
  assert.equal(estimateWindow({ ...base, coveredSince: '2026-10-14T11:00:00Z' }).status, 'log_gap')
  assert.equal(estimateWindow({ ...base, windowStart: null }).status, 'log_gap')
})

test('unpriced calls in the window understate spend, so no estimate', () => {
  const est = estimateWindow({ ...base, unpricedRequests: 2 })
  assert.equal(est.status, 'unpriced')
  assert.equal(est.total_usd, null)
  assert.equal(est.spent_usd, 12)
})

test('used% moved with no gateway spend means usage happened outside the logs', () => {
  assert.equal(estimateWindow({ ...base, spentUsd: 0 }).status, 'log_gap')
})
