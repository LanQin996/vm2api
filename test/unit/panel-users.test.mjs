import test from 'node:test'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import {
  PanelUserStore,
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  publicUserView,
} from '../../src/lib/admin/panel-users.mjs'

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-users-'))
  const db = createDatabase({ dataDir: dir })
  return { dir, db, store: new PanelUserStore({ db, projectRoot: dir }) }
}

test('scrypt hash verifies and is not reversible', async () => {
  const hashed = hashPassword('correct-horse')
  assert.match(hashed, /^scrypt\$/)
  assert.equal(await verifyPassword('correct-horse', hashed), true)
  assert.equal(await verifyPassword('wrong-pass', hashed), false)
  assert.doesNotMatch(hashed, /correct-horse/)
})

test('bootstrap seeds env admin once', async () => {
  const { store } = tmpStore()
  const first = store.bootstrapFromEnv({ username: 'admin', password: 'testpass1' })
  const second = store.bootstrapFromEnv({ username: 'admin', password: 'otherpass' })
  assert.equal(first.username, 'admin')
  assert.equal(first.role, 'admin')
  assert.equal(second.id, first.id)
  assert.ok(await store.authenticate('admin', 'testpass1'))
  assert.equal(await store.authenticate('admin', 'otherpass'), null)
})

test('bootstrap imports legacy env passwords without relaxing user password validation', async () => {
  const { store } = tmpStore()
  for (const [username, password] of [
    ['admin', '123456'],
    ['legacy', 'short'],
  ]) {
    const admin = store.bootstrapFromEnv({ username, password })
    assert.equal(admin.role, 'admin')
    assert.equal(admin.enabled, true)
    assert.equal(admin.password_hash, undefined)
    assert.ok(store.list().some((user) => user.id === admin.id))
    assert.ok(await store.authenticate(username, password))
    assert.notEqual(store.getById(admin.id).password_hash, password)
    assert.throws(() => store.update(admin.id, { password: 'short' }), /密码至少 8 位/)

    store.update(admin.id, { password: 'changed-admin-pass' })
    const again = store.bootstrapFromEnv({ username, password })
    assert.equal(again.id, admin.id)
    assert.equal(await store.authenticate(username, password), null)
    assert.ok(await store.authenticate(username, 'changed-admin-pass'))
  }
  assert.throws(() => store.create({ username: 'reader', password: '123456' }), /密码至少 8 位/)
})

test('bootstrap preserves disabled admins and validates usernames', async () => {
  const { store } = tmpStore()
  store.create({ username: 'owner', password: 'owner-pass', role: 'admin' })
  const admin = store.create({ username: 'admin', password: 'admin-pass', role: 'admin', enabled: false })
  const imported = store.bootstrapFromEnv({ username: 'admin', password: '123456' })
  assert.equal(imported.id, admin.id)
  assert.equal(imported.enabled, false)
  assert.equal(await store.authenticate('admin', '123456'), null)
  assert.equal(store.bootstrapFromEnv({ username: 'empty', password: '' }), null)
  assert.throws(() => store.bootstrapFromEnv({ username: '1bad', password: '123456' }), /用户名/)
})

test('create / authenticate / change password / roles', async () => {
  const { store } = tmpStore()
  store.bootstrapFromEnv({ username: 'admin', password: 'adminpass' })
  const viewer = store.create({ username: 'reader', password: 'reader-pass', role: 'user' })
  const superu = store.create({ username: 'ops', password: 'super-pass', role: 'super' })
  assert.equal(viewer.role, 'user')
  assert.equal(superu.role, 'super')
  assert.equal((await store.authenticate('reader', 'reader-pass')).role, 'user')
  assert.equal(await store.authenticate('ops', 'wrong-pass'), null)

  const updated = store.update(viewer.id, { password: 'reader-next' })
  assert.equal(await store.authenticate('reader', 'reader-pass'), null)
  assert.ok(await store.authenticate('reader', 'reader-next'))
  assert.equal(publicUserView(updated).password_hash, undefined)
})

test('cannot remove or demote the last admin', () => {
  const { store } = tmpStore()
  const admin = store.create({ username: 'admin', password: 'adminpass', role: 'admin' })
  assert.throws(() => store.update(admin.id, { role: 'user' }), /最后一个管理员/)
  assert.throws(() => store.update(admin.id, { enabled: false }), /最后一个管理员/)
  assert.throws(() => store.remove(admin.id), /最后一个管理员/)
})

test('rejects bad username / short password / unknown role', () => {
  const { store } = tmpStore()
  assert.throws(() => store.create({ username: '1bad', password: 'longenough', role: 'user' }), /用户名/)
  assert.throws(() => store.create({ username: 'okuser', password: 'short', role: 'user' }), /密码/)
  assert.throws(() => store.create({ username: 'okuser', password: 'longenough', role: 'root' }), /角色/)
})

