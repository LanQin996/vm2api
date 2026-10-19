import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { bootOutcome, vmTodayCounts } from './detail-today'

function vm(fields: Partial<Vm>): Vm {
  return { id: 'vm-1', ...fields } as Vm
}

describe('vmTodayCounts', () => {
  it('reads today_* and never the cumulative or 5h counters', () => {
    const subject = vm({
      today_requests: 12,
      today_input_tokens: 300,
      today_output_tokens: 40,
      requests: 9999,
      tokens_in: 88888,
      tokens_out: 7777,
      window_5h_requests: 500,
    } as Partial<Vm>)
    expect(vmTodayCounts(subject)).toEqual({
      requests: 12,
      input: 300,
      output: 40,
    })
  })

  it('takes output from billing.today when the slot omits it', () => {
    const subject = vm({ today_requests: 3, today_input_tokens: 100 })
    const billing = {
      today: { requests: 3, input_tokens: 100, output_tokens: 25 },
    }
    expect(vmTodayCounts(subject, billing)).toEqual({
      requests: 3,
      input: 100,
      output: 25,
    })
  })

  it('derives output from today_tokens as the last resort', () => {
    const subject = vm({
      today_requests: 2,
      today_input_tokens: 100,
      today_cache_read_tokens: 1000,
      today_cache_creation_tokens: 200,
      today_tokens: 1350,
    })
    expect(vmTodayCounts(subject).output).toBe(50)
  })

  it('a fresh slot shows zeros, not 5h requests', () => {
    const subject = vm({ window_5h_requests: 8 } as Partial<Vm>)
    expect(vmTodayCounts(subject)).toEqual({
      requests: 0,
      input: 0,
      output: 0,
    })
  })
})

describe('bootOutcome', () => {
  it('warns when the container started but the kernel did not', () => {
    const out = bootOutcome({
      vm: { schedulable: true },
      boot: { ok: true, rust_ok: false, rust: { error: 'health timeout' } },
    })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('内核未就绪')
    expect(out.message).toContain('health timeout')
  })

  it('reports success and whether scheduling came back on', () => {
    expect(
      bootOutcome({ vm: { schedulable: true }, boot: { rust_ok: true } })
    ).toEqual({ ok: true, message: '已开机，调度已开启' })
    expect(
      bootOutcome({ vm: { schedulable: false }, boot: { rust_ok: true } })
    ).toEqual({ ok: true, message: '已开机' })
  })

  it('treats a skipped kernel (rust_ok missing) as success', () => {
    expect(bootOutcome({}).ok).toBe(true)
    expect(bootOutcome(undefined).ok).toBe(true)
  })
})
