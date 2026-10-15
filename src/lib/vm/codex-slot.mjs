/**
 * Codex slot metadata. Tokens stay in vms/<id>/codex-credentials.json.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { atomicWriteJson, readJsonCached } from './vm-file.mjs'
import { isCodexVm } from '../protocol/codex-route.mjs'
import { buildCodexUsageView, extraToCodexSnapshot } from '../protocol/codex-usage.mjs'
import { isManualScheduleLocked } from '../pool/schedule-policy.mjs'
import { openaiIdentityFromOauthTokens } from '../oauth/openai-jwt.mjs'

export { isCodexVm }

export function codexCredentialPath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'codex-credentials.json')
}

export function readCodexAccounts(projectRoot, vmId) {
  const file = codexCredentialPath(projectRoot, vmId)
  try {
    const raw = readJsonCached(file)
    return Array.isArray(raw?.accounts) ? raw.accounts : []
  } catch {
    return []
  }
}

export function writeCodexAccounts(projectRoot, vmId, accounts) {
  if (!projectRoot || !vmId) throw new Error('projectRoot and vmId required')
  const next = Array.isArray(accounts) ? accounts : []
  const previous = codexCredentialVersion(readCodexAccounts(projectRoot, vmId))
  atomicWriteJson(
    codexCredentialPath(projectRoot, vmId),
    { accounts: next.map(enrichCodexAccountIdentity) },
    { mode: 0o600 },
  )
  if (previous !== codexCredentialVersion(next)) persistCodexCredentialState(projectRoot, vmId, { state: 'unverified' })
}

export function codexCredentialVersion(accounts = []) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(accounts.map((account) => [account?.access_token || '', account?.refresh_token || ''])))
    .digest('hex')
}

/** A stale probe must never disable a newly imported or rotated credential. */
export function persistCodexCredentialState(
  projectRoot,
  vmId,
  { state, error = null, expectedVersion = null, now = Date.now() } = {},
) {
  const version = codexCredentialVersion(readCodexAccounts(projectRoot, vmId))
  if (expectedVersion && expectedVersion !== version) return null
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  let vm
  try {
    vm = structuredClone(readJsonCached(file))
  } catch {
    return null
  }
  if (!vm?.id) return null
  const codex = { ...(vm.codex || {}) }
  codex.credential_state = state
  codex.credential_version = version
  codex.credential_checked_at = state === 'unverified' ? null : new Date(now).toISOString()
  codex.refresh_error = state === 'invalid' ? error || 'oauth_invalid_grant' : null
  codex.credential_error = error
  codex.credential_retry_at = state === 'needs_refresh' ? new Date(now + 30000).toISOString() : null
  if (state === 'invalid' && !isManualScheduleLocked(vm) && vm.schedulable !== false) {
    vm.schedulable = false
    vm.schedule_disabled_reason = 'oauth_invalid_grant'
    codex.auth_disabled_schedule = true
  } else if (
    (state === 'ready' || state === 'unverified') &&
    codex.auth_disabled_schedule &&
    vm.schedule_disabled_reason === 'oauth_invalid_grant' &&
    !isManualScheduleLocked(vm)
  ) {
    vm.schedulable = true
    vm.schedule_disabled_reason = null
    codex.auth_disabled_schedule = false
  }
  vm.codex = codex
  vm.updated_at = new Date(now).toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}

function tokenPayload(token) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

function emailFromTokens(idToken, accessToken) {
  for (const token of [idToken, accessToken]) {
    const payload = tokenPayload(token)
    const email = firstString(payload?.email, payload?.['https://api.openai.com/profile']?.email)
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email
  }
  return ''
}

function looksLikeClaudeSecret(text) {
  return /^sk-ant-/i.test(String(text || '').trim())
}

const EXPIRY_KEYS = ['expires_at', 'expiresAt', 'expired', 'expire', 'expiry', 'expires']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Number (seconds when < 1e12, else ms), numeric string, or RFC3339/ISO string → epoch ms; invalid → 0. */
export function parseCodexExpiry(value) {
  if (value == null || value === '' || typeof value === 'boolean') return 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0
    return Math.round(value < 1e12 ? value * 1000 : value)
  }
  const text = String(value).trim()
  if (!text) return 0
  if (/^\d+(\.\d+)?$/.test(text)) return parseCodexExpiry(Number(text))
  const ms = Date.parse(text)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

function expiryFromObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0
  for (const key of EXPIRY_KEYS) {
    if (!(key in obj)) continue
    const ms = parseCodexExpiry(obj[key])
    if (ms) return ms
  }
  const expiresIn = Number(obj.expires_in ?? obj.expiresIn)
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    const base = parseCodexExpiry(obj.timestamp) || parseCodexExpiry(obj.last_refresh ?? obj.lastRefresh)
    if (base) return base + Math.round(expiresIn * 1000)
  }
  return 0
}

/** CLIProxyAPI auth-file `type` values that are not Codex/ChatGPT OAuth. */
const NON_CODEX_TYPES = new Set([
  'claude',
  'anthropic',
  'gemini',
  'gemini-cli',
  'aistudio',
  'antigravity',
  'qwen',
  'iflow',
  'kimi',
  'kimi-ai',
  'xai',
  'grok',
  'meta',
  'vertex',
  'devin',
])
const OPENAI_PLATFORMS = new Set(['openai', 'codex', 'chatgpt'])

/** 'openai' | 'other' | 'unknown' — sub2api `platform` / CPR `provider` wins over CPA `type`. */
function importEntryKind(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'unknown'
  const platform = firstString(entry.platform, entry.provider).toLowerCase()
  if (platform) return OPENAI_PLATFORMS.has(platform) ? 'openai' : 'other'
  const type = firstString(typeof entry.type === 'string' ? entry.type : '').toLowerCase()
  if (type === 'codex') return 'openai'
  if (NON_CODEX_TYPES.has(type)) return 'other'
  return 'unknown'
}

function importEntryLabel(entry) {
  return firstString(entry?.platform, entry?.provider, typeof entry?.type === 'string' ? entry.type : '').toLowerCase()
}

/** sub2api API response `{code, data}` and import body `{data, skip_default_group_bind}`. */
function unwrapImportDoc(doc) {
  let current = doc
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) break
    if (Array.isArray(current.accounts) || Array.isArray(current.documents)) break
    const data = current.data
    if (!data || typeof data !== 'object') break
    const ownTokens = ['access_token', 'accessToken', 'refresh_token', 'refreshToken', 'tokens', 'credentials'].some(
      (key) => key in current,
    )
    if (ownTokens) break
    const wrapper = 'code' in current || 'skip_default_group_bind' in current
    if (wrapper || Array.isArray(data) || Array.isArray(data.accounts) || Array.isArray(data.documents) || data.data) {
      current = data
      continue
    }
    break
  }
  return current
}

function extractOauthTokens(value) {
  let access = ''
  let refresh = ''
  let idToken = ''
  const pending = [value]
  const seen = new Set()
  while (pending.length) {
    const current = pending.pop()
    if (!current || typeof current !== 'object') continue
    if (seen.has(current)) continue
    seen.add(current)
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    for (const [key, nested] of Object.entries(current)) {
      if (key === 'accessToken' || key === 'access_token') {
        if (!access) access = firstString(nested)
        continue
      }
      if (key === 'refreshToken' || key === 'refresh_token') {
        if (!refresh) refresh = firstString(nested)
        continue
      }
      if (key === 'idToken' || key === 'id_token') {
        if (!idToken) idToken = firstString(nested)
        continue
      }
      if (nested && typeof nested === 'object') pending.push(nested)
    }
  }
  return { access, refresh, idToken }
}

/**
 * Token-bearing candidates in an import doc. Entries whose sub2api `platform` / CPR `provider` / CPA `type`
 * says they belong to another provider are skipped and counted in `stats.skipped`.
 */
function collectImportCandidates(input, stats = { skipped: 0, kinds: new Set() }) {
  const doc = unwrapImportDoc(input)
  if (!doc || typeof doc !== 'object') return []
  if (Array.isArray(doc.documents)) {
    const out = []
    for (const entry of doc.documents) {
      if (!entry || typeof entry !== 'object') continue
      const provider = String(entry.provider || '')
        .trim()
        .toLowerCase()
      if (provider && provider !== 'openai' && provider !== 'codex') {
        stats.skipped += 1
        stats.kinds?.add(provider)
        continue
      }
      if (entry.document && typeof entry.document === 'object') {
        out.push(...collectImportCandidates(entry.document, stats))
      }
    }
    return out
  }
  const list = Array.isArray(doc) ? doc : Array.isArray(doc.accounts) ? doc.accounts : [doc]
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    if (importEntryKind(item) === 'other') {
      stats.skipped += 1
      const label = importEntryLabel(item)
      if (label) stats.kinds?.add(label)
      continue
    }
    out.push(item)
  }
  return out
}

