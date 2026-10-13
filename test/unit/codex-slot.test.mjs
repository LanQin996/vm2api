import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseCodexCredentialInput,
  upsertCodexAccount,
  readCodexAccounts,
  writeCodexAccounts,
  persistCodexCredentialState,
  codexCredentialVersion,
} from '../../src/lib/vm/codex-slot.mjs'
import { getVm, listVms } from '../../src/lib/vm/vm-registry.mjs'
import { isCodexSlotReady } from '../../src/lib/pool/codex-slot-pool.mjs'
import { evaluateAccount } from '../../src/lib/pool/availability.mjs'

function jwt(payload) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

test('parseCodexCredentialInput accepts Codex CLI auth.json', () => {
  const parsed = parseCodexCredentialInput({
    tokens: {
      access_token: 'eyJhbGciOiaccess',
      refresh_token: 'rt-1',
      id_token: 'id-1',
    },
    account_id: 'acc-uuid',
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'eyJhbGciOiaccess')
  assert.equal(parsed.account.refresh_token, 'rt-1')
  assert.equal(parsed.account.chatgpt_account_id, 'acc-uuid')
})

test('Codex OAuth import reads email from id_token', () => {
  const parsed = parseCodexCredentialInput({
    tokens: {
      access_token: jwt({ email: 'access@example.com' }),
      id_token: jwt({ email: 'id@example.com' }),
      refresh_token: 'rt',
    },
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.email, 'id@example.com')
})

test('Codex account summary recovers email from existing access token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-email-'))
  try {
    fs.mkdirSync(path.join(root, 'vms', 'vm-codex-01'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', 'vm-codex-01.json'),
      JSON.stringify({ id: 'vm-codex-01', platform: 'openai', family: 'codex' }),
    )
    writeCodexAccounts(root, 'vm-codex-01', [
      {
        access_token: jwt({ 'https://api.openai.com/profile': { email: 'existing@example.com' } }),
        refresh_token: 'rt',
      },
    ])
    assert.equal(listVms(root)[0].email, 'existing@example.com')
    assert.equal(readCodexAccounts(root, 'vm-codex-01')[0].email, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('malformed Codex tokens do not produce an email', () => {
  const parsed = parseCodexCredentialInput({ tokens: { access_token: 'not-a-jwt', id_token: 'bad' } })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.email, null)
})

test('parseCodexCredentialInput accepts kernel accounts file', () => {
  const parsed = parseCodexCredentialInput(
    JSON.stringify({
      accounts: [
        {
          id: 'user@example.com',
          access_token: 'at',
          refresh_token: 'rt',
          chatgpt_account_id: 'org-1',
        },
      ],
    }),
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.email, 'user@example.com')
  assert.equal(parsed.account.chatgpt_account_id, 'org-1')
})

test('parseCodexCredentialInput rejects Claude sessionKey JSON', () => {
  const parsed = parseCodexCredentialInput({ session_key: 'sk-ant-sid01-xxx' })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'missing_token')
})

test('parseCodexCredentialInput accepts AT-only paste', () => {
  const parsed = parseCodexCredentialInput('eyJhbGciOiaccess', { mode: 'access_token' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'eyJhbGciOiaccess')
  assert.equal(parsed.account.refresh_token, '')
})

test('parseCodexCredentialInput accepts RT-only paste', () => {
  const parsed = parseCodexCredentialInput('rt-only-1\nrt-ignored', { mode: 'refresh_token' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.refresh_token, 'rt-only-1')
  assert.equal(parsed.account.access_token, '')
  assert.equal(parsed.extra_count, 1)
})

test('parseCodexCredentialInput accepts camelCase credentials object', () => {
  const parsed = parseCodexCredentialInput({
    credentials: { accessToken: 'at-2', refreshToken: 'rt-2', idToken: 'id-2' },
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'at-2')
  assert.equal(parsed.account.refresh_token, 'rt-2')
})

test('parseCodexCredentialInput accepts CPR openai document', () => {
  const parsed = parseCodexCredentialInput({
    documents: [
      { provider: 'xai', document: { refreshToken: 'xai-rt' } },
      { provider: 'openai', document: { accounts: [{ accessToken: 'cpr-at', refreshToken: 'cpr-rt' }] } },
    ],
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'cpr-at')
  assert.equal(parsed.account.refresh_token, 'cpr-rt')
})

test('parseCodexCredentialInput rejects OPENAI_API_KEY-only client config', () => {
  const parsed = parseCodexCredentialInput({ OPENAI_API_KEY: 'sk-proj-not-oauth' })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'not_oauth_account')
})

test('upsertCodexAccount writes credential file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-slot-'))
  fs.mkdirSync(path.join(root, 'vms', 'vm-codex-01'), { recursive: true })
  upsertCodexAccount(root, 'vm-codex-01', {
    access_token: 'at',
    refresh_token: 'rt',
    chatgpt_account_id: 'org-9',
  })
  const accounts = readCodexAccounts(root, 'vm-codex-01')
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].access_token, 'at')
  assert.equal(accounts[0].chatgpt_account_id, 'org-9')
  fs.rmSync(root, { recursive: true, force: true })
})

test('imported Codex account defaults to unlimited kernel concurrency', () => {
  const parsed = parseCodexCredentialInput({
    tokens: { access_token: 'at', refresh_token: 'rt' },
    account_id: 'acc-uuid',
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.max_concurrency, 0)
  assert.equal(parsed.account.rpm, 0)
})

test('invalid credentials leave the pool and new credentials restore only automatic disables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-invalid-'))
  try {
    fs.mkdirSync(path.join(root, 'vms', 'vm-codex-01'), { recursive: true })
    const file = path.join(root, 'vms', 'vm-codex-01.json')
    fs.writeFileSync(
      file,
      JSON.stringify({ id: 'vm-codex-01', platform: 'openai', family: 'codex', schedulable: true }),
    )
    upsertCodexAccount(root, 'vm-codex-01', { access_token: 'old-at', refresh_token: 'old-rt' })
    const version = codexCredentialVersion(readCodexAccounts(root, 'vm-codex-01'))
    persistCodexCredentialState(root, 'vm-codex-01', { state: 'invalid', expectedVersion: version })
    let summary = listVms(root)[0]
    assert.equal(summary.schedulable, false)
    assert.equal(summary.refresh_error, 'oauth_invalid_grant')
    assert.equal(isCodexSlotReady(summary), false)
    assert.equal(evaluateAccount({ vm: summary }).usable, false)
    upsertCodexAccount(root, 'vm-codex-01', { access_token: 'new-at', refresh_token: 'new-rt' })
    assert.equal(persistCodexCredentialState(root, 'vm-codex-01', { state: 'invalid', expectedVersion: version }), null)
    summary = listVms(root)[0]
    assert.equal(summary.schedulable, true)
    assert.equal(summary.refresh_error, null)
    assert.equal(isCodexSlotReady(summary), true)
    const vm = getVm(root, 'vm-codex-01')
    fs.writeFileSync(
      file,
      JSON.stringify({ ...vm, schedulable: false, schedule_manual: true, schedule_disabled_reason: 'disabled' }),
    )
    persistCodexCredentialState(root, 'vm-codex-01', { state: 'invalid' })
    upsertCodexAccount(root, 'vm-codex-01', { access_token: 'newer-at', refresh_token: 'newer-rt' })
    assert.equal(listVms(root)[0].schedulable, false)
    assert.equal(listVms(root)[0].schedule_disabled_reason, 'disabled')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
