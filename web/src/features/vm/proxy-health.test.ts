import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { proxyHealthOf } from './proxy-health'

const proxy: VmProxySnap = {}

describe('proxyHealthOf for Codex slots', () => {
  it('does not report a missing SOCKS proxy as fail-closed', () => {
    const vm: Vm = {
      id: 'vm-gpt',
      platform: 'openai',
      family: 'codex',
      has_token: true,
    }

    const health = proxyHealthOf(vm, proxy)

    expect(health.tone.text).toBe('IPv6 待启动')
    expect(health.tone.cls).toBe('caution')
    expect(health.score).toBeGreaterThan(0)
  })

  it('reports the assigned IPv6 address when the kernel egress is active', () => {
    const vm: Vm = {
      id: 'vm-gpt',
      platform: 'openai',
      family: 'codex',
      codex_ipv6_egress: {
        active: true,
        address: '2a0a:4cc0:2000:974f::1234',
        interface: 'eth0',
      },
    }

    const health = proxyHealthOf(vm, proxy)

    expect(health.tone.text).toBe('IPv6 就绪')
    expect(health.tone.label).toContain('2a0a:4cc0:2000:974f::1234')
    expect(health.score).toBe(100)
  })
})
