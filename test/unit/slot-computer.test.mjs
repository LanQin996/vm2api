import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEVICE_ID_RE, HOSTNAME_RE, MACHINE_ID_RE } from '../../src/lib/identity/workstation-fingerprint.mjs'
import { assignComputerFingerprint, ensureSlotComputer } from '../../src/lib/identity/slot-computer.mjs'

test('missing kin-computer binary throws computer_service_missing', () => {
  const prev = process.env.KIN_COMPUTER_BIN
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-computer-missing-'))
  try {
    process.env.KIN_COMPUTER_BIN = path.join(root, 'no-such-kin-computer-bin')
    const vm = { id: 'vm-missing-bin', kernel: 'ubuntu-24.04', runtime: { type: 'docker' } }
    assert.throws(
      () => ensureSlotComputer(root, vm),
      (err) => err?.code === 'computer_service_missing',
    )
  } finally {
    if (prev == null) delete process.env.KIN_COMPUTER_BIN
    else process.env.KIN_COMPUTER_BIN = prev
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linux computer is written once and device_id stays 64-bit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-computer-linux-'))
  const vm = { id: 'vm-linux-1', kernel: 'ubuntu-24.04', runtime: { type: 'kvm' } }
  const first = ensureSlotComputer(root, vm)
  const second = ensureSlotComputer(root, vm)
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.hostname, first.hostname)
  assert.equal(second.guest_machine_id, first.guest_machine_id)
  assert.match(first.hostname, HOSTNAME_RE)
  assert.doesNotMatch(first.hostname, /^[a-z]+-[0-9a-f]{4}$/)
  assert.match(first.guest_machine_id, MACHINE_ID_RE)
  assert.equal(fs.existsSync(path.join(first.dir, 'qemu-smbios.args')), true)
  const pack = assignComputerFingerprint(root, vm, {
    taken: { hostname: new Set(), device_id: new Set(), guest_machine_id: new Set() },
  })
  assert.equal(pack.hostname, first.hostname)
  assert.equal(pack.guest_machine_id, first.guest_machine_id)
  assert.match(pack.device_id, DEVICE_ID_RE)
  const ident = JSON.parse(fs.readFileSync(path.join(first.dir, 'identity.json'), 'utf8'))
  const uuid = String(ident.uuid || '')
    .replace(/-/g, '')
    .toLowerCase()
  assert.notEqual(pack.device_id, uuid)
  fs.rmSync(root, { recursive: true, force: true })
})

test('container computer prepare is stable and exposes mac plus dmi', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-computer-os-'))
  const vm = { id: 'vm-os-1', kernel: 'ubuntu-24.04', runtime: { type: 'docker' } }
  const first = ensureSlotComputer(root, vm)
  const second = ensureSlotComputer(root, vm)
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.hostname, first.hostname)
  assert.match(first.hostname, HOSTNAME_RE)
  assert.doesNotMatch(first.hostname, /^[a-z]+-[0-9a-f]{4}$/)
  assert.match(first.guest_machine_id, MACHINE_ID_RE)
  assert.match(first.mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/)
  assert.equal(fs.statSync(path.join(first.dir, 'system', 'dmi', 'id')).isDirectory(), true)
  assert.equal(
    fs
      .readFileSync(path.join(first.dir, 'system', 'hardware', 'mac'), 'utf8')
      .trim()
      .toLowerCase(),
    first.mac,
  )
  fs.rmSync(root, { recursive: true, force: true })
})
