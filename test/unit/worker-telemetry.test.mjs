import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWorkerTelemetry, touchTelemetrySession } from '../../src/lib/vm/worker-telemetry.mjs'
import { syncWorkerTelemetry } from '../../src/lib/vm/vm-runtime.mjs'
import { slotRuntimeOwner } from '../../src/lib/oauth/oauth-credentials.mjs'

const MACHINE = 'aa'.repeat(32)
const USER = 'bb'.repeat(32)

function writeOfficialHome(root, vmId) {
  const home = path.join(root, 'vms', vmId, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      machineID: MACHINE,
      userID: USER,
      oauthAccount: {
        accountUuid: 'acc-official',
        organizationUuid: 'org-official',
      },
    }),
  )
  return home
}

test('sidecar stays off without official identity', () => {
  const out = buildWorkerTelemetry(
    {
      id: 'vm-09',
      seed_policy: { telemetry_disabled: false },
      fingerprint: { device_id: 'slot-device', session_id: 'sess-9' },
    },
    os.tmpdir(),
  )
  assert.equal(out.enabled, false)
  assert.equal(out.reason, 'waiting_official_identity')
})

test('sidecar enables with official ~/.claude.json IDs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-'))
  writeOfficialHome(root, 'vm-02')
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-02', 'cli-home', '.claude', 'kin-official-bootstrap.json'),
    JSON.stringify({ status: 'ok', finished_at: '2026-10-07T06:36:42.123Z' }),
  )
  const vm = {
    id: 'vm-02',
    seed_policy: { telemetry_disabled: false },
    fingerprint: { device_id: 'd2', session_id: 's2', shell: '/bin/zsh', vcs: 'git', runtimes: 'bun,node' },
  }
  const out = buildWorkerTelemetry(vm, root)
  assert.equal(out.enabled, true)
  assert.equal(out.identity.device_id, USER)
  assert.equal(out.identity.user_id, USER)
  assert.equal(out.identity.source, 'official-cc-init')
  assert.equal(out.betas, undefined)
  assert.equal(out.identity.betas, undefined)
  assert.equal(out.identity.env.shell, 'zsh')
  assert.equal(out.identity.env.vcs, 'git')
  assert.equal(out.identity.env.runtimes, 'bun,node')
  assert.equal(out.identity.env.build_time, '2026-10-07T06:36:42Z')
  assert.equal(out.identity.env.node_version, undefined)
  assert.equal(out.identity.env.is_running_with_bun, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('machine id alone is not the 64-hex device id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-'))
  const home = path.join(root, 'vms', 'vm-02', 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ machineID: MACHINE, userID: 'not-64-hex' }))
  const out = buildWorkerTelemetry({ id: 'vm-02', seed_policy: { telemetry_disabled: false } }, root)
  assert.equal(out.enabled, false)
  assert.equal(out.reason, 'waiting_official_identity')
  fs.rmSync(root, { recursive: true, force: true })
})