test('async hash shares the sync format and verify never blocks on scryptSync', async () => {
  const hashed = await hashPasswordAsync('async-horse')
  assert.match(hashed, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  const pending = verifyPassword('async-horse', hashed)
  assert.ok(pending instanceof Promise)
  assert.equal(await pending, true)
  assert.equal(await verifyPassword('async-horsf', hashed), false)
  assert.equal(await verifyPassword('x', 'scrypt$bad'), false)
  assert.equal(await verifyPassword('x', ''), false)
})

test('unknown and disabled users return null after paying for a hash', async (t) => {
  const { store } = tmpStore()
  store.create({ username: 'admin', password: 'adminpass', role: 'admin' })
  const off = store.create({ username: 'sleeper', password: 'sleeper-pass', role: 'user' })
  store.update(off.id, { enabled: false })
  const scrypt = t.mock.method(crypto, 'scrypt')
  assert.equal(await store.authenticate('ghost', 'whatever-pass'), null)
  assert.equal(await store.authenticate('sleeper', 'sleeper-pass'), null)
  // dummy hash (once) + one verify per attempt
  assert.ok(scrypt.mock.callCount() >= 2, `scrypt calls: ${scrypt.mock.callCount()}`)
  const before = scrypt.mock.callCount()
  assert.equal(await store.authenticate('ghost', 'again-pass'), null)
  assert.equal(scrypt.mock.callCount(), before + 1)
})

test('authenticate rejects when the password changed while scrypt ran', async () => {
  const { store } = tmpStore()
  const rec = store.create({ username: 'racer', password: 'racer-pass', role: 'admin' })
  const pending = store.authenticate('racer', 'racer-pass')
  store.update(rec.id, { password: 'racer-next' })
  assert.equal(await pending, null)
  const ok = await store.authenticate('racer', 'racer-next')
  assert.equal(ok.username, 'racer')
  assert.ok(store.getById(rec.id).last_login_at)
})

function seedOwnedVm(project, id, owner, extra = {}) {
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const vm = {
    id,
    owner_user_id: owner,
    origin: 'admin_assigned',
    status: 'running',
    schedulable: false,
    schedule_disabled_reason: 'disabled',
    claude: { has_access: true, has_refresh: true },
    ...extra,
  }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(vm))
  return vm
}

test('deleting a user reclaims assigned VMs while preserving private and unrelated slots', (t) => {
  const { dir, db, store } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const user = store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  seedOwnedVm(dir, 'legacy', user.id, { origin: undefined })
  const privateVm = seedOwnedVm(dir, 'private', user.id, { origin: 'user_created' })
  const otherVm = seedOwnedVm(dir, 'other', 'another-tenant')
  const publicVm = seedOwnedVm(dir, 'public', null, { origin: 'platform' })

  assert.equal(store.remove(user.id), true)
  assert.equal(store.getById(user.id), null)
  const read = (id) => JSON.parse(fs.readFileSync(path.join(dir, 'vms', `${id}.json`), 'utf8'))
  const reclaimed = read('assigned')
  assert.equal(reclaimed.owner_user_id, null)
  assert.equal(reclaimed.origin, 'platform')
  const { updated_at, ...rest } = reclaimed
  assert.ok(updated_at)
  assert.deepEqual(rest, { ...assigned, owner_user_id: null, origin: 'platform' })
  assert.equal(read('legacy').owner_user_id, null)
  assert.equal(read('legacy').origin, 'platform')
  assert.deepEqual(read('private'), privateVm)
  assert.deepEqual(read('other'), otherVm)
  assert.deepEqual(read('public'), publicVm)
})

test('rejected user deletions leave assigned VMs with their owners', (t) => {
  const { dir, db, store } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const admin = store.create({ username: 'admin', password: 'admin-pass', role: 'admin' })
  const user = store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  const adminVm = seedOwnedVm(dir, 'admin-vm', admin.id)

  assert.throws(() => store.remove(user.id, { actorId: user.id }), /不能删除当前登录账号/)
  assert.throws(() => store.remove(admin.id), /最后一个管理员/)
  assert.equal(store.remove('missing-user'), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'assigned.json'), 'utf8')), assigned)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'admin-vm.json'), 'utf8')), adminVm)
})

test('a VM write failure does not soft-delete the user', (t) => {
  const { dir, db, store } = tmpStore()
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const user = store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('simulated VM write failure')
  })

  assert.throws(() => store.remove(user.id), /simulated VM write failure/)
  assert.ok(store.getById(user.id))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'assigned.json'), 'utf8')), assigned)
})
