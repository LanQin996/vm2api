import type { VmProxySnap } from '@/types/panel-vm'
import {
  proxyBindLimit,
  proxyBindable,
  proxyBoundIds,
  proxyIsLocal,
} from './proxy-sort'

/** 本地代理按所在机器出网，控制面测出的地理不代表节点槽，单独一档。 */
export const REGION_LOCAL = 'local'
/** 还没测地理（或测失败）的代理。 */
export const REGION_NONE = 'none'

/** 地区筛选：`country` 为空表示不限；`city` 为空表示整个国家。 */
export type ProxyRegionFilter = { country: string; city: string }

export const REGION_ANY: ProxyRegionFilter = { country: '', city: '' }

export function proxyRegion(prx: VmProxySnap): ProxyRegionFilter {
  if (proxyIsLocal(prx)) return { country: REGION_LOCAL, city: '' }
  const geo = prx.geo
  const country =
    (geo?.country_code || '').trim().toUpperCase() ||
    (geo?.country || '').trim()
  if (!country) return { country: REGION_NONE, city: '' }
  return { country, city: (geo?.city || '').trim() }
}

export function proxyInRegion(
  prx: VmProxySnap,
  filter: ProxyRegionFilter
): boolean {
  if (!filter.country) return true
  const r = proxyRegion(prx)
  if (r.country !== filter.country) return false
  return !filter.city || r.city === filter.city
}

let regionNames: Intl.DisplayNames | null | undefined

/** 国家代码转中文名；不是两位代码（网关只回了英文国名）就原样显示。 */
export function regionLabel(country: string): string {
  if (country === REGION_LOCAL) return '本地出口'
  if (country === REGION_NONE) return '未测地理'
  if (!/^[A-Z]{2}$/.test(country)) return country
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' })
    } catch {
      regionNames = null
    }
  }
  try {
    return regionNames?.of(country) || country
  } catch {
    return country
  }
}

/** 收起的地区栏里用的短名：国家代码原样，本地 / 未测用两个字，其余截前 3 个字符。 */
export function regionShort(country: string): string {
  if (country === REGION_LOCAL) return '本地'
  if (country === REGION_NONE) return '未测'
  if (/^[A-Z]{2}$/.test(country)) return country
  return country.slice(0, 3)
}

export type RegionTally = {
  /** 当前其它筛选（席位 / 健康 / 搜索）下命中的条数。 */
  count: number
  /** 命中项里可绑代理的空位合计。 */
  free: number
}

export type RegionCity = RegionTally & { city: string }

export type RegionGroup = RegionTally & {
  country: string
  label: string
  /** 池里该地区的总条数，不受筛选影响：分组不会因为打字而跳动消失。 */
  total: number
  /** 只有一个城市时为空 —— 再拆一层没有信息量。 */
  cities: RegionCity[]
}

function freeSeats(prx: VmProxySnap, poolLimit: number): number {
  if (!proxyBindable(prx)) return 0
  return Math.max(0, proxyBindLimit(prx, poolLimit) - proxyBoundIds(prx).length)
}

/**
 * 地区分面：本地出口第一，未测地理最后，其余按池内条数降序。
 * `matches` 是除地区之外的全部筛选，用来算每档「现在能看到几条、还剩几个空位」。
 */
export function regionGroups(
  list: VmProxySnap[],
  poolLimit: number,
  matches: (prx: VmProxySnap) => boolean
): RegionGroup[] {
  const groups = new Map<
    string,
    RegionGroup & { byCity: Map<string, RegionCity> }
  >()
  for (const prx of list) {
    const { country, city } = proxyRegion(prx)
    let g = groups.get(country)
    if (!g) {
      g = {
        country,
        label: regionLabel(country),
        total: 0,
        count: 0,
        free: 0,
        cities: [],
        byCity: new Map(),
      }
      groups.set(country, g)
    }
    g.total += 1
    let c = city ? g.byCity.get(city) : undefined
    if (city && !c) {
      c = { city, count: 0, free: 0 }
      g.byCity.set(city, c)
    }
    if (!matches(prx)) continue
    const free = freeSeats(prx, poolLimit)
    g.count += 1
    g.free += free
    if (c) {
      c.count += 1
      c.free += free
    }
  }
  const rank = (country: string) =>
    country === REGION_LOCAL ? 0 : country === REGION_NONE ? 2 : 1
  return [...groups.values()]
    .map(({ byCity, ...g }) => ({
      ...g,
      cities:
        byCity.size > 1
          ? [...byCity.values()].sort(
              (a, b) => b.count - a.count || a.city.localeCompare(b.city)
            )
          : [],
    }))
    .sort(
      (a, b) =>
        rank(a.country) - rank(b.country) ||
        b.total - a.total ||
        a.label.localeCompare(b.label, 'zh-CN')
    )
}
