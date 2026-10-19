import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createClusterRoutes } from '../../src/lib/cluster/cluster-routes.mjs'
import { ClusterError } from '../../src/lib/cluster/ssh-link.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

function harness(manager) {
  const response = {}
  const routes = createClusterRoutes({
    manager,
    readBody,
    json(_res, status, body) {
      Object.assign(response, { status, body })
    },
    ok: (data) => ({ ok: true, data }),
  })
  return {
    async request(method, pathname, body) {
      const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
      req.method = method
      await routes.handle(req, {}, new URL(pathname, 'http://localhost'))
      return response
    },
  }
}

test('node PATCH awaits the update and returns only its public view', async () => {
  const patch = { label: 'Worker A', expected_updated_at: '2026-10-18T00:00:00.000Z' }
  const publicNode = { id: 'node-a', label: 'Worker A', updated_at: '2026-10-18T00:00:00.001Z' }
  const app = harness({
    async update(id, input) {
      assert.equal(id, 'node-a')
      assert.deepEqual(input, patch)
      return publicNode
    },
  })
  const res = await app.request('PATCH', '/api/panel/cluster/nodes/node-a', patch)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true, data: publicNode })
})

test('editing probe uses the stored node while the add probe keeps its existing route', async () => {
  const calls = []
  const app = harness({
    async probeUpdate(id, input) {
      calls.push(['edit', id, input])
      return { docker: { ok: true }, vm_count: 1 }
    },
    async probe(input) {
      calls.push(['add', input])
      return { existing_id: null }
    },
  })
  await app.request('POST', '/api/panel/cluster/nodes/node-a/probe', { port: 2222, expected_updated_at: 'version' })
  await app.request('POST', '/api/panel/cluster/nodes/probe', { host: 'node.example' })
  assert.deepEqual(calls, [
    ['edit', 'node-a', { port: 2222, expected_updated_at: 'version' }],
    ['add', { host: 'node.example' }],
  ])
})

test('editing routes preserve actionable conflict and fingerprint errors', async () => {
  for (const code of ['node_edit_conflict', 'host_key_mismatch', 'node_in_use']) {
    for (const [method, suffix, handler] of [
      ['PATCH', '', 'update'],
      ['POST', '/probe', 'probeUpdate'],
    ]) {
      const app = harness({
        async [handler]() {
          throw new ClusterError(409, code, 'please retry')
        },
      })
      const res = await app.request(method, `/api/panel/cluster/nodes/node-a${suffix}`, {})
      assert.equal(res.status, 409)
      assert.equal(res.body.error.code, code)
    }
  }
})

test('malformed and oversized edit bodies are rejected before calling the manager', async () => {
  const app = harness({ update: () => assert.fail('invalid request reached manager') })
  assert.equal((await app.request('PATCH', '/api/panel/cluster/nodes/node-a', '{')).status, 400)
  assert.equal(
    (await app.request('PATCH', '/api/panel/cluster/nodes/node-a', { password: 'x'.repeat(65536) })).status,
    413,
  )
})

test('node edit and probe cannot bypass panel admin permissions', async () => {
  for (const [method, suffix] of [
    ['PATCH', ''],
    ['POST', '/probe'],
  ]) {
    const pathname = `/api/panel/cluster/nodes/node-a${suffix}`
    assert.equal(authorizePanelRoute(method, pathname, 'admin').ok, true)
    for (const role of ['user', 'super']) {
      let response
      const panel = createPanelHandler({
        cfg: { paths: {} },
        requireAuth(req) {
          req.panelUser = 'operator'
          req.panelRole = role
          return true
        },
        clusterRoutes: { handle: () => assert.fail('non-admin reached cluster handler') },
        json(_res, status, body) {
          response = { status, body }
        },
      })
      await panel({ method }, {}, new URL(pathname, 'http://localhost'))
      assert.equal(response.status, 403)
      assert.equal(response.body.error.code, 'forbidden')
    }
  }
})
