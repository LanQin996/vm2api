import test from 'node:test'
import assert from 'node:assert/strict'
import { SLOT_CAPS_NODE } from '../../src/lib/cluster/placement.mjs'
import { codexRoleMatches, slotContainerBody } from '../../src/lib/cluster/remote-slot.mjs'
import { CODEX_SLOT_ROLE } from '../../src/lib/vm/vm-runtime.mjs'
import { slotHost } from '../../src/lib/vm/slot-host.mjs'
import { startSlotReady } from '../../src/lib/vm/slot-runtime.mjs'

const gpt = { id: 'vm-codex-01', platform: 'openai', family: 'codex', node_id: 'node-a', kernel: 'ubuntu-24.04' }
const claude = { id: 'vm-03', platform: 'anthropic', node_id: 'node-a', kernel: 'ubuntu-24.04' }

function body(vm) {
  return slotContainerBody(vm, {
    image: 'vm2api/kin-slot-ubuntu-24.04:abc',
    network: 'kin-codex-01-net',
    remoteDir: '/home/node/vms/vm-codex-01',
    user: '1000:1000',
    routing: {},
  })
}

test('a node can host a GPT slot because its Codex kernel stays on the control plane', () => {
  assert.equal(SLOT_CAPS_NODE.has('codex'), true)
  assert.equal(slotHost(gpt).supports('codex'), true)
  assert.equal(slotHost(gpt).supports('engine_switch'), false)
  assert.equal(slotHost(claude).supports('official_cc'), false)
})

test('a remote GPT container idles instead of booting the Claude kernel', () => {
  const spec = body(gpt)
  assert.deepEqual(spec.Cmd, ['sleep', 'infinity'])
  assert.equal(spec.Labels['kin.vm.role'], CODEX_SLOT_ROLE)
  const claudeSpec = body(claude)
  assert.deepEqual(claudeSpec.Cmd, [
    '/usr/local/bin/kin-kernel',
    '--gateway-worker',
    '--config',
    '/run/kin/kernel.json',
  ])
  assert.equal(claudeSpec.Labels['kin.vm.role'], undefined)
})

test('a remote GPT container still running kin-kernel is recreated', () => {
  const idle = { Config: { Labels: { 'kin.vm.role': CODEX_SLOT_ROLE } } }
  const crashLoop = { Config: { Labels: { 'kin.vm.runtime': 'docker' } } }
  assert.equal(codexRoleMatches(idle, gpt), true)
  assert.equal(codexRoleMatches(crashLoop, gpt), false)
  assert.equal(codexRoleMatches(crashLoop, claude), true)
  assert.equal(codexRoleMatches(idle, claude), false)
})
test('a freshly built GPT KVM container matches on the next start', () => {
  const kvm = { ...gpt, runtime: { type: 'kvm' } }
  const spec = body(kvm)
  assert.equal(spec.Labels['kin.vm.runtime'], 'kvm')
  assert.equal(spec.Labels['kin.vm.role'], undefined)
  const built = { Config: { Labels: spec.Labels } }
  assert.equal(codexRoleMatches(built, kvm), true)
  assert.equal(codexRoleMatches(built, { ...claude, runtime: { type: 'kvm' } }), true)
})

test('a failed remote GPT boot is returned and does not start the Codex kernel', async () => {
  let kernelStarts = 0
  const boot = { ok: false, code: 'slot_image_build_failed', error: 'node image build failed' }
  const result = await startSlotReady(gpt, '/tmp/vm2api-unused', {
    ops: {
      startSlot: async () => boot,
      ensureCodexKernel: async () => {
        kernelStarts += 1
        return { ok: true }
      },
    },
  })
  assert.equal(result, boot)
  assert.equal(kernelStarts, 0)
})
