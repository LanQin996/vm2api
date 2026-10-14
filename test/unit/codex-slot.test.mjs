import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  enrichCodexAccountIdentity,
  parseCodexCredentialInput,
  parseCodexImportPayload,
  parseCodexPasswordLine,
  parseCodexExpiry,
  upsertCodexAccount,
  readCodexAccounts,
  writeCodexAccounts,
  persistCodexCredentialState,
  codexCredentialVersion,
  summarizeCodexSlot,
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

test('enrichCodexAccountIdentity extracts email from OAuth id_token', () => {
  const idToken = jwt({ email: 'gpt-user@example.com', sub: 'sub-1' })
  const accessToken = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'chatgpt-acc-9' },
  })
  const enriched = enrichCodexAccountIdentity({
    access_token: accessToken,
    refresh_token: 'rt',
    id_token: idToken,
  })
  assert.equal(enriched.email, 'gpt-user@example.com')
  assert.equal(enriched.chatgpt_account_id, 'chatgpt-acc-9')
})

test('upsertCodexAccount persists identity for panel summarizeCodexSlot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-oauth-id-'))
  const vmId = 'vm-codex-oauth'
  fs.mkdirSync(path.join(root, 'vms', vmId), { recursive: true })
  const idToken = jwt({ email: 'panel@example.com' })
  upsertCodexAccount(root, vmId, {
    access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-panel' } }),
    refresh_token: 'rt',
    id_token: idToken,
  })
  const summary = summarizeCodexSlot(root, {
    id: vmId,
    platform: 'openai',
    family: 'codex',
    codex: { has_access: true },
  })
  assert.equal(summary.email, 'panel@example.com')
  assert.equal(summary.chatgpt_account_id, 'acc-panel')
  fs.rmSync(root, { recursive: true, force: true })
})

