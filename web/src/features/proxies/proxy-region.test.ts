import type { VmProxySnap } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  REGION_ANY,
  REGION_LOCAL,
  REGION_NONE,
  proxyInRegion,
  proxyRegion,
  regionGroups,
} from './proxy-region'

const socks = (
  id: string,
  geo: VmProxySnap['geo'],
  extra: Partial<VmProxySnap> = {}
): VmProxySnap => ({
  id,
  host: `10.0.0.${id.length}`,
  port: 1080,
  enabled: true,
  status: 'ok',
  bind_limit: 2,
  bound_vm_ids: [],
  geo,
  ...extra,
})

const local: VmProxySnap = {
  id: 'px-local',
  kind: 'local',
  scheme: 'local',
  enabled: true,
  status: 'ok',
  bind_limit: 20,
  // 控制面的地理不能把本地代理归到某个国家：节点槽从各自机器出网。
  geo: { country: 'Germany', country_code: 'DE', city: 'Nuremberg' },
}

describe('proxyRegion', () => {
  it('buckets the local proxy apart from its control-plane geo', () => {
    expect(proxyRegion(local)).toEqual({ country: REGION_LOCAL, city: '' })
    expect(proxyInRegion(local, { country: 'DE', city: '' })).toBe(false)
  })

  it('normalises the country code and falls back to the country name', () => {
    expect(
      proxyRegion(socks('a', { country_code: 'jp', city: 'Tokyo' }))
    ).toEqual({ country: 'JP', city: 'Tokyo' })
    expect(proxyRegion(socks('b', { country: 'Japan' })).country).toBe('Japan')
    expect(proxyRegion(socks('c', null)).country).toBe(REGION_NONE)
  })

  it('matches a whole country or a single city', () => {
    const tokyo = socks('a', { country_code: 'JP', city: 'Tokyo' })
    expect(proxyInRegion(tokyo, REGION_ANY)).toBe(true)
    expect(proxyInRegion(tokyo, { country: 'JP', city: '' })).toBe(true)
    expect(proxyInRegion(tokyo, { country: 'JP', city: 'Tokyo' })).toBe(true)
    expect(proxyInRegion(tokyo, { country: 'JP', city: 'Osaka' })).toBe(false)
  })
})

describe('regionGroups', () => {
  const list = [
    socks('tk1', { country_code: 'JP', city: 'Tokyo' }),
    socks(
      'tk2',
      { country_code: 'JP', city: 'Tokyo' },
      { bound_vm_ids: ['vm-1', 'vm-2'] }
    ),
    socks('os1', { country_code: 'JP', city: 'Osaka' }, { status: 'dead' }),
    socks('la1', { country_code: 'US', city: 'Los Angeles' }),
    socks('nogeo', null),
    local,
  ]

  it('pins local first, untested last, the rest by pool size', () => {
    const groups = regionGroups(list, 2, () => true)
    expect(groups.map((g) => g.country)).toEqual([
      REGION_LOCAL,
      'JP',
      'US',
      REGION_NONE,
    ])
  })

  it('counts only free seats on bindable proxies', () => {
    const jp = regionGroups(list, 2, () => true).find((g) => g.country === 'JP')
    // tk1 空 2，tk2 已满，os1 dead 不算空位。
    expect(jp).toMatchObject({ total: 3, count: 3, free: 2 })
    expect(jp?.cities.map((c) => [c.city, c.count, c.free])).toEqual([
      ['Tokyo', 2, 2],
      ['Osaka', 1, 0],
    ])
  })

  it('keeps groups whose proxies are all filtered out, with zero counts', () => {
    const groups = regionGroups(list, 2, (p) => p.id === 'la1')
    const jp = groups.find((g) => g.country === 'JP')
    expect(jp).toMatchObject({ total: 3, count: 0, free: 0 })
    expect(groups.find((g) => g.country === 'US')).toMatchObject({
      count: 1,
      free: 2,
    })
  })

  it('omits the city level when a country has a single city', () => {
    const us = regionGroups(list, 2, () => true).find((g) => g.country === 'US')
    expect(us?.cities).toEqual([])
  })
})