function isOpenaiApiKeyOnly(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  const apiKey = firstString(doc.OPENAI_API_KEY, doc.openai_api_key, doc.api_key)
  if (!apiKey) return false
  const tokens = extractOauthTokens(doc)
  return !tokens.access && !tokens.refresh
}

function accountFromTokens(source, access, refresh, idToken) {
  const src = source && typeof source === 'object' && !Array.isArray(source) ? source : {}
  const credentials = src.credentials && typeof src.credentials === 'object' ? src.credentials : null
  const nested = credentials || src
  // sub2api account: account-level `expires_at` is the subscription expiry, token expiry lives in credentials.
  const sub2apiAccount = !!credentials && !!firstString(src.platform)
  const chatgptAccountId = firstString(
    src.chatgpt_account_id,
    nested.chatgpt_account_id,
    src.account_id,
    nested.account_id,
    src.accountId,
    nested.accountId,
  )
  const name = firstString(src.name)
  const email = firstString(
    src.email,
    nested.email,
    emailFromTokens(idToken, access),
    EMAIL_RE.test(firstString(nested.id)) ? nested.id : '',
    EMAIL_RE.test(name) ? name : '',
  )
  const expiresAt =
    expiryFromObject(credentials) ||
    (sub2apiAccount ? 0 : expiryFromObject(src)) ||
    expiryFromObject(src.tokens) ||
    expiryFromObject(src.token)
  const planType = firstString(src.plan_type, nested.plan_type, src.planType, nested.planType)
  const rpm = Number(src.rpm ?? nested.rpm)
  const conc = Number(src.max_concurrency ?? nested.max_concurrency ?? (sub2apiAccount ? src.concurrency : undefined))
  const account = enrichCodexAccountIdentity({
    id: email || chatgptAccountId || 'codex',
    access_token: access,
    refresh_token: refresh,
    id_token: idToken,
    expires_at: expiresAt,
    chatgpt_account_id: chatgptAccountId,
    email: email || null,
    plan_type: planType || null,
    rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : 0,
    max_concurrency: Number.isFinite(conc) && conc > 0 ? conc : 0,
  })
  // Older kernel exports used the email as their account id. Other ids are not emails.
  const legacyId = firstString(nested.id)
  if (!account.email && EMAIL_RE.test(legacyId)) account.email = legacyId
  return { ...account, id: account.email || account.chatgpt_account_id || 'codex' }
}

function parseTokenList(text, mode) {
  const tokens = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!tokens.length) return { ok: false, error: 'empty', message: '凭证不能为空' }
  const first = tokens[0]
  if (looksLikeClaudeSecret(first)) {
    return {
      ok: false,
      error: 'credential_kind_mismatch',
      message: '不能导入 Claude 凭证。GPT 槽需要 ChatGPT/Codex OAuth。',
    }
  }
  const access = mode === 'refresh_token' ? '' : first
  const refresh = mode === 'refresh_token' ? first : ''
  if (!access && !refresh) return { ok: false, error: 'missing_token', message: '需要 access_token 或 refresh_token' }
  return {
    ok: true,
    account: accountFromTokens({}, access, refresh, ''),
    extra_count: Math.max(0, tokens.length - 1),
  }
}

/**
 * Parse Codex CLI auth.json, ChatGPT OAuth JSON, CPR openai document, sub2api export (platform=openai),
 * CLIProxyAPI codex auth file, AT/RT paste. Multi-account files import only the first OpenAI account.
 * Does not accept Claude sessionKey / Setup Token / Console API Key / OPENAI_API_KEY-only.
 */
