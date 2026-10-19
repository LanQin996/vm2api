import { describe, expect, it } from 'vitest'
import { applyConsoleResults } from './console-results'

describe('applyConsoleResults', () => {
  const endpoints = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const hasKey = (row: number) => row !== 0

  it('binds batch items by backend row when an empty row was skipped', () => {
    const next = applyConsoleResults(
      endpoints,
      hasKey,
      { a: { ok: false, error: 'stale' } },
      {
        ok: true,
        items: [
          { row: 1, ok: true, status: 200, text: 'one' },
          { row: 2, ok: true, status: 200, text: 'two' },
        ],
      },
      null
    )
    expect(next.a).toBeUndefined()
    expect(next.b?.text).toBe('one')
    expect(next.c?.text).toBe('two')
  })

  it('maps a single-row test by row index', () => {
    const next = applyConsoleResults(
      endpoints,
      hasKey,
      {},
      { items: [{ row: 2, ok: false, status: 401, error: 'bad' }] },
      2
    )
    expect(next.c?.error).toBe('bad')
    expect(next.b).toBeUndefined()
  })
})
