import { describe, expect, it } from 'vitest'
import { settleInt, typingInt } from './int-input'

describe('deferred integer input', () => {
  it('does not clamp while typing', () => {
    expect(typingInt('1')).toBe(1)
    expect(typingInt('12')).toBe(12)
    expect(typingInt('')).toBeNull()
    expect(typingInt('abc')).toBeNull()
  })

  it('clamps when the field is left', () => {
    expect(settleInt('5', 30, 86400, 600)).toBe(30)
    expect(settleInt('120', 30, 86400, 600)).toBe(120)
    expect(settleInt('999999', 30, 86400, 600)).toBe(86400)
    expect(settleInt('', 30, 86400, 600)).toBe(600)
  })
})
