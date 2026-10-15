import type { VmProxySnap } from '@/types/panel-vm'
import { type LocalProxyLabelOpts, proxyHostLabel } from '@/lib/vm-status'

export type ProxySortKey = 'status' | 'latency' | 'seats' | 'geo' | 'host'

/** 代理自身的健康档。顺序即「可用性降序」，状态排序直接用它的下标。 */
export const PROXY_HEALTH_KEYS = [
  'ok',
  'unknown',
  'fail',
  'dead',
  'off',
] as const
export type ProxyHealthKey = (typeof PROXY_HEALTH_KEYS)[number]

export function proxyHealthKey(prx: VmProxySnap): ProxyHealthKey {
  if (prx.blocked_reason) return 'off'
  if (prx.enabled === false) return 'off'
  if (prx.status === 'dead') return 'dead'
  if (prx.status === 'fail') return 'fail'
  if (prx.status === 'ok') return 'ok'
  return 'unknown'
}

export function proxyIsLocal(prx: VmProxySnap): boolean {
  return (
    prx.kind === 'local' ||
    prx.scheme === 'local' ||
    prx.id === 'px-local' ||
    String(prx.id || '').startsWith('px-local-')
  )
}

/** 控制面自己的那条本地代理（`px-local`）。节点那几条跟着它自动建。 */
export function proxyIsControlLocal(prx: VmProxySnap): boolean {
  return proxyIsLocal(prx) && !proxyLocalNodeId(prx)
}

/** 本地代理每台 VPS 一条：控制面 `px-local`，集群节点 `px-local-<节点>`。 */
export function proxyLocalNodeId(prx: VmProxySnap): string | null {
  return prx.node_id || null
}

/** 本地代理 = 槽位所在那台机器自己的公网出口。 */
export const LOCAL_PROXY_HINT = '本地代理'

/** 本地代理的出口与探测都在它自己那台 VPS 上。 */
export function localProxyExitText(prx: VmProxySnap): string {
  return proxyLocalNodeId(prx) ? '出口为该节点本机' : '控制面本机出口'
}

export function localProxyProbeText(prx: VmProxySnap): string {
  return proxyLocalNodeId(prx) ? '经节点本机探测' : '控制面本机探测'
}

/** 本地代理固定排第一，其余保持原相对顺序。 */
function localFirst(a: VmProxySnap, b: VmProxySnap): number {
  return (proxyIsLocal(b) ? 1 : 0) - (proxyIsLocal(a) ? 1 : 0)
}

export function proxyHostText(
  prx: VmProxySnap,
  opts?: LocalProxyLabelOpts | string | null
): string {
  if (proxyIsLocal(prx)) return proxyHostLabel(prx, opts)
  if (!prx.host) return `?:${prx.port ?? '?'}`
  const endpoint = proxyHostLabel(prx)
  return prx.port == null ? `${endpoint}:?` : endpoint
}

/** 带代理名称的地址：`名称 · host:port`；没名称就退回纯地址。 */
export function proxyLabel(
  prx: VmProxySnap,
  opts?: LocalProxyLabelOpts | string | null
): string {
  const host = proxyHostText(prx, opts)
  if (proxyIsLocal(prx)) return host
  const name = prx.label?.trim()
  return name ? `${name} · ${host}` : host
}

/**
 * 网关 `bind()` 只拒绝「已禁用或 dead」；`fail` 仍可绑（连续失败未到阈值），
 * 所以这里不能直接用 `proxyIsInvalid()`。
 */
export function proxyBindable(prx: VmProxySnap): boolean {
  return !prx.blocked_reason && prx.enabled !== false && prx.status !== 'dead'
}

export function proxyBoundIds(prx: VmProxySnap | undefined): string[] {
  if (!prx) return []
  if (Array.isArray(prx.bound_vm_ids) && prx.bound_vm_ids.length) {
    return prx.bound_vm_ids.filter(Boolean)
  }
  return prx.bound_vm_id ? [prx.bound_vm_id] : []
}

export function proxyBindLimit(
  prx: VmProxySnap | undefined,
  fallback: number
): number {
  const n = Number(prx?.bind_limit || fallback || 5)
  return Number.isFinite(n) && n > 0 ? n : 5
}

export function proxyIsInvalid(prx: VmProxySnap | undefined): boolean {
  if (!prx) return true
  return (
    !!prx.blocked_reason ||
    prx.enabled === false ||
    prx.status === 'dead' ||
    prx.status === 'fail'
  )
}