test('enrichCodexAccountIdentity does not crash on invalid jwt', () => {
  const enriched = enrichCodexAccountIdentity({ access_token: 'bad-token', id_token: 'also-bad' })
  assert.equal(enriched.email, null)
  assert.equal(enriched.chatgpt_account_id, null)
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

function sub2apiAccount(overrides = {}, credentials = {}) {
  return {
    name: 'user@example.com',
    platform: 'openai',
    type: 'oauth',
    credentials: {
      access_token: 'sub2api-at',
      refresh_token: 'rt_sub2api',
      id_token: 'sub2api-id',
      expires_at: '2026-10-24T03:00:00+08:00',
      email: 'user@example.com',
      chatgpt_account_id: '3f1c-uuid',
      plan_type: 'plus',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      ...credentials,
    },
    extra: {},
    proxy_key: 'socks5|1.2.3.4|1080|u|p',
    concurrency: 3,
    priority: 50,
    expires_at: 1790000000,
    auto_pause_on_expired: true,
    ...overrides,
  }
}

function sub2apiExport(accounts) {
  return { exported_at: '2026-10-14T03:00:00Z', proxies: [], accounts }
}

test('parseCodexExpiry handles seconds, ms, numeric strings, RFC3339 and garbage', () => {
  assert.equal(parseCodexExpiry(1790000000), 1790000000000)
  assert.equal(parseCodexExpiry(1790000000123), 1790000000123)
  assert.equal(parseCodexExpiry('1790000000'), 1790000000000)
  assert.equal(parseCodexExpiry('2026-10-24T03:00:00+08:00'), Date.UTC(2026, 9, 23, 19, 0, 0))
  assert.equal(parseCodexExpiry('not a date'), 0)
  assert.equal(parseCodexExpiry(''), 0)
  assert.equal(parseCodexExpiry(null), 0)
  assert.equal(parseCodexExpiry(-5), 0)
})

test('sub2api export: RFC3339 credentials expiry, ids, plan and concurrency', () => {
  const parsed = parseCodexCredentialInput(JSON.stringify(sub2apiExport([sub2apiAccount()])))
  assert.equal(parsed.ok, true)
  const account = parsed.account
  assert.equal(account.access_token, 'sub2api-at')
  assert.equal(account.refresh_token, 'rt_sub2api')
  assert.equal(account.id_token, 'sub2api-id')
  // credentials.expires_at, not the account-level subscription expiry (1790000000).
  assert.equal(account.expires_at, Date.UTC(2026, 9, 23, 19, 0, 0))
  assert.equal(account.chatgpt_account_id, '3f1c-uuid')
  assert.equal(account.email, 'user@example.com')
  assert.equal(account.plan_type, 'plus')
  assert.equal(account.max_concurrency, 3)
  assert.equal(parsed.total_count, 1)
  assert.equal(parsed.extra_count, 0)
  assert.equal(parsed.skipped_count, 0)
})

test('sub2api export: numeric seconds and numeric-string expiry', () => {
  const numeric = parseCodexCredentialInput(sub2apiExport([sub2apiAccount({}, { expires_at: 1761246000 })]))
  assert.equal(numeric.account.expires_at, 1761246000000)
  const text = parseCodexCredentialInput(sub2apiExport([sub2apiAccount({}, { expires_at: '1761246000' })]))
  assert.equal(text.account.expires_at, 1761246000000)
  const missing = parseCodexCredentialInput(sub2apiExport([sub2apiAccount({}, { expires_at: undefined })]))
  assert.equal(missing.account.expires_at, 0)
})

test('sub2api export: mixed platforms pick the first OpenAI account and count the rest', () => {
  const parsed = parseCodexCredentialInput(
    sub2apiExport([
      { name: 'claude', platform: 'anthropic', type: 'oauth', credentials: { access_token: 'sk-ant-oat01-x' } },
      { name: 'gem', platform: 'gemini', type: 'oauth', credentials: { access_token: 'ya29.x', refresh_token: 'g' } },
      sub2apiAccount(),
      sub2apiAccount({ name: 'second@example.com' }, { access_token: 'at-2', email: 'second@example.com' }),
    ]),
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'sub2api-at')
  assert.equal(parsed.account.email, 'user@example.com')
  assert.equal(parsed.total_count, 2)
  assert.equal(parsed.extra_count, 1)
  assert.equal(parsed.skipped_count, 2)
})

test('sub2api export without OpenAI accounts is a kind mismatch', () => {
  const parsed = parseCodexCredentialInput(
    sub2apiExport([
      {
        name: 'claude',
        platform: 'anthropic',
        type: 'oauth',
        credentials: { access_token: 'oat', refresh_token: 'rt' },
      },
    ]),
  )
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'credential_kind_mismatch')
  assert.match(parsed.message, /OpenAI/)
})

test('sub2api API response and import body wrappers are unwrapped', () => {
  const payload = sub2apiExport([sub2apiAccount()])
  const api = parseCodexCredentialInput(JSON.stringify({ code: 0, message: 'success', data: payload }))
  assert.equal(api.ok, true)
  assert.equal(api.account.access_token, 'sub2api-at')
  const body = parseCodexCredentialInput({ data: payload, skip_default_group_bind: true })
  assert.equal(body.ok, true)
  assert.equal(body.account.chatgpt_account_id, '3f1c-uuid')
  const viaRoute = parseCodexImportPayload({
    vm_id: 'vm-1',
    type: 'codex',
    mode: 'json',
    auth_json: JSON.stringify({ code: 0, data: payload }),
  })
  assert.equal(viaRoute.ok, true)
  assert.equal(viaRoute.account.max_concurrency, 3)
})

test('CLIProxyAPI codex auth file maps expired, account_id, email and plan_type', () => {
  const parsed = parseCodexCredentialInput(
    JSON.stringify({
      id_token: 'cpa-id',
      access_token: 'cpa-at',
      refresh_token: 'rt_cpa',
      account_id: '3f1c-uuid',
      last_refresh: '2026-10-14T11:00:00+08:00',
      email: 'cpa@example.com',
      type: 'codex',
      expired: '2026-10-24T11:00:00+08:00',
      plan_type: 'plus',
    }),
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'cpa-at')
  assert.equal(parsed.account.refresh_token, 'rt_cpa')
  assert.equal(parsed.account.expires_at, Date.UTC(2026, 9, 24, 3, 0, 0))
  assert.equal(parsed.account.chatgpt_account_id, '3f1c-uuid')
  assert.equal(parsed.account.email, 'cpa@example.com')
  assert.equal(parsed.account.plan_type, 'plus')
  assert.equal(parsed.extra_count, 0)
})

test('CLIProxyAPI expires_in + timestamp computes expiry', () => {
  const parsed = parseCodexCredentialInput({
    type: 'codex',
    access_token: 'at',
    expires_in: 3600,
    timestamp: 1760000000000,
  })
  assert.equal(parsed.account.expires_at, 1760000000000 + 3600 * 1000)
})

test('CLIProxyAPI claude and gemini auth files are rejected for a GPT slot', () => {
  const claude = parseCodexCredentialInput({
    type: 'claude',
    access_token: 'oat-claude',
    refresh_token: 'rt-claude',
    email: 'c@example.com',
    expired: '2026-10-24T11:00:00+08:00',
  })
  assert.equal(claude.ok, false)
  assert.equal(claude.error, 'credential_kind_mismatch')
  const gemini = parseCodexCredentialInput({
    type: 'gemini',
    email: 'g@example.com',
    token: { access_token: 'ya29.x', refresh_token: '1//x', expiry: '2026-10-24T11:00:00Z' },
  })
  assert.equal(gemini.ok, false)
  assert.equal(gemini.error, 'credential_kind_mismatch')
})

test('array of CPA files skips non-codex entries', () => {
  const parsed = parseCodexCredentialInput([
    { type: 'claude', access_token: 'c-at' },
    { type: 'codex', access_token: 'x-at', email: 'x@example.com' },
  ])
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'x-at')
  assert.equal(parsed.skipped_count, 1)
})

test('parseCodexPasswordLine parses email----password----2FA lines', () => {
  const parsed = parseCodexPasswordLine(' a@example.com----p@ss----jbsw y3dp \n\nb@example.com----pw2\r\n')
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.accounts, [
    { email: 'a@example.com', password: 'p@ss', totp_secret: 'JBSWY3DP' },
    { email: 'b@example.com', password: 'pw2', totp_secret: '' },
  ])
  assert.equal(parseCodexPasswordLine('').error, 'empty')
  const badEmail = parseCodexPasswordLine('not-an-email----secretpw')
  assert.equal(badEmail.ok, false)
  assert.equal(badEmail.error, 'invalid_password_line')
  assert.doesNotMatch(badEmail.message, /secretpw/)
  assert.equal(parseCodexPasswordLine('a@example.com').error, 'invalid_password_line')
  assert.equal(parseCodexPasswordLine('a@example.com----').error, 'invalid_password_line')
})

test('password mode validates the format and reports not_implemented', () => {
  const pending = parseCodexImportPayload({ mode: 'password', auth_json: 'a@example.com----pw----JBSWY3DP' })
  assert.equal(pending.ok, false)
  assert.equal(pending.error, 'not_implemented')
  const alias = parseCodexCredentialInput('a@example.com----pw', { mode: 'account_password' })
  assert.equal(alias.error, 'not_implemented')
  const invalid = parseCodexCredentialInput('nope', { mode: 'password' })
  assert.equal(invalid.error, 'invalid_password_line')
})
