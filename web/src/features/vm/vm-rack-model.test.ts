import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  bladeState,
  buildRacks,
  rackTotals,
  resetShort,
  vmReadout,
  zoneCounts,
} from './vm-rack-model'

function vm(over: Partial<Vm> = {}): Vm {
  return {
    id: 'vm-01',
    has_token: true,
    has_refresh: true,
    schedulable: true,
    schedule_state: 'on',
    availability: { key: 'ok', usable: true, text: '可用' },
    utilization_5h: 0.2,
    utilization_7d: 0.4,
    ...over,
  }
}

const bad = (over: Partial<Vm> = {}) =>
  vm({
    availability: {
      key: 'bad',
      usable: false,
      text: '无效凭证',
      reason: 'credential_refresh_failed',
    },
    refresh_error: 'invalid_grant',
    ...over,
  })

const revoked = (over: Partial<Vm> = {}) =>
  vm({
    schedulable: false,
    schedule_disabled_reason: 'oauth_revoked',
    refresh_error: 'oauth_revoked',
    availability: {
      key: 'off',
      usable: false,
      text: '调度关',
      reason: 'oauth_revoked',
    },
    ...over,
  })

const off = (over: Partial<Vm> = {}) =>
  vm({
    schedulable: false,
    schedule_state: 'off',
    schedule_manual: true,
    availability: {
      key: 'off',
      usable: false,
      text: '调度关',
      reason: 'disabled',
    },
    ...over,
  })

describe('zones', () => {
  it('folds 无效凭证 and 已吊销 into one zone', () => {
    expect(
      zoneCounts([
        vm(),
        bad({ id: 'b' }),
        revoked({ id: 'r' }),
        off({ id: 'o' }),
      ])
    ).toEqual({
      pool: 1,
      restricted: 0,
      off: 1,
      none: 0,
      dead: 2,
    })
  })
})

describe('buildRacks', () => {
  const rows = [
    vm({ id: 'a', node_id: 'n-2', node_name: 'netcup-02' }),
    vm({ id: 'b' }),
    bad({ id: 'c', node_id: 'n-2', node_name: 'netcup-02' }),
    vm({ id: 'd', node_id: 'n-1' }),
    off({ id: 'e' }),
  ]

  it('puts the control plane first, then nodes by label, falling back to node_id', () => {
    expect(buildRacks(rows).map((r) => [r.nodeId, r.label])).toEqual([
      [null, '本机'],
      ['n-1', 'n-1'],
      ['n-2', 'netcup-02'],
    ])
  })

  it('segments each rack by zone in fixed order and keeps the input order inside a zone', () => {
    const local = buildRacks([
      off({ id: 'e' }),
      vm({ id: 'b2' }),
      vm({ id: 'b1' }),
    ])[0]
    expect(
      local.zones.map((z) => [z.zone.key, z.vms.map((v) => v.id)])
    ).toEqual([
      ['pool', ['b2', 'b1']],
      ['off', ['e']],
    ])
  })

  it('drops racks with nothing left after a zone filter', () => {
    const dead = buildRacks(rows, 'dead')
    expect(dead.map((r) => r.nodeId)).toEqual(['n-2'])
    expect(dead[0].vms.map((v) => v.id)).toEqual(['c'])
  })
})

describe('rackTotals', () => {
  it('sums only the slots it is given and skips seatless (GPT) slots', () => {
    const t = rackTotals([
      vm({
        id: 'a',
        seats_used: 2,
        seats_max: 4,
        window_5h_cost: 1.5,
        window_5h_tokens: 100,
        window_7d_cost: 10,
        window_7d_tokens: 900,
      }),
      vm({
        id: 'b',
        platform: 'openai',
        seats_max: null,
        seats_used: 5,
        window_7d_cost: 2,
      }),
    ])
    expect(t).toMatchObject({
      seatsUsed: 2,
      seatsMax: 4,
      h5Cost: 1.5,
      h5Tokens: 100,
      d7Cost: 12,
      d7Tokens: 900,
    })
    expect(t.groups.pool).toBe(2)
  })

  it('prefers the usage account row over the slot snapshot', () => {
    const row = vm({ id: 'a', account_uuid: 'u-1', window_5h_tokens: 5 })
    const t = rackTotals(
      [row],
      [{ account_id: 'u-1', vm_id: 'a', window_5h_tokens: 70 }]
    )
    expect(t.h5Tokens).toBe(70)
  })
})

describe('vmReadout', () => {
  it('gives Fable a column only on Max, without cost or tokens', () => {
    const max = vmReadout(
      vm({
        usage_has_fable: true,
        utilization_7d_oi: 0.3,
        reset_7d_oi: '2099-01-01T00:00:00Z',
      })
    )
    expect(max.windows.map((w) => w.key)).toEqual(['5h', '7d', 'fable'])
    expect(max.windows[2]).toMatchObject({ cost: null, tokens: null })
    expect(
      vmReadout(vm({ usage_has_fable: false })).windows.map((w) => w.key)
    ).toEqual(['5h', '7d'])
  })

  it('reports an unprobed window as null, not 0%', () => {
    const r = vmReadout(vm({ utilization_5h: undefined }))
    expect(r.windows[0].pct).toBeNull()
    expect(r.windows[1].pct).toBe(40)
  })

  it('computes the 7d share of lifetime spend, null when nothing was spent', () => {
    expect(
      vmReadout(vm({ total_cost: 200, window_7d_cost: 50, total_tokens: 9 }))
        .weekShare
    ).toBe(25)
    expect(
      vmReadout(vm({ total_cost: 200, window_7d_cost: 50 })).totalTokens
    ).toBe(0)
    expect(
      vmReadout(vm({ total_cost: 0, window_7d_cost: 0 })).weekShare
    ).toBeNull()
  })
})

describe('bladeState', () => {
  it('separates dead, vacant, unprobed and live slots', () => {
    expect(bladeState(bad())).toBe('dead')
    expect(bladeState(revoked())).toBe('dead')
    expect(bladeState(vm({ has_token: false, availability: undefined }))).toBe(
      'vacant'
    )
    expect(
      bladeState(vm({ utilization_5h: undefined, utilization_7d: undefined }))
    ).toBe('unprobed')
    expect(bladeState(vm({ utilization_5h: undefined }))).toBe('live')
  })
})

describe('resetShort', () => {
  const now = Date.parse('2026-10-14T00:00:00Z')
  const at = (min: number) => new Date(now + min * 60_000).toISOString()
  it('keeps one unit and switches to days only past 48h', () => {
    expect(resetShort(at(38), now)).toBe('38m')
    expect(resetShort(at(5 * 60 + 10), now)).toBe('5h')
    expect(resetShort(at(47 * 60), now)).toBe('47h')
    expect(resetShort(at(70 * 60), now)).toBe('3d')
  })
  it('distinguishes a passed reset from a missing one', () => {
    expect(resetShort(at(-1), now)).toBe('到点')
    expect(resetShort(null, now)).toBeNull()
  })
})