export function proxyStatusLabel(prx: VmProxySnap): string {
  if (prx.blocked_reason === 'ipv6_disabled') return 'IPv6 已关闭'
  if (prx.enabled === false || prx.status === 'dead') return '失效'
  if (prx.status === 'fail') return '失败'
  if (prx.status === 'ok') return '正常'
  return '未测'
}

/**
 * 代理下拉的一行文案：`host:port · 状态 延迟 · n/limit`。
 *
 * 字段与顺序对齐 index.html:7617 proxyOptionLabel()，延迟缺失时显示 `—`。
 * 只拼 host/port —— 账密永不出现在任何渲染路径上（见 api-contract.md）。
 */
export function proxyOptionLabel(
  prx: VmProxySnap,
  poolBindLimit: number,
  opts?: LocalProxyLabelOpts | string | null
): string {
  const used = proxyBoundIds(prx).length
  const limit = proxyBindLimit(prx, poolBindLimit)
  if (proxyIsLocal(prx)) {
    const nodeExit =
      !!proxyLocalNodeId(prx) ||
      (!!opts &&
        typeof opts === 'object' &&
        opts.revealNode &&
        !!(opts.nodeName || opts.nodeId))
    const exit = nodeExit ? '出口为该节点本机' : LOCAL_PROXY_HINT
    return `${proxyLabel(prx, opts)} · ${exit} · ${used}/${limit}`
  }
  const lat = prx.latency_ms != null ? `${prx.latency_ms}ms` : '—'
  return `${proxyLabel(prx, opts)} · ${proxyStatusLabel(prx)} ${lat} · ${used}/${limit}`
}

/**
 * 这条代理对 `vmId` 还剩几个绑定位。已绑到本槽的算「改选回自己」，不占位。
 * 对齐 index.html:7653 proxyRemaining()。
 */
export function proxyRemaining(
  prx: VmProxySnap,
  vmId: string,
  poolBindLimit: number
): number {
  const ids = proxyBoundIds(prx)
  const here = !!vmId && ids.includes(vmId)
  return Math.max(
    0,
    proxyBindLimit(prx, poolBindLimit) - ids.length + (here ? 1 : 0)
  )
}

/**
 * 「能不能马上用」的排序，专给导入流程的代理下拉：
 * 本地代理固定第一 → 健康优先 → 有余位优先 → 余位多的在前 → 延迟低的在前 → host:port。
 *
 * 与 `sortedProxies()`（代理页的用户可切列排序）是两个用途，不要混用。
 * 对齐 index.html:7659 sortedProxiesByAvailability()。
 */
export function sortedProxiesByAvailability(
  list: VmProxySnap[],
  vmId: string,
  poolBindLimit: number
): VmProxySnap[] {
  return list.slice().sort((a, b) => {
    const pinned = localFirst(a, b)
    if (pinned) return pinned
    const ia = proxyIsInvalid(a) ? 1 : 0
    const ib = proxyIsInvalid(b) ? 1 : 0
    if (ia !== ib) return ia - ib
    const ra = proxyRemaining(a, vmId, poolBindLimit)
    const rb = proxyRemaining(b, vmId, poolBindLimit)
    const fa = ra <= 0 ? 1 : 0
    const fb = rb <= 0 ? 1 : 0
    if (fa !== fb) return fa - fb
    if (rb !== ra) return rb - ra
    const la = Number(a.latency_ms ?? 1e9)
    const lb = Number(b.latency_ms ?? 1e9)
    if (la !== lb) return la - lb
    return cmp(
      `${a.host || ''}:${a.port || ''}`,
      `${b.host || ''}:${b.port || ''}`,
      'asc'
    )
  })
}

/**
 * 单槽代理 tab 的出口下拉。
 * 已绑到本槽的留在列表里：正在用本地代理时，SOCKS5 下拉也要看得到它。
 * 绑满且不属于本槽的不列。本地代理仍固定第一。
 */
export function proxiesForVmBind(
  list: VmProxySnap[],
  vmId: string,
  poolBindLimit = 5,
  /** 槽位所在节点（控制面为 null）；给出时只列它自己那台 VPS 的本地代理。 */
  vmNodeId?: string | null
): VmProxySnap[] {
  const open = list.filter((p) => {
    if (!p.id || !p.enabled || p.status === 'dead' || p.blocked_reason) {
      return false
    }
    if (!localProxyFitsNode(p, vmNodeId)) return false
    return proxyRemaining(p, vmId, poolBindLimit) > 0
  })
  return sortedProxiesByAvailability(open, vmId, poolBindLimit)
}

/**
 * 本地代理只能绑到它所在 VPS 上的槽位。`vmNodeId` 未给出（undefined）时不过滤；
 * 网关仍会把通用 px-local 落到槽位自己的节点上，绑错机器会被拒。
 */