test('syncWorkerTelemetry writes enabled:true when official IDs exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-'))
  writeOfficialHome(root, 'vm-02')
  const vm = {
    id: 'vm-02',
    seed_policy: { telemetry_disabled: false },
    fingerprint: { device_id: 'd2', session_id: 's2' },
  }
  const runDir = path.join(root, 'vms', 'vm-02', 'run')
  fs.mkdirSync(runDir, { recursive: true })
  const cfgPath = path.join(runDir, 'worker.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ vm_id: 'vm-02', proxy_required: false }))
  const out = syncWorkerTelemetry(vm, root)
  assert.equal(out.wrote, true)
  assert.equal(out.enabled, true)
  const doc = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  assert.equal(doc.telemetry.enabled, true)
  assert.equal(doc.proxy_required, false)
  const touch = touchTelemetrySession(root, 'vm-02')
  assert.equal(touch.wrote, true)
  assert.equal(fs.existsSync(path.join(runDir, 'telemetry.touch')), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('syncWorkerTelemetry chowns the replaced worker.json to the slot uid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-owner-'))
  writeOfficialHome(root, 'vm-02')
  const vm = {
    id: 'vm-02',
    seed_policy: { telemetry_disabled: false },
    fingerprint: { device_id: 'd2', session_id: 's2' },
  }
  const cfgPath = path.join(root, 'vms', 'vm-02', 'run', 'worker.json')
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, JSON.stringify({ vm_id: 'vm-02', proxy_required: false }))
  const owner = slotRuntimeOwner(vm)
  const calls = []
  const chown = mock.method(fs, 'chownSync', (file, uid, gid) => {
    calls.push({ file, uid, gid })
  })
  try {
    const out = syncWorkerTelemetry(vm, root)
    assert.equal(out.wrote, true)
    const owned = calls.filter((call) => String(call.file).includes(`${path.sep}worker.json`))
    assert.ok(owned.length >= 1)
    assert.ok(owned.every((call) => call.uid === owner.uid && call.gid === owner.gid))
    assert.ok(owned.some((call) => call.file !== cfgPath && String(call.file).startsWith(`${cfgPath}.`)))
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).telemetry.enabled, true)
  } finally {
    chown.mock.restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('sidecar env uses observed hardware instead of workstation profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-hw-'))
  writeOfficialHome(root, 'vm-02')
  const vm = {
    id: 'vm-02',
    seed_policy: { telemetry_disabled: false },
    fingerprint: {
      device_id: 'd2',
      session_id: 's2',
      os_id: 'ubuntu',
      os_pretty: 'Ubuntu 24.04.4 LTS',
      kernel_release: '6.8.0-guest',
      hardware: {
        cpu_model: 'Intel(R) Xeon(R) CPU',
        cpu_cores: 4,
        memory_bytes: 4294967296,
        root_disk: '/dev/vda2',
        mac: '52:54:00:11:22:33',
        dmi: {
          manufacturer: 'Dell Inc.',
          product: 'OptiPlex 7090',
          version: '1.0',
          family: 'OptiPlex',
          serial: 'ABC123',
          uuid: '11111111-2222-3333-4444-555555555555',
        },
        shell: '/bin/zsh',
        package_managers: 'apt,pacman',
        runtimes: 'bun,node',
      },
    },
  }
  const out = buildWorkerTelemetry(vm, root)
  assert.equal(out.enabled, true)
  assert.equal(out.identity.shell, 'zsh')
  assert.equal(out.identity.package_managers, 'apt,pacman')
  assert.equal(out.identity.runtimes, 'bun,node')
  assert.equal(out.identity.env.shell, 'zsh')
  assert.equal(out.identity.env.package_managers, 'apt,pacman')
  assert.equal(out.identity.env.runtimes, 'bun,node')
  assert.equal(out.identity.env.cpu_model, 'Intel(R) Xeon(R) CPU')
  assert.equal(out.identity.cpu_model, 'Intel(R) Xeon(R) CPU')
  assert.equal(out.identity.cpu_cores, 4)
  assert.equal(out.identity.env.cpu_cores, 4)
  assert.equal(out.identity.env.memory_bytes, 4294967296)
  assert.equal(out.identity.env.root_disk, '/dev/vda2')
  assert.equal(out.identity.env.mac, '52:54:00:11:22:33')
  assert.equal(out.identity.env.dmi_manufacturer, 'Dell Inc.')
  assert.equal(out.identity.env.dmi_product, 'OptiPlex 7090')
  assert.equal(out.identity.env.dmi_version, '1.0')
  assert.equal(out.identity.env.dmi_family, 'OptiPlex')
  assert.equal(out.identity.env.dmi_serial, 'ABC123')
  assert.equal(out.identity.env.dmi_uuid, '11111111-2222-3333-4444-555555555555')
  assert.equal(out.identity.env.linux_kernel, '6.8.0-guest')
  fs.rmSync(root, { recursive: true, force: true })
})

test('old VMs without hardware keep previous telemetry env fallbacks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-old-'))
  writeOfficialHome(root, 'vm-02')
  const vm = {
    id: 'vm-02',
    seed_policy: { telemetry_disabled: false },
    fingerprint: { device_id: 'd2', session_id: 's2', shell: '/bin/zsh', runtimes: 'bun,node' },
  }
  const out = buildWorkerTelemetry(vm, root)
  assert.equal(out.enabled, true)
  assert.equal(out.identity.env.shell, 'zsh')
  assert.equal(out.identity.env.package_managers, '')
  assert.equal(out.identity.env.runtimes, 'bun,node')
  assert.equal(out.identity.env.cpu_model, undefined)
  assert.equal(out.identity.env.dmi_uuid, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})
