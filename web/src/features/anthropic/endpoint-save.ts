export const DEFAULT_URL = 'https://api.anthropic.com'
export const DIRECT = '__direct__'

export type AuthScheme = 'x_api_key' | 'authorization_bearer'

/** 载入时的服务端值；保存已存地址只发和它不同的字段。 */
export type StoredSnapshot = {
  baseUrl: string
  authScheme: AuthScheme
  proxyId: string
}

export type EndpointDraft = {
  id: string
  storedId?: string
  keyId?: string
  baseUrl: string
  authScheme: AuthScheme
  apiKey: string
  proxyId: string
  stored?: StoredSnapshot
}

type StoredItem = {
  id: string
  base_url?: string
  auth_scheme?: string
  api_key_entries?: { id?: string; proxy_id?: string }[]
}

export function draftFromStored(item: StoredItem): EndpointDraft {
  const key = item.api_key_entries?.[0]
  const stored: StoredSnapshot = {
    baseUrl: item.base_url || DEFAULT_URL,
    authScheme:
      item.auth_scheme === 'authorization_bearer'
        ? 'authorization_bearer'
        : 'x_api_key',
    proxyId: key?.proxy_id || DIRECT,
  }
  return {
    id: item.id,
    storedId: item.id,
    keyId: key?.id || '',
    apiKey: '',
    ...stored,
    stored,
  }
}

function kindOf(baseUrl: string) {
  return baseUrl === DEFAULT_URL ? 'claude' : 'custom'
}

/**
 * 新地址整条创建；已存地址只发密钥和改过的字段。后端 PATCH 对 name / models
 * 是整体覆盖，发了就会把已存的模型表和名称冲掉，所以从不发这两项。
 */
export function endpointSaveRequest(
  item: EndpointDraft,
  model: string
): { method: 'POST' | 'PATCH'; path: string; body: Record<string, unknown> } {
  const baseUrl = item.baseUrl.trim() || DEFAULT_URL
  const apiKey = item.apiKey.trim()
  const proxyId = item.proxyId === DIRECT ? '' : item.proxyId
  if (!item.storedId) {
    const name = model.trim() || 'claude-sonnet-4-5'
    return {
      method: 'POST',
      path: '/api/panel/api-endpoints',
      body: {
        kind: kindOf(baseUrl),
        protocol: 'anthropic',
        name: baseUrl,
        base_url: baseUrl,
        auth_scheme: item.authScheme,
        proxy_id: proxyId,
        key_id: item.keyId || '',
        api_key: apiKey,
        models: [{ name, alias: name }],
        api_key_entries: apiKey ? [{ api_key: apiKey }] : [],
      },
    }
  }
  const was = item.stored
  const body: Record<string, unknown> = { key_id: item.keyId || '' }
  if (apiKey) body.api_key = apiKey
  if (!was || item.proxyId !== was.proxyId) body.proxy_id = proxyId
  if (!was || item.authScheme !== was.authScheme)
    body.auth_scheme = item.authScheme
  if (was && baseUrl !== was.baseUrl) {
    body.kind = kindOf(baseUrl)
    body.base_url = baseUrl
  }
  return {
    method: 'PATCH',
    path: `/api/panel/api-endpoints/${encodeURIComponent(item.storedId)}`,
    body,
  }
}
