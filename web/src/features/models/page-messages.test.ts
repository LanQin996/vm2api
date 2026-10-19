import { describe, expect, it } from 'vitest'
import {
  modelsDevSyncOutcome,
  resetConfirmText,
  syncConfirmText,
} from './page-messages'

describe('models page confirmations', () => {
  it('asks before a sync would drop unsaved edits', () => {
    expect(syncConfirmText(false, ' Worker ')).toBeNull()
    expect(syncConfirmText(true, ' GPT ')).toContain('未保存')
  })

  it('always confirms a reset to defaults', () => {
    expect(resetConfirmText(false)).toContain('恢复官方默认')
    expect(resetConfirmText(true)).toContain('未保存')
  })
})

describe('models.dev sync outcome', () => {
  it('does not report success when the gateway says the sync failed', () => {
    const out = modelsDevSyncOutcome({
      models_dev: { status: 'error', error: 'models.dev HTTP 503' },
    })
    expect(out.ok).toBe(false)
    expect(out.text).toContain('models.dev HTTP 503')
  })

  it('reports success with the model count', () => {
    expect(
      modelsDevSyncOutcome({ models_dev: { status: 'ok', models: 42 } })
    ).toEqual({ ok: true, text: '已同步 models.dev（42 个模型）' })
  })
})
