import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  formatDockerMemoryBytes,
  inspectDockerContainerMemory,
  raiseDockerSlotMemory,
  validateDockerMemoryRaise,
} from '../../src/lib/vm/docker-slot-memory.mjs'

test('formatDockerMemoryBytes normalizes docker byte limits', () => {
  assert.equal(formatDockerMemoryBytes(536870912), '512m')
  assert.equal(formatDockerMemoryBytes(1073741824), '1g')
})

test('validateDockerMemoryRaise rejects kvm and invalid or non-increasing memory', () => {
  const kvm = { id: 'vm-1', runtime_type: 'kvm', machine: { memory: '512m' } }
  const kvmCheck = validateDockerMemoryRaise(kvm, '1g', {})
  assert.equal(kvmCheck.ok, false)
  assert.equal(kvmCheck.code, 'kvm_memory_raise_forbidden')

  const docker = { id: 'vm-2', runtime_type: 'docker', machine: { memory: '1g' } }
  assert.equal(validateDockerMemoryRaise(docker, '3g', {}).ok, false)
  assert.equal(validateDockerMemoryRaise(docker, '512m', {}).code, 'memory_not_increased')
  assert.equal(validateDockerMemoryRaise(docker, '2g', {}).ok, true)
})

function tmpVmRecord(root, id, machine = { memory: '512m' }) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, status: 'running', machine, runtime: { type: 'docker', memory: machine.memory } }),
  )
}

test('raiseDockerSlotMemory persists only after docker update and inspect succeed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mem-raise-'))
  try {
    const id = 'vm-01'
    tmpVmRecord(root, id)
    const vm = { id, runtime_type: 'docker', machine: { memory: '512m' }, runtime: { type: 'docker', memory: '512m' } }
    const calls = []
    const execImpl = (argv) => {
      calls.push(argv.join(' '))
      if (argv.includes('update')) return { ok: true, stdout: '', stderr: '' }
      if (argv.includes('inspect')) return { ok: true, stdout: String(1024 ** 3), stderr: '' }
      return { ok: false, stderr: 'unexpected' }
    }
    const raised = raiseDockerSlotMemory(root, vm, '1g', { execImpl })
    assert.equal(raised.ok, true)
    assert.equal(raised.memory, '1g')
    assert.match(calls.join('\n'), /--memory-swap 1g/)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
    assert.equal(saved.machine.memory, '1g')
    assert.equal(saved.runtime.memory, '1g')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('raiseDockerSlotMemory does not persist when docker update fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mem-fail-'))
  try {
    const id = 'vm-02'
    tmpVmRecord(root, id)
    const vm = { id, runtime_type: 'docker', machine: { memory: '512m' } }
    const execImpl = (argv) => {
      if (argv.includes('update')) return { ok: false, stderr: 'cannot update' }
      if (argv.includes('inspect')) return { ok: true, stdout: String(512 * 1024 ** 2), stderr: '' }
      return { ok: false, stderr: 'unexpected' }
    }
    const raised = raiseDockerSlotMemory(root, vm, '1g', { execImpl })
    assert.equal(raised.ok, false)
    assert.equal(raised.code, 'docker_update_failed')
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
    assert.equal(saved.machine.memory, '512m')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('inspectDockerContainerMemory reads HostConfig.Memory through exec', () => {
  const vm = { id: 'vm-03', runtime_type: 'docker' }
  const out = inspectDockerContainerMemory(vm, (argv) => {
    assert.match(argv.join(' '), /inspect.*HostConfig\.Memory/)
    return { ok: true, stdout: String(2 * 1024 ** 3), stderr: '' }
  })
  assert.equal(out.ok, true)
  assert.equal(out.memory, '2g')
})
