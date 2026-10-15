import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildKvmRunArgs, computerDockerArgs, shouldPublishComputer } from '../../src/lib/vm/vm-runtime.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

const vm = {
  id: 'vm-02',
  kernel: 'ubuntu-24.04',
  timezone: 'UTC',
  locale: 'en_US.UTF-8',
  machine: {
    memory: '1g',
    vcpus: 2,
    disk_gb: 20,
    cpu_model: 'qemu64',
    mac: '52:54:00:11:22:33',
    smbios: {
      manufacturer: 'Dell Inc.',
      product: 'OptiPlex 7090',
      version: '1.0',
      family: 'OptiPlex',
      serial: 'ABC123',
      uuid: '11111111-2222-3333-4444-555555555555',
    },
    disk_serial: 'KIN123',
  },
  fingerprint: { hostname: 'guest-02', guest_machine_id: 'abc123' },
}

function argsFor(accel) {
  return buildKvmRunArgs({
    vm,
    name: 'kin-02',
    image: 'ghcr.io/example/kin-kvm-ubuntu:24.04',
    hostName: 'guest-02',
    network: 'kin-eg-px',
    memory: '1g',
    accel,
    uid: 10002,
    gid: 987,
    home: '/data/vms/vm-02/cli-home',
    runDir: '/data/vms/vm-02/run',
    kvmDir: '/data/vms/vm-02/kvm',
    workerBin: '/opt/kin-gateway/bin/kin-worker',
    kernelBin: '/opt/kin-gateway/bin/kin-kernel',
    shares: 'home,run',
    hostOf: (p) => p,
  })
}

test('kvm docker run mounts slot paths, stop-timeout 30, memory overhead', () => {
  const args = argsFor('tcg')
  assert.equal(args[0], 'docker')
  assert.equal(args[1], 'run')
  assert.equal(args[args.indexOf('--stop-timeout') + 1], '30')
  assert.equal(args[args.indexOf('--memory') + 1], '1536m')
  assert.equal(args.includes('--device'), false)
  assert.ok(args.includes('/data/vms/vm-02/cli-home:/slot/home'))
  assert.ok(args.includes('/data/vms/vm-02/run:/slot/run'))
  assert.ok(args.includes('/data/vms/vm-02/kvm:/slot/kvm'))
  assert.ok(args.includes('/opt/kin-gateway/bin/kin-worker:/opt/kin-guest/usr/local/bin/kin-worker:ro'))
  assert.ok(args.includes('/opt/kin-gateway/bin/kin-kernel:/opt/kin-guest/usr/local/bin/kin-kernel:ro'))
  assert.ok(args.includes('kin.vm.runtime=kvm'))
  assert.ok(args.includes('KIN_KVM_ACCEL=tcg'))
  assert.ok(args.includes('KIN_KVM_MEMORY_MB=1024'))
  assert.ok(args.includes('KIN_KVM_SHARES=home,run'))
  assert.equal(args.includes('--user'), false)
  assert.equal(args.includes('--read-only'), false)
  for (const cap of ['SETUID', 'SETGID', 'SETPCAP', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE']) {
    assert.equal(args[args.indexOf('--cap-add', args.indexOf(cap) - 1) + 1] === cap || args.includes(cap), true)
    const i = args.indexOf(cap)
    assert.ok(i > 0 && args[i - 1] === '--cap-add', cap)
  }
})

test('kvm docker run attaches /dev/kvm only with accel kvm', () => {
  const kvm = argsFor('kvm')
  const deviceAt = kvm.indexOf('--device')
  assert.notEqual(deviceAt, -1)
  assert.equal(kvm[deviceAt + 1], '/dev/kvm')
  assert.ok(kvm.includes('KIN_KVM_ACCEL=kvm'))
  const tcg = argsFor('tcg')
  assert.equal(tcg.includes('--device'), false)
  assert.equal(tcg.includes('/dev/kvm'), false)
})

test('an existing container keeps its baked computer name', () => {
  assert.equal(shouldPublishComputer({ running: true, id: 'old' }), false)
  assert.equal(shouldPublishComputer({ running: false, id: 'stopped' }), false)
  assert.equal(shouldPublishComputer(null), true)
  assert.equal(shouldPublishComputer(undefined), true)
})

test('kvm env uses fingerprint SMBIOS and does not carry smc or rom', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-fp-'))
  const kvmDir = path.join(root, 'kvm')
  fs.mkdirSync(path.join(kvmDir, 'fingerprint'), { recursive: true })
  fs.writeFileSync(
    path.join(kvmDir, 'fingerprint', 'qemu-smbios.args'),
    [
      '-uuid',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '-smbios',
      'type=1,manufacturer=Framework,product=Laptop16,version=AB,serial=FW123,uuid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,family=Laptop',
      '',
    ].join('\n'),
  )
  const args = buildKvmRunArgs({
    vm,
    name: 'kin-02',
    image: 'ghcr.io/example/kin-kvm-ubuntu:24.04',
    hostName: 'guest-02',
    network: 'kin-eg-px',
    memory: '1g',
    accel: 'tcg',
    uid: 10002,
    gid: 987,
    home: '/data/vms/vm-02/cli-home',
    runDir: '/data/vms/vm-02/run',
    kvmDir,
    shares: 'home,run',
  })
  assert.ok(args.includes('KIN_KVM_SMBIOS_MANUFACTURER=Framework'))
  assert.ok(args.includes('KIN_KVM_SMBIOS_PRODUCT=Laptop16'))
  assert.equal(
    args.some((arg) => String(arg).includes('OptiPlex')),
    false,
  )
  assert.equal(
    args.some((arg) => /smc_version|rom_hex/i.test(String(arg))),
    false,
  )
  assert.ok(args.includes('KIN_KVM_MAC=52:54:00:11:22:33'))
  assert.ok(args.includes('KIN_KVM_DISK_SERIAL=KIN123'))
  assert.ok(args.includes('KIN_KVM_MEMORY_MB=1024'))
  assert.ok(args.includes('KIN_KVM_VCPUS=2'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('docker computer mounts are read-only and use the persona MAC', () => {
  const args = computerDockerArgs({
    dir: '/data/vms/vm-02/kvm/fingerprint',
    mac: '3c:22:fb:f9:50:9d',
    hostOf: (p) => p,
  })
  assert.equal(args[args.indexOf('--mac-address') + 1], '3c:22:fb:f9:50:9d')
  assert.ok(args.includes('/data/vms/vm-02/kvm/fingerprint:/var/lib/kin-persona:ro'))
  assert.ok(args.includes('/data/vms/vm-02/kvm/fingerprint/system/etc/hostname:/etc/hostname:ro'))
  assert.ok(args.includes('/data/vms/vm-02/kvm/fingerprint/system/etc/kin-computer:/etc/kin-computer:ro'))
  assert.ok(args.includes('/data/vms/vm-02/kvm/fingerprint/system/dmi/id:/etc/kin-dmi:ro'))
  assert.ok(args.includes('/data/vms/vm-02/kvm/fingerprint/system/hardware:/etc/kin-hardware:ro'))
})

test('writeKernelConfig uses guest socket path and runtime_kind kvm', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-kernel-'))
  const written = writeKernelConfig(root, { id: 'vm-02', runtime: { type: 'kvm' } }, { token: 'tok' })
  const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(doc.runtime_kind, 'kvm')
  assert.equal(doc.socket_path, '/run/kin-guest/kernel.sock')
  assert.equal(written.socketPath, path.join(root, 'vms', 'vm-02', 'run', 'kernel.sock'))
  fs.rmSync(root, { recursive: true, force: true })
})
