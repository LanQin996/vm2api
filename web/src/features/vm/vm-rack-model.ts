import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { expiresAtToMs } from '@/lib/fable-status'
import { usedPctOf } from '@/lib/format'
import { windowProbed } from '@/lib/pool-quota'
import { claudeTier, fleetGroup, type FleetGroup } from '@/lib/vm-status'
import {
  vmTotalCost,
  vmTotalTokens,
  vmWindowCosts,
  vmWindowTokens,
} from '@/lib/vm-usage'
import { fableRow } from '@/features/vm/usage-meter'

/**
 * 竖柱下的重置标签只给一个单位（38m / 5h / 3d），完整倒计时放悬停提示。
 * 两个单位在三列竖柱下挤不下，且这里只需回答「快了没有」。
 */
export function resetShort(v: unknown, now: number): string | null {
  const t = expiresAtToMs(v)
  if (!t) return null
  const left = t - now
  if (left <= 0) return '到点'
  const min = Math.max(1, Math.round(left / 60_000))
  if (min < 60) return `${min}m`
  const h = Math.round(min / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/**
 * 状态分区。机架内按它分段，顶部构成条用它筛选。
 * `bad` 与 `revoke` 在这里合成一区：两者处理方式相同（重新授权），
 * 分开只会让运维多扫一段。
 */
export type VmZone = 'pool' | 'restricted' | 'off' | 'none' | 'dead'
export type VmZoneFilter = VmZone | 'all'

export type ZoneDef = {
  key: VmZone
  label: string
  hint: string
  /** StatusMark 的形状档。 */
  tone: 'ok' | 'warn' | 'off' | 'none' | 'bad'
  color: string
}

export const ZONES: readonly ZoneDef[] = [
  {
    key: 'pool',
    label: '在池',
    hint: '正在接单',
    tone: 'ok',
    color: 'var(--status-ok-solid)',
  },
  {
    key: 'restricted',
    label: '受限',
    hint: '冷却、熔断或窗口将满，自动出池',
    tone: 'warn',
    color: 'var(--status-warn-solid)',
  },
  {
    key: 'off',
    label: '关闭调用',
    hint: '人工关掉了调度',
    tone: 'off',
    color: 'var(--status-none)',
  },
  {
    key: 'none',
    label: '未使用',
    hint: '无凭证',
    tone: 'none',
    color: 'color-mix(in oklch, var(--status-none) 55%, transparent)',
  },
  {
    key: 'dead',
    label: '无效凭证',
    hint: '最近坏的在前',
    tone: 'bad',
    color: 'var(--status-bad-solid)',
  },
]

export function zoneOfGroup(group: FleetGroup): VmZone {
  return group === 'bad' || group === 'revoke' ? 'dead' : group
}

export function zoneOf(vm: Vm): VmZone {
  return zoneOfGroup(fleetGroup(vm))
}

export function zoneCounts(vms: Vm[]): Record<VmZone, number> {
  const c: Record<VmZone, number> = {
    pool: 0,
    restricted: 0,
    off: 0,
    none: 0,
    dead: 0,
  }
  for (const vm of vms) c[zoneOf(vm)] += 1
  return c
}

// ---------- 单台读数 ----------

export type WindowKey = '5h' | '7d' | 'fable'

export type WindowReadout = {
  key: WindowKey
  label: string
  /** null = 未探测；note 非空时也为 null（Fable 拒 / 满）。 */
  pct: number | null
  note: string | null
  /** Fable 没有独立计费，恒为 null。 */
  cost: number | null
  tokens: number | null
  reset: unknown
}

export type VmReadout = {
  windows: WindowReadout[]
  totalCost: number
  totalTokens: number
  /** 近 7d 费用占累计的百分比；累计为 0 时为 null。 */
  weekShare: number | null
}

export function vmReadout(vm: Vm, accounts?: UsageAccountRow[]): VmReadout {
  const costs = vmWindowCosts(vm, accounts)
  const tokens = vmWindowTokens(vm, accounts)
  const windows: WindowReadout[] = [
    {
      key: '5h',
      label: '5h',
      pct: windowProbed(vm, '5h') ? usedPctOf(vm, '5h') : null,
      note: null,
      cost: costs.h5,
      tokens: tokens.h5,
      reset: vm.reset_5h,
    },
    {
      key: '7d',
      label: '7d',
      pct: windowProbed(vm, '7d') ? usedPctOf(vm, '7d') : null,
      note: null,
      cost: costs.d7,
      tokens: tokens.d7,
      reset: vm.reset_7d,
    },
  ]
  if (claudeTier(vm).key === 'max') {
    const fable = fableRow(vm)
    windows.push({
      key: 'fable',
      label: 'Fable',
      pct: fable?.kind === 'bar' ? fable.pct : null,
      note: fable?.kind === 'note' ? fable.text : null,
      cost: null,
      tokens: null,
      reset: vm.reset_7d_oi,
    })
  }
  const totalCost = vmTotalCost(vm, accounts)
  return {
    windows,
    totalCost,
    totalTokens: vmTotalTokens(vm, accounts),
    weekShare:
      totalCost > 0 ? Math.min(100, (costs.d7 / totalCost) * 100) : null,
  }
}

/**
 * 刀片主体画什么：读数表，或一句说明加一步动作。
 * `unprobed` = 有凭证但 5h / 7d 都没有实测值——画 0% 会冒充「还很空」。
 */
export type BladeState = 'live' | 'dead' | 'vacant' | 'unprobed'

export function bladeState(vm: Vm): BladeState {
  const zone = zoneOf(vm)
  if (zone === 'dead') return 'dead'
  if (zone === 'none' || !vm.has_token) return 'vacant'
  if (!windowProbed(vm, '5h') && !windowProbed(vm, '7d')) return 'unprobed'
  return 'live'
}

// ---------- 机架 ----------

export type RackZone = { zone: ZoneDef; vms: Vm[] }

export type Rack = {
  /** 节点 id；本机为 null。 */
  nodeId: string | null
  label: string
  zones: RackZone[]
  /** 本机架内当前可见的槽位（已应用分区筛选）。 */
  vms: Vm[]
}

/**
 * 按节点分机架，机架内按分区分段。入参应已排好序（`sortVms`），
 * 段内保持原顺序。本机架排第一，其余按标签。空机架不返回。
 */
export function buildRacks(vms: Vm[], filter: VmZoneFilter = 'all'): Rack[] {
  const byNode = new Map<string | null, Vm[]>()
  for (const vm of vms) {
    if (filter !== 'all' && zoneOf(vm) !== filter) continue
    const id = vm.node_id || null
    const list = byNode.get(id)
    if (list) list.push(vm)
    else byNode.set(id, [vm])
  }
  const racks: Rack[] = []
  for (const [nodeId, list] of byNode) {
    racks.push({
      nodeId,
      label: nodeId
        ? list.find((vm) => vm.node_name)?.node_name || nodeId
        : '本机',
      zones: ZONES.map((zone) => ({
        zone,
        vms: list.filter((vm) => zoneOf(vm) === zone.key),
      })).filter((z) => z.vms.length),
      vms: list,
    })
  }
  return racks.sort((a, b) =>
    a.nodeId === null
      ? -1
      : b.nodeId === null
        ? 1
        : a.label.localeCompare(b.label)
  )
}

export type RackTotals = {
  groups: Record<FleetGroup, number>
  seatsUsed: number
  seatsMax: number
  h5Cost: number
  h5Tokens: number
  d7Cost: number
  d7Tokens: number
}

export function rackTotals(
  vms: Vm[],
  accounts?: UsageAccountRow[]
): RackTotals {
  const t: RackTotals = {
    groups: { pool: 0, restricted: 0, off: 0, none: 0, bad: 0, revoke: 0 },
    seatsUsed: 0,
    seatsMax: 0,
    h5Cost: 0,
    h5Tokens: 0,
    d7Cost: 0,
    d7Tokens: 0,
  }
  for (const vm of vms) {
    t.groups[fleetGroup(vm)] += 1
    if (vm.seats_max != null) {
      t.seatsUsed += Number(vm.seats_used) || 0
      t.seatsMax += Number(vm.seats_max) || 0
    }
    const c = vmWindowCosts(vm, accounts)
    const k = vmWindowTokens(vm, accounts)
    t.h5Cost += c.h5
    t.d7Cost += c.d7
    t.h5Tokens += k.h5
    t.d7Tokens += k.d7
  }
  return t
}
