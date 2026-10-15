/**
 * Panel labels for local egress. Each VPS has its own local row (`px-local`
 * for the control plane, `px-local-<nodeId>` per node), so bind capacity,
 * probe and geo are per machine; these helpers attach the node's display name
 * for admins and redact it for tenants.
 */
import { isLocalEgressProxy, localEgressNodeId } from './egress.mjs'

export function canRevealClusterNodes(role) {
  const r = String(role || '')
    .trim()
    .toLowerCase()
  return r === 'admin' || r === 'super'
}

export function clusterNodeDisplayName(node) {
  const label = String(node?.label || '').trim()
  return label || null
}

export function nodeNameOf(nodes, nodeId) {
  if (!nodeId) return null
  const id = String(nodeId)
  const node = (nodes || []).find((item) => item && String(item.id) === id)
  return clusterNodeDisplayName(node)
}

export function vmNodeIdOf(vm) {
  const id = String(vm?.node_id || '').trim()
  return id || null
}

function boundIdsOf(proxy) {
  if (Array.isArray(proxy?.bound_vm_ids) && proxy.bound_vm_ids.length) {
    return proxy.bound_vm_ids.map((id) => String(id || '').trim()).filter(Boolean)
  }
  const single = String(proxy?.bound_vm_id || '').trim()
  return single ? [single] : []
}

/**
 * Shape a public proxy row for the panel. A local row names its own VPS for
 * admins; tenants keep their own VM ids and no node names.
 */
export function annotatePublicLocalProxy(proxy, { reveal = false, nodes = [], ownerVmIds = null } = {}) {
  if (!proxy) return proxy
  if (!isLocalEgressProxy(proxy)) {
    if (reveal) return proxy
    const out = { ...proxy }
    delete out.node_name
    delete out.bound_nodes
    return out
  }
  let ids = boundIdsOf(proxy)
  if (ownerVmIds) {
    ids = ids.filter((id) => ownerVmIds.has(String(id)))
    if (!ids.length) return null
  }
  const out = {
    ...proxy,
    bound_vm_ids: ids,
    bound_vm_id: ids[0] || null,
    bound_count: ids.length,
  }
  const nodeId = localEgressNodeId(proxy.id)
  out.node_id = nodeId
  // One row per VPS: the row itself names its machine, no per-node grouping left to do.
  delete out.bound_nodes
  if (reveal) out.node_name = nodeId ? nodeNameOf(nodes, nodeId) : null
  else delete out.node_name
  return out
}

export function localProxyNodeFields(vm, { role, nodes = [] } = {}) {
  const nodeId = vmNodeIdOf(vm)
  if (!canRevealClusterNodes(role)) return { node_id: nodeId }
  return { node_id: nodeId, node_name: nodeId ? nodeNameOf(nodes, nodeId) : null }
}