export function parseCodexCredentialInput(input, opts = {}) {
  const mode = String(opts.mode || '')
    .trim()
    .toLowerCase()
  if (PASSWORD_MODES.has(mode)) {
    const lines = parseCodexPasswordLine(typeof input === 'string' ? input : '')
    if (!lines.ok) return lines
    return {
      ok: false,
      error: 'not_implemented',
      message: '账号密码 + 2FA 登录暂未实现，请先用 OAuth 或账号文件导入',
    }
  }
  if (mode === 'access_token' || mode === 'refresh_token') {
    if (typeof input === 'string') return parseTokenList(input, mode)
    const tokens = extractOauthTokens(input)
    const access = mode === 'access_token' ? tokens.access : ''
    const refresh = mode === 'refresh_token' ? tokens.refresh : tokens.refresh
    if (mode === 'access_token' && !tokens.access) {
      return { ok: false, error: 'missing_token', message: '请粘贴 Access Token' }
    }
    if (mode === 'refresh_token' && !tokens.refresh) {
      return { ok: false, error: 'missing_token', message: '请粘贴 Refresh Token' }
    }
    return {
      ok: true,
      account: accountFromTokens(
        input && typeof input === 'object' ? input : {},
        tokens.access,
        tokens.refresh,
        tokens.idToken,
      ),
    }
  }

  let doc = input
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) return { ok: false, error: 'empty', message: '凭证不能为空' }
    try {
      doc = JSON.parse(text)
    } catch {
      return {
        ok: false,
        error: 'invalid_json',
        message: '不是合法 JSON。请上传 auth.json / 账号文件，或改用 AT/RT 粘贴。',
      }
    }
  }
  if (!doc || typeof doc !== 'object') {
    return { ok: false, error: 'invalid_json', message: '需要 ChatGPT/Codex OAuth JSON' }
  }
  if (isOpenaiApiKeyOnly(doc)) {
    return {
      ok: false,
      error: 'not_oauth_account',
      message: 'OPENAI_API_KEY 客户端配置不是 OAuth 账号。请导入 auth.json / AT / RT。',
    }
  }
  const stats = { skipped: 0, kinds: new Set() }
  const candidates = collectImportCandidates(doc, stats)
  const accounts = []
  let claudeSecrets = 0
  for (const candidate of candidates) {
    const tokens = extractOauthTokens(candidate)
    if (!tokens.access && !tokens.refresh) continue
    if (looksLikeClaudeSecret(tokens.access) || looksLikeClaudeSecret(tokens.refresh)) {
      claudeSecrets += 1
      continue
    }
    accounts.push(accountFromTokens(candidate, tokens.access, tokens.refresh, tokens.idToken))
  }
  if (!accounts.length) {
    if (claudeSecrets) {
      return {
        ok: false,
        error: 'credential_kind_mismatch',
        message: '不能导入 Claude 凭证。GPT 槽需要 ChatGPT/Codex OAuth。',
      }
    }
    if (stats.skipped) {
      const kinds = [...stats.kinds].slice(0, 5).join(', ')
      return {
        ok: false,
        error: 'credential_kind_mismatch',
        message: `文件里没有 OpenAI/GPT 账号（需要 sub2api platform=openai 或 CPA type=codex）${kinds ? `，发现的是：${kinds}` : ''}`,
      }
    }
    return {
      ok: false,
      error: 'missing_token',
      message: '需要 ChatGPT/Codex OAuth（access_token 或 refresh_token）。不能导入 Claude 凭证。',
    }
  }
  // One account per slot: the first valid OpenAI account wins, the rest are only counted.
  return {
    ok: true,
    account: accounts[0],
    total_count: accounts.length,
    extra_count: accounts.length - 1,
    skipped_count: stats.skipped + claudeSecrets,
  }
}

const PASSWORD_LINE_SEPARATOR = '----'
const PASSWORD_MODES = new Set(['password', 'account_password'])

/**
 * `email----password----totpSecret` per line (2FA optional). Error messages carry line numbers only,
 * never the secret material.
 */
export function parseCodexPasswordLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
  const accounts = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line) continue
    const parts = line.split(PASSWORD_LINE_SEPARATOR).map((part) => part.trim())
    const where = `第 ${index + 1} 行`
    if (parts.length < 2 || parts.length > 3) {
      return {
        ok: false,
        error: 'invalid_password_line',
        message: `${where}格式不对，应为 邮箱----密码----2FA密钥（2FA 可选）`,
      }
    }
    const [email, password, totp = ''] = parts
    if (!EMAIL_RE.test(email)) {
      return { ok: false, error: 'invalid_password_line', message: `${where}邮箱格式不对` }
    }
    if (!password) return { ok: false, error: 'invalid_password_line', message: `${where}缺少密码` }
    const totpSecret = totp.replace(/[\s-]+/g, '').toUpperCase()
    if (totpSecret && !/^[A-Z2-7]+=*$/.test(totpSecret)) {
      return { ok: false, error: 'invalid_password_line', message: `${where}2FA 密钥应为 Base32` }
    }
    accounts.push({ email, password, totp_secret: totpSecret })
  }
  if (!accounts.length) return { ok: false, error: 'empty', message: '凭证不能为空' }
  return { ok: true, accounts }
}

export function parseCodexImportPayload(body = {}) {
  const mode = String(body.mode || body.import_mode || '')
    .trim()
    .toLowerCase()
  const raw = body.auth_json ?? body.raw ?? body.text ?? body.data
  if (raw != null && raw !== '') return parseCodexCredentialInput(raw, { mode })
  return parseCodexCredentialInput(body, { mode })
}

