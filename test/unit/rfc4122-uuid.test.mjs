import test from 'node:test'
import assert from 'node:assert/strict'
import { RFC4122_UUID_RE, coerceRfc4122Uuid, isRfc4122Uuid } from '../../src/lib/identity/rfc4122-uuid.mjs'

test('isRfc4122Uuid rejects empty, dash, and garbage', () => {
  assert.equal(isRfc4122Uuid(''), false)
  assert.equal(isRfc4122Uuid('-'), false)
  assert.equal(isRfc4122Uuid('not-a-uuid'), false)
  assert.equal(isRfc4122Uuid('11111111-2222-3333-4444-555555555555'), true)
})

test('coerceRfc4122Uuid keeps valid values and repairs invalid', () => {
  const good = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
  assert.equal(coerceRfc4122Uuid(good), good.toLowerCase())
  for (const bad of ['', '-', 'x', '11111111-2222-3333-4444']) {
    const out = coerceRfc4122Uuid(bad)
    assert.match(out, RFC4122_UUID_RE)
    assert.notEqual(out, '-')
  }
})
