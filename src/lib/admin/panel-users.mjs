/**
 * Panel operator accounts: scrypt passwords + admin/super/user roles.
 *
 * Env KIN_ADMIN_USER / KIN_ADMIN_PASSWORD seed the first admin when missing.
 * After that, the database hash is the source of truth (panel can change it).
 */

import crypto from 'node:crypto'
import { resolveStoreDb } from '../db/database.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'
import { clampVmCreateQuota } from './resource-owner.mjs'

export const PANEL_ROLES = ['admin', 'super', 'user']

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 32
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9._-]{1,31}$/

function nowIso() {
  return new Date().toISOString()
}

export function normalizeUsername(username) {
  return String(username || '').trim()
}

export function normalizeRole(role) {
  const r = String(role || '')
    .trim()
    .toLowerCase()
  if (r === 'viewer' || r === 'readonly' || r === '普通') return 'user'
  if (r === '管理员') return 'admin'
  return r
}

export function isPanelRole(role) {
  return PANEL_ROLES.includes(normalizeRole(role))
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

/** scrypt needs ~128*N*r bytes; leave headroom so stored params never trip Node's 32MB default. */
function scryptOptions(N, r, p) {
  return { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r) }
}

/** Async twin of hashPassword (same format), off the main thread. */
export async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16)
  const hash = await scryptAsync(String(password), salt, KEYLEN, scryptOptions(SCRYPT_N, SCRYPT_R, SCRYPT_P))
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

function parseStoredHash(stored) {
  const parts = String(stored || '').split('$')
  if (parts[0] !== 'scrypt' || parts.length !== 6) return null
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return null
  const salt = Buffer.from(parts[4], 'hex')
  const expected = Buffer.from(parts[5], 'hex')
  if (!salt.length || !expected.length) return null
  return { salt, expected, options: scryptOptions(N, r, p) }
}

/** Runs scrypt on the libuv pool so a login flood cannot stall the event loop. */
export async function verifyPassword(password, stored) {
  try {
    const h = parseStoredHash(stored)
    if (!h) return false
    const actual = await scryptAsync(String(password), h.salt, h.expected.length, h.options)
    return actual.length === h.expected.length && crypto.timingSafeEqual(actual, h.expected)
  } catch {
    return false
  }
}

/** Blocking variant for non-login checks; never call it on a path an anonymous client can repeat. */
export function verifyPasswordSync(password, stored) {
  try {
    const h = parseStoredHash(stored)
    if (!h) return false
    const actual = crypto.scryptSync(String(password), h.salt, h.expected.length, h.options)
    return actual.length === h.expected.length && crypto.timingSafeEqual(actual, h.expected)
  } catch {
    return false
  }
}

// Unknown / disabled users still pay one scrypt, so latency does not reveal which names exist.
let dummyHashPromise = null
function dummyPasswordHash() {
  dummyHashPromise ??= hashPasswordAsync(crypto.randomBytes(16).toString('hex')).catch((err) => {
    dummyHashPromise = null
    throw err
  })
  return dummyHashPromise
}

function assertUsername(username) {
  const name = normalizeUsername(username)
  if (!USERNAME_RE.test(name)) {
    const err = new Error('用户名为 2–32 位，需字母开头，仅字母数字 . _ -')
    err.code = 'invalid_username'
    throw err
  }
  return name
}

function assertPassword(password) {
  const pass = String(password ?? '')
  if (pass.length < 8) {
    const err = new Error('密码至少 8 位')
    err.code = 'invalid_password'
    throw err
  }
  if (pass.length > 128) {
    const err = new Error('密码过长')
    err.code = 'invalid_password'
    throw err
  }
  return pass
}

function assertRole(role) {
  const r = normalizeRole(role)
  if (!isPanelRole(r)) {
    const err = new Error('角色必须是 admin / super / user')
    err.code = 'invalid_role'
    throw err
  }
  return r
}

export function publicUserView(rec) {
  if (!rec) return null
  return {
    id: rec.id,
    username: rec.username,
    role: rec.role,
    enabled: rec.enabled !== false,
    vm_create_quota: clampVmCreateQuota(rec.vm_create_quota, 0),
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    last_login_at: rec.last_login_at || null,
  }
}

