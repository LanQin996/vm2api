import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-pool-policy-'))
}

function seed(root, id, policy = {}) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, name: id, status: 'stopped', schedulable: false, policy }),
  )
}

function policyOf(root, id) {
  return JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8')).policy || {}
}

function handler(project, body, extra = {}) {
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
    ...extra,
  })
  return { handlePanel, response }
}

const patchVm = (handlePanel, id = 'vm-01') =>
  handlePanel({ method: 'PATCH' }, {}, new URL(`http://localhost/api/panel/vms/${id}`))

const poolPolicy = (handlePanel) =>
  handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/pool-policy'))

test('PATCH weight pins the Codex slot weight', async () => {
  const root = tmpProject()
  try {
    seed(root, 'vm-01')
    const { handlePanel, response } = handler(root, { weight: 7 })
    await patchVm(handlePanel)
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    assert.equal(policyOf(root, 'vm-01').weight, 7)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH weight null drops back to the default 1', async () => {
  const root = tmpProject()
  try {
    seed(root, 'vm-01', { weight: 9 })
    const { handlePanel, response } = handler(root, { weight: null })
    await patchVm(handlePanel)
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    assert.equal(policyOf(root, 'vm-01').weight, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH weight rejects out-of-range and non-integer values without writing', async () => {
  const root = tmpProject()
  try {
    for (const weight of [0, 101, 2.5, '7']) {
      seed(root, 'vm-01')
      const { handlePanel, response } = handler(root, { weight })
      await patchVm(handlePanel)
      assert.equal(response.status, 400, `weight=${weight}`)
      assert.equal(response.body.error.code, 'invalid_scheduling_value', `weight=${weight}`)
      assert.equal(policyOf(root, 'vm-01').weight, undefined, `weight=${weight}`)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pool-policy batches weight and schedule_level over explicit ids', async () => {
  const root = tmpProject()
  try {
    seed(root, 'vm-01')
    seed(root, 'vm-02')
    const { handlePanel, response } = handler(root, {
      ids: ['vm-01', 'vm-02', 'vm-99'],
      weight: 4,
      schedule_level: 3,
    })
    await poolPolicy(handlePanel)
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    const report = response.body.data
    assert.equal(report.updated, 2)
    assert.deepEqual(report.missing, ['vm-99'])
    assert.deepEqual(report.failed, [])
    assert.deepEqual(report.items.map((item) => [item.id, item.weight, item.schedule_level]).sort(), [
      ['vm-01', 4, 3],
      ['vm-02', 4, 3],
    ])
    assert.equal(policyOf(root, 'vm-01').weight, 4)
    assert.equal(policyOf(root, 'vm-02').priority, 3)
    assert.equal(policyOf(root, 'vm-02').weight, 4)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pool-policy all=true unpins every slot', async () => {
  const root = tmpProject()
  try {
    seed(root, 'vm-01', { weight: 9, priority: 5 })
    seed(root, 'vm-02', { weight: 2, priority: 1 })
    const { handlePanel, response } = handler(root, { all: true, weight: null, schedule_level: 'auto' })
    await poolPolicy(handlePanel)
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    assert.equal(response.body.data.updated, 2)
    for (const id of ['vm-01', 'vm-02']) {
      assert.equal(policyOf(root, id).weight, 1, id)
      assert.equal(policyOf(root, id).priority, undefined, id)
    }
    assert.deepEqual([...new Set(response.body.data.items.map((item) => item.schedule_level))], ['auto'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pool-policy pushes concurrency pins through the shared scheduling helpers', async () => {
  const root = tmpProject()
  try {
    seed(root, 'vm-01')
    const calls = []
    const { handlePanel, response } = handler(
      root,
      { all: true, max_concurrency: 5 },
      {
        applyVmConcurrency: (...args) => calls.push(['concurrency', ...args]),
        applyVmRpm: (...args) => calls.push(['rpm', ...args]),
        inheritVmScheduling: (...args) => calls.push(['inherit', ...args]),
      },
    )
    await poolPolicy(handlePanel)
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    assert.deepEqual(calls, [['concurrency', 'vm-01', 5, { override: true }]])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pool-policy needs ids or all, and at least one policy field', async () => {
  const root = tmpProject()
  try {
    seed(root, 'vm-01')
    const noTargets = handler(root, { weight: 2 })
    await poolPolicy(noTargets.handlePanel)
    assert.equal(noTargets.response.status, 400)
    assert.match(noTargets.response.body.error.message, /ids or all required/)

    const noFields = handler(root, { all: true })
    await poolPolicy(noFields.handlePanel)
    assert.equal(noFields.response.status, 400)
    assert.match(noFields.response.body.error.message, /weight, schedule_level/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pool-policy rejects an invalid weight and never writes', async () => {
  const root = tmpProject()
  try {
    seed(root, 'vm-01', { weight: 3 })
    const { handlePanel, response } = handler(root, { all: true, weight: 500 })
    await poolPolicy(handlePanel)
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'invalid_weight')
    assert.equal(policyOf(root, 'vm-01').weight, 3)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
