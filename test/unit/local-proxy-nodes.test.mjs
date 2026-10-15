import test from 'node:test'
import assert from 'node:assert/strict'
import {
  annotatePublicLocalProxy,
  canRevealClusterNodes,
  localProxyNodeFields,
} from '../../src/lib/vm/local-proxy-nodes.mjs'

test('canRevealClusterNodes is admin/super only', () => {
  assert.equal(canRevealClusterNodes('admin'), true)
  assert.equal(canRevealClusterNodes('super'), true)
  assert.equal(canRevealClusterNodes('user'), false)
  assert.equal(canRevealClusterNodes(undefined), false)
})

test('annotatePublicLocalProxy names each VPS’s own local row for admins', () => {
  const nodes = [{ id: 'node-a', label: '东京-01' }]
  const ctrl = annotatePublicLocalProxy(
    { id: 'px-local', kind: 'local', bound_vm_ids: ['vm-ctrl'] },
    { reveal: true, nodes },
  )
  assert.equal(ctrl.node_id, null)
  assert.equal(ctrl.node_name, null)
  const tokyo = annotatePublicLocalProxy(
    { id: 'px-local-node-a', kind: 'local', bound_vm_ids: ['vm-tokyo'] },
    { reveal: true, nodes },
  )
  assert.equal(tokyo.node_id, 'node-a')
  assert.equal(tokyo.node_name, '东京-01')
  assert.equal(tokyo.bound_nodes, undefined)
})

test('annotatePublicLocalProxy redacts node names and other tenants for user', () => {
  const proxy = {
    id: 'px-local',
    kind: 'local',
    bound_vm_ids: ['vm-a', 'vm-b'],
    bound_count: 2,
    geo: { ip: '203.0.113.9' },
  }
  const admin = annotatePublicLocalProxy(proxy, {
    reveal: true,
    vms: [{ id: 'vm-a' }, { id: 'vm-b', node_id: 'node-a' }],
    nodes: [{ id: 'node-a', label: '东京-01' }],
  })
  assert.equal(admin.node_name, null)
  assert.equal(admin.geo.ip, '203.0.113.9')

  const tenant = annotatePublicLocalProxy(proxy, {
    reveal: false,
    ownerVmIds: new Set(['vm-a']),
    vms: [{ id: 'vm-a' }, { id: 'vm-b', node_id: 'node-a' }],
    nodes: [{ id: 'node-a', label: '东京-01' }],
  })
  assert.deepEqual(tenant.bound_vm_ids, ['vm-a'])
  assert.equal(tenant.bound_nodes, undefined)
  assert.equal(tenant.node_name, undefined)
})

test('localProxyNodeFields omits node_name for tenants', () => {
  const nodes = [{ id: 'node-a', label: '东京-01' }]
  assert.deepEqual(localProxyNodeFields({ node_id: 'node-a' }, { role: 'admin', nodes }), {
    node_id: 'node-a',
    node_name: '东京-01',
  })
  assert.deepEqual(localProxyNodeFields({ node_id: 'node-a' }, { role: 'user', nodes }), {
    node_id: 'node-a',
  })
  assert.deepEqual(localProxyNodeFields({}, { role: 'admin', nodes }), {
    node_id: null,
    node_name: null,
  })
})
