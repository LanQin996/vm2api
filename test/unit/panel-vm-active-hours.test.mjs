import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function seed(root, id) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, name: id, status: 'stopped', schedulable: false, policy: { maxConcurrency: 2 } }),
  )
}

function handler(project, body) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project }, vm: { id: null } },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => body,
    proxyPool: { unbindVm() {} },
  })
  return { handlePanel, response }
}

test('PATCH active_hours persists a normalized window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ah-patch-'))
  try {
    seed(root, 'vm-01')
    const { handlePanel, response } = handler(root, {
      active_hours: { start: '20:00', end: '08:00', timezone: 'asia/shanghai', days: [1, 2, 3, 4, 5] },
    })
    await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
    assert.deepEqual(saved.policy.active_hours, {
      start: '20:00',
      end: '08:00',
      timezone: 'Asia/Shanghai',
      days: [1, 2, 3, 4, 5],
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH active_hours rejects malformed config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ah-patch-'))
  try {
    seed(root, 'vm-01')
    const { handlePanel, response } = handler(root, { active_hours: { start: '8:00', end: '22:00' } })
    await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 400)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
    assert.equal(saved.policy.active_hours, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH active_hours null clears the window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ah-patch-'))
  try {
    seed(root, 'vm-01')
    const file = path.join(root, 'vms', 'vm-01.json')
    const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    vm.policy.active_hours = { start: '08:00', end: '22:00' }
    fs.writeFileSync(file, JSON.stringify(vm))
    const { handlePanel, response } = handler(root, { active_hours: null })
    await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.policy.active_hours, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
