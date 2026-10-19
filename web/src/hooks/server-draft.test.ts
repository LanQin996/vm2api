import { describe, expect, it } from 'vitest'
import { resyncDraft } from './server-draft'

type D = { v: number }
const differs = (a: D, b: D) => a.v !== b.v

describe('resyncDraft', () => {
  it('takes server data on first load', () => {
    expect(resyncDraft(null, null, { v: 1 }, differs)).toEqual({ v: 1 })
  })

  it('follows the server when the block has no unsaved edits', () => {
    expect(resyncDraft({ v: 1 }, { v: 1 }, { v: 2 }, differs)).toEqual({
      v: 2,
    })
  })

  it('keeps unsaved edits when another block saves the shared config', () => {
    const draft = { v: 5 }
    expect(resyncDraft(draft, { v: 1 }, { v: 1 }, differs)).toBe(draft)
  })

  it('adopts the server copy once it matches the edits (own save)', () => {
    const next = { v: 5 }
    expect(resyncDraft({ v: 5 }, { v: 1 }, next, differs)).toBe(next)
  })
})
