import type { ClusterApiNode, ClusterNodePatch } from '@/types/panel-cluster'

export type NodeConnectionDraft = {
  host: string
  port: string
  username: string
  authType: 'key' | 'password'
  replaceCredentials: boolean
  privateKey: string
  passphrase: string
  password: string
}

export function connectionDraft(node: ClusterApiNode): NodeConnectionDraft {
  return {
    host: node.host,
    port: String(node.port),
    username: node.username,
    authType: node.auth_type,
    replaceCredentials: false,
    privateKey: '',
    passphrase: '',
    password: '',
  }
}

export function renameNodePatch(
  node: ClusterApiNode,
  label: string
): ClusterNodePatch {
  const value = label.trim()
  if (!value || value.length > 64) throw new Error('名称须为 1–64 个字符')
  if (value === node.label) throw new Error('名称未修改')
  return { expected_updated_at: node.updated_at, label: value }
}

export function connectionNodePatch(
  node: ClusterApiNode,
  draft: NodeConnectionDraft,
  {
    vmCount,
    dependentCount,
  }: { vmCount: number | null; dependentCount: number }
): ClusterNodePatch {
  if (dependentCount > 0)
    throw new Error('其他节点仍经由此节点连接，暂不能修改连接配置')
  const host = draft.host.trim()
  const username = draft.username.trim()
  const port = Number(draft.port)
  if (!host) throw new Error('请填写主机地址')
  if (
    !/^\d+$/.test(draft.port) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error('端口须为 1–65535 的整数')
  }
  if (!username) throw new Error('请填写 SSH 用户名')
  const patch: ClusterNodePatch = { expected_updated_at: node.updated_at }
  if (host !== node.host) patch.host = host
  if (port !== node.port) patch.port = port
  if (username !== node.username) {
    if (vmCount !== 0)
      throw new Error('有槽位或槽位信息未加载时，不能修改 SSH 用户名')
    patch.username = username
  }
  const authChanged = draft.authType !== node.auth_type
  if (authChanged) patch.auth_type = draft.authType
  if (authChanged || draft.replaceCredentials) {
    if (draft.authType === 'key') {
      if (!draft.privateKey.trim()) throw new Error('请填写新的私钥')
      patch.private_key = draft.privateKey.trim()
      // Empty means this replacement key has no passphrase, not "keep the old one".
      patch.passphrase = draft.passphrase
    } else {
      if (!draft.password) throw new Error('请填写新的密码')
      patch.password = draft.password
    }
  }
  if (Object.keys(patch).length === 1) throw new Error('连接配置未修改')
  return patch
}

/** A field edit, cancellation or unmount invalidates every older async result. */
export class NodeEditRequests {
  private revision = 0
  private controller: AbortController | null = null

  cancel() {
    this.revision++
    this.controller?.abort()
    this.controller = null
  }

  begin() {
    this.cancel()
    this.controller = new AbortController()
    return { revision: this.revision, signal: this.controller.signal }
  }

  accepts(request: { revision: number; signal: AbortSignal }) {
    return (
      request.revision === this.revision &&
      request.signal === this.controller?.signal &&
      !request.signal.aborted
    )
  }
}

export function nodeEditError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code
  if (code === 'node_edit_conflict')
    return '节点配置已被修改，请取消后重新编辑。'
  if (code === 'node_not_found') return '节点已被移除，请关闭后刷新节点列表。'
  if (code === 'node_username_in_use')
    return '节点已有槽位，不能更改 SSH 用户名。'
  if (code === 'node_in_use')
    return error instanceof Error
      ? error.message
      : '节点仍有进行中的任务或依赖，请完成后重试。'
  if (code === 'host_key_mismatch')
    return '主机指纹不一致。此处只能更新同一台主机的连接信息。'
  return error instanceof Error ? error.message : '请求失败'
}
