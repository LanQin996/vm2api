import type { ClusterApiNode } from '@/types/panel-cluster'
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import {
  connectionDraft,
  connectionNodePatch,
  NodeEditRequests,
  nodeEditError,
  renameNodePatch,
} from './node-edit'

const node: ClusterApiNode = {
  id: 'node-a',
  label: 'Node A',
  host: '192.0.2.10',
  port: 22,
  username: 'ubuntu',
  auth_type: 'key',
  host_key_alg: 'ssh-ed25519',
  host_key_sha256: 'SHA256:original',
  jump_node_id: 'node-jump',
  created_at: '2026-10-18T00:00:00Z',
  updated_at: '2026-10-18T01:00:00Z',
  link: { state: 'error' },
  health: null,
  bridge: null,
  install: null,
}
const counts = { vmCount: 0, dependentCount: 0 }

describe('node edit payloads', () => {
  it('renames an offline node without sending connection or credential fields', () => {
    expect(renameNodePatch(node, '  New name  ')).toEqual({
      expected_updated_at: node.updated_at,
      label: 'New name',
    })
    expect(() => renameNodePatch(node, '  ')).toThrow('1–64')
    expect(() => renameNodePatch(node, 'x'.repeat(65))).toThrow('1–64')
  })

  it('keeps saved credentials and sends only changed connection fields', () => {
    const draft = connectionDraft(node)
    expect(draft).toMatchObject({
      replaceCredentials: false,
      password: '',
      privateKey: '',
      passphrase: '',
    })
    draft.host = ' new.example.net '
    draft.port = '2222'
    expect(connectionNodePatch(node, draft, { ...counts, vmCount: 2 })).toEqual(
      {
        expected_updated_at: node.updated_at,
        host: 'new.example.net',
        port: 2222,
      }
    )
  })

  it('does not reset a captured draft or version when a new poll arrives', () => {
    const draft = connectionDraft(node)
    draft.host = 'edited.example.net'
    const polled = {
      ...node,
      host: 'other.example.net',
      updated_at: '2026-10-18T02:00:00Z',
    }
    expect(connectionDraft(polled).host).toBe('other.example.net')
    expect(connectionNodePatch(node, draft, counts)).toEqual({
      expected_updated_at: node.updated_at,
      host: 'edited.example.net',
    })
  })

  it('requires new credentials on auth switch and never submits the old auth secrets', () => {
    const draft = { ...connectionDraft(node), authType: 'password' as const }
    expect(() => connectionNodePatch(node, draft, counts)).toThrow('新的密码')
    expect(
      connectionNodePatch(
        node,
        {
          ...draft,
          password: ' new password ',
          privateKey: 'unused',
          passphrase: 'unused',
        },
        counts
      )
    ).toEqual({
      expected_updated_at: node.updated_at,
      auth_type: 'password',
      password: ' new password ',
    })
    const passwordNode = { ...node, auth_type: 'password' as const }
    const keyDraft = {
      ...connectionDraft(passwordNode),
      authType: 'key' as const,
      password: 'unused',
    }
    expect(() => connectionNodePatch(passwordNode, keyDraft, counts)).toThrow(
      '新的私钥'
    )
  })

  it('explicit key replacement clears the old passphrase when the new one is empty', () => {
    const draft = {
      ...connectionDraft(node),
      replaceCredentials: true,
      privateKey: ' new-key ',
    }
    expect(connectionNodePatch(node, draft, counts)).toEqual({
      expected_updated_at: node.updated_at,
      private_key: 'new-key',
      passphrase: '',
    })
    expect(() =>
      connectionNodePatch(node, { ...draft, privateKey: '' }, counts)
    ).toThrow('新的私钥')
  })

  it('prevents username changes with VMs or unknown inventory and blocks jump dependents', () => {
    const draft = { ...connectionDraft(node), username: 'new-user' }
    for (const vmCount of [1, null]) {
      expect(() =>
        connectionNodePatch(node, draft, { ...counts, vmCount })
      ).toThrow('不能修改 SSH 用户名')
    }
    expect(connectionNodePatch(node, draft, counts).username).toBe('new-user')
    expect(() =>
      connectionNodePatch(
        node,
        { ...connectionDraft(node), port: '2222' },
        { ...counts, dependentCount: 1 }
      )
    ).toThrow('经由此节点')
    expect(renameNodePatch(node, 'Renamed').label).toBe('Renamed')
  })

  it('does not turn invalid or blank ports into the default SSH port', () => {
    for (const port of ['', '0', '-1', '65536', '22.5', 'abc']) {
      expect(() =>
        connectionNodePatch(node, { ...connectionDraft(node), port }, counts)
      ).toThrow('端口')
    }
    expect(() =>
      connectionNodePatch(node, connectionDraft(node), counts)
    ).toThrow('未修改')
  })
})

describe('node edit request lifetime', () => {
  it('rejects a late successful probe after the draft changes and accepts only the next probe', async () => {
    const requests = new NodeEditRequests()
    const first = requests.begin()
    let finish!: () => void
    const result = new Promise<void>((resolve) => {
      finish = resolve
    })
    const accepted = result.then(() => requests.accepts(first))
    requests.cancel()
    const second = requests.begin()
    finish()
    expect(await accepted).toBe(false)
    expect(first.signal.aborted).toBe(true)
    expect(requests.accepts(second)).toBe(true)
  })

  it('cancelling or switching nodes invalidates an in-flight save as well as a completed probe', () => {
    const requests = new NodeEditRequests()
    const probe = requests.begin()
    expect(requests.accepts(probe)).toBe(true)
    const save = requests.begin()
    expect(requests.accepts(probe)).toBe(false)
    requests.cancel()
    expect(save.signal.aborted).toBe(true)
    expect(requests.accepts(save)).toBe(false)
    expect(new NodeEditRequests().accepts(save)).toBe(false)
  })
})

describe('node edit errors', () => {
  it('explains conflicts, deleted nodes and pinned-host mismatches without retrying stale edits', () => {
    expect(
      nodeEditError(new ApiError('conflict', 409, 'node_edit_conflict'))
    ).toContain('取消后重新编辑')
    expect(
      nodeEditError(new ApiError('missing', 404, 'node_not_found'))
    ).toContain('已被移除')
    expect(
      nodeEditError(new ApiError('mismatch', 409, 'host_key_mismatch'))
    ).toContain('同一台主机')
    expect(
      nodeEditError(new ApiError('bad credentials', 403, 'auth_failed'))
    ).toBe('bad credentials')
  })
})
