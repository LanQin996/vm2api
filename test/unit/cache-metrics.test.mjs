import test from 'node:test'
import assert from 'node:assert/strict'
import { cacheHitStats } from '../../src/lib/admin/cache-metrics.mjs'

test('hit rate is read over uncached plus cache buckets', () => {
  const s = cacheHitStats({ input_tokens: 100, cache_read_tokens: 80, cache_creation_tokens: 10 })
  assert.equal(s.prompt_tokens, 190)
  assert.equal(s.cache_hit_rate, 80 / 190)
})

test('scheme is not a billing switch; prompt is always input+read+write', () => {
  const s = cacheHitStats({
    input_tokens: 20,
    cache_read_tokens: 80,
    cache_creation_tokens: 10,
  })
  assert.equal(s.prompt_tokens, 110)
  assert.equal(s.cache_hit_rate, 80 / 110)
})

test('mixed-provider aggregates keep an explicit prompt_tokens denominator', () => {
  const s = cacheHitStats({
    input_tokens: 105,
    cache_read_tokens: 190,
    cache_creation_tokens: 0,
    prompt_tokens: 200,
  })
  assert.equal(s.prompt_tokens, 200)
  assert.equal(s.cache_hit_rate, 190 / 200)
})