export function enrichCodexAccountIdentity(account = {}) {
  const next = { ...account }
  const fromTokens = openaiIdentityFromOauthTokens(next)
  if (!firstString(next.email)) next.email = fromTokens.email || null
  if (!firstString(next.chatgpt_account_id)) {
    next.chatgpt_account_id = fromTokens.chatgpt_account_id || null
  }
  return next
}

export function upsertCodexAccount(projectRoot, vmId, patch = {}, { replaceCredentials = false } = {}) {
  const accounts = readCodexAccounts(projectRoot, vmId)
  const previous = { ...(accounts[0] || {}) }
  // Importing another account must not inherit the previous account's tokens or identity.
  // Refreshes still retain metadata when the provider omits it from the response.
  if (replaceCredentials) {
    for (const key of [
      'id',
      'email',
      'chatgpt_account_id',
      'access_token',
      'refresh_token',
      'id_token',
      'expires_at',
    ]) {
      delete previous[key]
    }
  }
  const cur = enrichCodexAccountIdentity({ ...previous, ...patch })
  if (!cur.id) cur.id = cur.email || cur.chatgpt_account_id || 'codex'
  if (!accounts.length) accounts.push(cur)
  else accounts[0] = cur
  writeCodexAccounts(projectRoot, vmId, accounts)
  return cur
}

export function persistCodexQuotaSnapshot(projectRoot, vmId, { extra, resetCredits, planType } = {}) {
  if (!projectRoot || !vmId) throw new Error('projectRoot and vmId required')
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  let vm
  try {
    vm = readJsonCached(file)
  } catch {
    return null
  }
  if (!vm || typeof vm !== 'object') return null
  vm.codex = vm.codex && typeof vm.codex === 'object' ? { ...vm.codex } : {}
  if (extra && typeof extra === 'object') {
    vm.codex.extra = { ...(vm.codex.extra || {}), ...extra }
    vm.codex.usage = buildCodexUsageView(extraToCodexSnapshot(vm.codex.extra))
  }
  const plan = String(planType || '').trim()
  if (plan) vm.codex.plan_type = plan
  if (resetCredits && typeof resetCredits === 'object') {
    vm.codex.reset_credits = {
      available_count: Math.max(0, Number(resetCredits.available_count) || 0),
      credits: Array.isArray(resetCredits.credits)
        ? resetCredits.credits
            .map((row) => ({ expires_at: String(row?.expires_at || '').trim() }))
            .filter((row) => row.expires_at)
        : [],
      fetched_at: resetCredits.fetched_at || new Date().toISOString(),
    }
  }
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

export function summarizeCodexSlot(projectRoot, vm = {}) {
  const accounts = projectRoot && vm?.id ? readCodexAccounts(projectRoot, vm.id) : []
  const first = enrichCodexAccountIdentity(accounts[0] || {})
  const extra = vm.codex?.extra || vm.codex_extra || {}
  // extra is the source of truth; the stored view is only a fallback for slots without extra.
  const usage = buildCodexUsageView(Object.keys(extra).length ? extraToCodexSnapshot(extra) : vm.codex?.usage || {})
  const hasAccess = !!(first.access_token || vm.codex?.has_access)
  const hasRefresh = !!(first.refresh_token || vm.codex?.has_refresh)
  const replaced =
    projectRoot && vm.codex?.credential_version && vm.codex.credential_version !== codexCredentialVersion(accounts)
  const state = replaced ? 'unverified' : vm.codex?.credential_state || 'unverified'
  return {
    platform: 'openai',
    family: 'codex',
    has_token: hasAccess || hasRefresh,
    has_refresh: hasRefresh,
    credential_state: state,
    credential_checked_at: replaced ? null : vm.codex?.credential_checked_at || null,
    credential_retry_at: replaced ? null : vm.codex?.credential_retry_at || null,
    refresh_error: state === 'invalid' ? vm.codex?.refresh_error || 'oauth_invalid_grant' : null,
    credential_replaced: !!replaced,
    email: emailFromTokens(first.id_token, first.access_token) || first.email || vm.codex?.email || vm.email || null,
    expires_at: first.expires_at || vm.codex?.expires_at || null,
    chatgpt_account_id: first.chatgpt_account_id || vm.codex?.chatgpt_account_id || null,
    account_count: accounts.length,
    usage,
    reset_credits: vm.codex?.reset_credits || null,
    plan_type: vm.codex?.plan_type || null,
  }
}