export class PanelUserStore {
  constructor({ dataDir, db } = {}) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new UsersRepo(this.db)
  }

  rebind(db) {
    this.db = db
    this.repo = new UsersRepo(db)
  }

  list() {
    return this.repo.list().map(publicUserView)
  }

  getById(id) {
    return this.repo.getById(id)
  }

  getByUsername(username) {
    return this.repo.getByUsername(username)
  }

  countEnabledAdmins() {
    return this.repo.countEnabledRole('admin')
  }

  bootstrapFromEnv({ username, password } = {}) {
    const name = normalizeUsername(username)
    if (!name || !password) return null
    const existing = this.repo.getByUsername(name)
    if (existing) return publicUserView(existing)
    // Import the already accepted env credential; new passwords still go through assertPassword.
    return publicUserView(
      this.repo.insert({
        id: crypto.randomUUID(),
        username: assertUsername(name),
        password_hash: hashPassword(password),
        role: 'admin',
        enabled: true,
        vm_create_quota: 0,
        created_at: nowIso(),
        updated_at: nowIso(),
        last_login_at: null,
      }),
    )
  }

  async authenticate(username, password) {
    const rec = this.repo.getByUsername(username)
    const usable = !!rec && rec.enabled !== false
    const ok = await verifyPassword(password, usable ? rec.password_hash : await dummyPasswordHash())
    if (!usable || !ok) return null
    // The record may have changed while scrypt ran (password reset, disable, delete).
    const fresh = this.repo.getById(rec.id)
    if (!fresh || fresh.enabled === false || fresh.password_hash !== rec.password_hash) return null
    const next = { ...fresh, last_login_at: nowIso(), updated_at: fresh.updated_at }
    this.repo.update(next)
    return publicUserView(next)
  }

  create({ username, password, role = 'user', enabled = true, vm_create_quota = 0 } = {}) {
    const name = assertUsername(username)
    if (this.repo.getByUsername(name)) {
      const err = new Error('用户名已存在')
      err.code = 'username_exists'
      throw err
    }
    const rec = {
      id: crypto.randomUUID(),
      username: name,
      password_hash: hashPassword(assertPassword(password)),
      role: assertRole(role),
      enabled: enabled !== false,
      vm_create_quota: clampVmCreateQuota(vm_create_quota, 0),
      created_at: nowIso(),
      updated_at: nowIso(),
      last_login_at: null,
    }
    return this.repo.insert(rec)
  }

  update(id, patch = {}, { actorId = null } = {}) {
    const rec = this.repo.getById(id)
    if (!rec) return null
    const next = { ...rec }

    if (patch.role != null) {
      const role = assertRole(patch.role)
      if (rec.role === 'admin' && role !== 'admin' && this.countEnabledAdmins() <= 1) {
        const err = new Error('不能取消最后一个管理员')
        err.code = 'last_admin'
        throw err
      }
      next.role = role
    }

    if (patch.enabled != null) {
      const enabled = !!patch.enabled
      if (rec.role === 'admin' && rec.enabled && !enabled && this.countEnabledAdmins() <= 1) {
        const err = new Error('不能停用最后一个管理员')
        err.code = 'last_admin'
        throw err
      }
      if (actorId && actorId === rec.id && !enabled) {
        const err = new Error('不能停用当前登录账号')
        err.code = 'self_disable'
        throw err
      }
      next.enabled = enabled
    }

    if (patch.password != null && String(patch.password) !== '') {
      next.password_hash = hashPassword(assertPassword(patch.password))
    }

    if (patch.vm_create_quota != null) {
      next.vm_create_quota = clampVmCreateQuota(patch.vm_create_quota, rec.vm_create_quota || 0)
    }

    next.updated_at = nowIso()
    return this.repo.update(next)
  }

  remove(id, { actorId = null } = {}) {
    const rec = this.repo.getById(id)
    if (!rec) return false
    if (actorId && actorId === rec.id) {
      const err = new Error('不能删除当前登录账号')
      err.code = 'self_delete'
      throw err
    }
    if (rec.role === 'admin' && rec.enabled && this.countEnabledAdmins() <= 1) {
      const err = new Error('不能删除最后一个管理员')
      err.code = 'last_admin'
      throw err
    }
    return this.repo.remove(id)
  }
}