export function localProxyFitsNode(
  prx: VmProxySnap,
  vmNodeId: string | null | undefined
): boolean {
  if (vmNodeId === undefined || !proxyIsLocal(prx)) return true
  return proxyLocalNodeId(prx) === (vmNodeId || null)
}

function cmp(
  a: string | number,
  b: string | number,
  dir: 'asc' | 'desc'
): number {
  if (a < b) return dir === 'asc' ? -1 : 1
  if (a > b) return dir === 'asc' ? 1 : -1
  return 0
}

/** 各列的「自然方向」：换列时落到最有用的那一端，而不是统一 asc/desc。 */
export const PROXY_SORT_DEFAULT_DIR: Record<ProxySortKey, 'asc' | 'desc'> = {
  status: 'asc',
  latency: 'asc',
  seats: 'desc',
  geo: 'asc',
  host: 'asc',
}

export function sortedProxies(
  list: VmProxySnap[],
  key: ProxySortKey,
  dir: 'asc' | 'desc'
): VmProxySnap[] {
  const rows = list.slice()
  rows.sort((a, b) => {
    const pinned = localFirst(a, b)
    if (pinned) return pinned
    const ia = proxyIsInvalid(a) ? 1 : 0
    const ib = proxyIsInvalid(b) ? 1 : 0
    if (ia !== ib) return ia - ib
    const byHost = cmp(proxyHostText(a), proxyHostText(b), 'asc')
    // 没测过延迟的无论方向都沉底：它们是「待测」，不是「最快」或「最慢」。
    const byLatency = (d: 'asc' | 'desc') => {
      const la = a.latency_ms
      const lb = b.latency_ms
      if (la == null || lb == null) {
        return (la == null ? 1 : 0) - (lb == null ? 1 : 0)
      }
      return cmp(la, lb, d)
    }
    if (key === 'host') return cmp(proxyHostText(a), proxyHostText(b), dir)
    if (key === 'status') {
      const ra = PROXY_HEALTH_KEYS.indexOf(proxyHealthKey(a))
      const rb = PROXY_HEALTH_KEYS.indexOf(proxyHealthKey(b))
      // 同档内快的在前：「状态」排序要回答的是「哪条最能用」。
      return cmp(ra, rb, dir) || byLatency('asc') || byHost
    }
    if (key === 'latency') return byLatency(dir) || byHost
    if (key === 'seats') {
      const sa = proxyBoundIds(a).length
      const sb = proxyBoundIds(b).length
      return cmp(sa, sb, dir) || byHost
    }
    // 未检测的排在最后：它们是「待办」，不是某个国家。
    const ga = a.geo?.country_code || a.geo?.country || '\uffff'
    const gb = b.geo?.country_code || b.geo?.country || '\uffff'
    return cmp(ga, gb, dir) || byHost
  })
  return rows
}

export const PROXY_HEALTH_LABEL: Record<ProxyHealthKey, string> = {
  ok: '正常',
  unknown: '未测',
  fail: '失败',
  dead: '失效',
  off: '已禁用',
}

/** 列表筛选：健康档 + 两个席位档。左侧席位图图例与右侧工具条共用这一套。 */
export type ProxyFilter = 'all' | ProxyHealthKey | 'open' | 'full'

export function proxyInFilter(
  prx: VmProxySnap,
  filter: ProxyFilter,
  poolBindLimit: number
): boolean {
  if (filter === 'all') return true
  const used = proxyBoundIds(prx).length
  const limit = proxyBindLimit(prx, poolBindLimit)
  if (filter === 'open') return proxyBindable(prx) && used < limit
  if (filter === 'full') return used >= limit
  return proxyHealthKey(prx) === filter
}

/**
 * 搜索命中：地址、代理名称、绑定槽位名、出口地理。账密不在列表响应里，天然搜不到。
 * `query` 需已 trim + 小写。
 */
export function proxyMatchesQuery(
  prx: VmProxySnap,
  query: string,
  vmName: (id: string) => string
): boolean {
  if (!query) return true
  const hay = [
    proxyHostText(prx),
    prx.label,
    ...proxyBoundIds(prx).flatMap((id) => [id, vmName(id)]),
    prx.node_name,
    prx.node_id,
    proxyIsLocal(prx) ? proxyHostText(prx) : null,
    prx.geo?.country,
    prx.geo?.country_code,
    prx.geo?.city,
    prx.geo?.region,
    prx.geo?.timezone,
    prx.geo?.ip,
    prx.geo?.isp,
  ]
  return hay.some((s) => !!s && s.toLowerCase().includes(query))
}

export function readPositive(
  rec: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  const n = Number(rec[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}
