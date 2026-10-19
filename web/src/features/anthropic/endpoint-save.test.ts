import { describe, expect, it } from 'vitest'
import {
  DEFAULT_URL,
  DIRECT,
  draftFromStored,
  endpointSaveRequest,
} from './endpoint-save'

const stored = draftFromStored({
  id: 'ep_1',
  base_url: 'https://relay.example.com',
  auth_scheme: 'authorization_bearer',
  api_key_entries: [{ id: 'ek_1', proxy_id: 'px_9' }],
})

describe('anthropic console endpoint save', () => {
  it('loads the stored proxy instead of falling back to direct', () => {
    expect(stored.proxyId).toBe('px_9')
    expect(stored.keyId).toBe('ek_1')
    expect(stored.authScheme).toBe('authorization_bearer')
  })

  it('saving an unchanged stored row never sends name, models or proxy', () => {
    const req = endpointSaveRequest({ ...stored, apiKey: ' sk-new ' }, 'm1')
    expect(req.method).toBe('PATCH')
    expect(req.path).toBe('/api/panel/api-endpoints/ep_1')
    expect(req.body).toEqual({ key_id: 'ek_1', api_key: 'sk-new' })
  })

  it('sends only the fields the user changed', () => {
    const req = endpointSaveRequest(
      { ...stored, proxyId: DIRECT, baseUrl: DEFAULT_URL },
      'm1'
    )
    expect(req.body).toEqual({
      key_id: 'ek_1',
      proxy_id: '',
      kind: 'claude',
      base_url: DEFAULT_URL,
    })
    expect(req.body).not.toHaveProperty('models')
    expect(req.body).not.toHaveProperty('name')
  })

  it('creates a new endpoint with its first key and model', () => {
    const req = endpointSaveRequest(
      {
        id: 'tmp',
        baseUrl: DEFAULT_URL,
        authScheme: 'x_api_key',
        apiKey: 'sk-1234',
        proxyId: 'px_1',
      },
      ''
    )
    expect(req.method).toBe('POST')
    expect(req.body).toMatchObject({
      kind: 'claude',
      proxy_id: 'px_1',
      api_key_entries: [{ api_key: 'sk-1234' }],
      models: [{ name: 'claude-sonnet-4-5', alias: 'claude-sonnet-4-5' }],
    })
  })
})
