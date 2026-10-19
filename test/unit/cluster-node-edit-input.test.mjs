import test from 'node:test'
import assert from 'node:assert/strict'
import ssh2 from 'ssh2'
import { parseNodeInput } from '../../src/lib/cluster/cluster-manager.mjs'
import { mergeNodeEdit } from '../../src/lib/cluster/node-edit.mjs'

const encryptedKey = ssh2.utils
  .generateKeyPairSync('ecdsa', {
    bits: 256,
    cipher: 'aes256-cbc',
    passphrase: 'original-passphrase',
  })
  .private.trim()
const plainKey = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private.trim()

function fixture(input = {}) {
  const { password, private_key, passphrase, ...node } = parseNodeInput(
    {
      host: 'node.example.test',
      port: 2222,
      username: 'operator',
      label: 'Node A',
      auth_type: 'password',
      password: 'original-password',
      host_key_alg: 'ssh-ed25519',
      host_key_sha256: `SHA256:${'A'.repeat(43)}`,
      jump_node_id: 'node-jump',
      ...input,
    },
    { requireHostKey: true },
  )
  return {
    node: { ...node, id: 'node-a', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z' },
    secrets: { password, privateKey: private_key, passphrase },
  }
}

function edit(saved, patch) {
  const next = mergeNodeEdit(saved.node, saved.secrets, { expected_updated_at: saved.node.updated_at, ...patch })
  return { normalized: parseNodeInput(next, { requireHostKey: true }) }
}

function keyFixture() {
  return fixture({ auth_type: 'key', private_key: encryptedKey, passphrase: 'original-passphrase' })
}

test('node edits reject unknown fields and changes to identity, jump node or pinned host key', () => {
  const saved = fixture()
  for (const field of [
    'unknown',
    'id',
    'created_at',
    'updated_at',
    'jump_node_id',
    'host_key_alg',
    'host_key_sha256',
  ]) {
    assert.throws(() => edit(saved, { [field]: 'replacement' }), { code: 'invalid_node_patch', status: 400 }, field)
  }
  for (const patch of [null, undefined, [], 'name', 42]) {
    assert.throws(() => mergeNodeEdit(saved.node, saved.secrets, patch), { code: 'invalid_node_patch' })
  }
})

test('node edits require the exact saved configuration version before merging fields', () => {
  const saved = fixture()
  for (const version of [undefined, '', null, 123]) {
    assert.throws(() => edit(saved, { expected_updated_at: version }), { code: 'invalid_node_patch', status: 400 })
  }
  assert.throws(() => edit(saved, { expected_updated_at: '2026-10-17T00:00:00.000Z', label: 'Stale rename' }), {
    code: 'node_edit_conflict',
    status: 409,
  })
  assert.equal(edit(saved, { label: 'Current rename' }).normalized.label, 'Current rename')
})

test('merging metadata preserves omitted credentials without mutating its inputs', () => {
  for (const saved of [fixture(), keyFixture()]) {
    const original = structuredClone(saved)
    const patch = Object.freeze({ label: ' Renamed node ' })
    const { normalized } = edit(saved, patch)
    assert.equal(normalized.label, 'Renamed node')
    assert.equal(normalized.password, saved.secrets.password)
    assert.equal(normalized.private_key, saved.secrets.privateKey)
    assert.equal(normalized.passphrase, saved.secrets.passphrase)
    assert.equal(normalized.jump_node_id, saved.node.jump_node_id)
    assert.equal(normalized.host_key_sha256, saved.node.host_key_sha256)
    assert.deepEqual(saved, original)
  }
})

test('an explicitly empty password or private key is rejected instead of silently keeping the saved secret', () => {
  assert.throws(() => edit(fixture(), { password: '' }), { code: 'missing_password' })
  assert.throws(() => edit(keyFixture(), { private_key: '' }), { code: 'missing_private_key' })
  assert.throws(() => edit(keyFixture(), { private_key: '   ' }), { code: 'missing_private_key' })
  for (const [saved, field] of [
    [fixture(), 'password'],
    [keyFixture(), 'private_key'],
    [keyFixture(), 'passphrase'],
  ]) {
    assert.throws(() => edit(saved, { [field]: null }), { code: 'invalid_node_patch' })
  }
})

test('switching from password to key requires a newly submitted key and removes the password', () => {
  const saved = fixture()
  saved.secrets.privateKey = plainKey
  for (const patch of [{ auth_type: 'key' }, { auth_type: 'key', private_key: '' }]) {
    assert.throws(() => edit(saved, patch), { code: 'missing_private_key' })
  }
  const { normalized } = edit(saved, { auth_type: 'key', private_key: plainKey })
  assert.equal(normalized.auth_type, 'key')
  assert.equal(normalized.private_key, plainKey)
  assert.equal(normalized.password, null)
  assert.equal(normalized.passphrase, null)
})

test('switching from key to password requires a newly submitted password and removes the key and passphrase', () => {
  const saved = keyFixture()
  saved.secrets.password = 'inactive-old-password'
  for (const patch of [{ auth_type: 'password' }, { auth_type: 'password', password: '' }]) {
    assert.throws(() => edit(saved, patch), { code: 'missing_password' })
  }
  const { normalized } = edit(saved, { auth_type: 'password', password: 'replacement-password' })
  assert.equal(normalized.password, 'replacement-password')
  assert.equal(normalized.private_key, null)
  assert.equal(normalized.passphrase, null)
})

test('a replacement key does not inherit the previous key passphrase', () => {
  const saved = keyFixture()
  const { normalized } = edit(saved, { private_key: plainKey })
  assert.equal(normalized.private_key, plainKey)
  assert.equal(normalized.passphrase, null)

  const replacement = ssh2.utils
    .generateKeyPairSync('ecdsa', {
      bits: 256,
      cipher: 'aes256-cbc',
      passphrase: 'original-passphrase',
    })
    .private.trim()
  assert.throws(() => edit(saved, { private_key: replacement }), { code: 'invalid_private_key' })
  assert.equal(
    edit(saved, { private_key: replacement, passphrase: 'original-passphrase' }).normalized.private_key,
    replacement,
  )
})

test('resubmitting the same key, or omitting it, retains its passphrase for verification', () => {
  const saved = keyFixture()
  for (const patch of [{}, { private_key: encryptedKey }, { private_key: `\n${encryptedKey}\n` }]) {
    const { normalized } = edit(saved, patch)
    assert.equal(normalized.private_key, encryptedKey)
    assert.equal(normalized.passphrase, 'original-passphrase')
  }
})

test('an explicit empty passphrase clears it for an unencrypted key but cannot unlock an encrypted key', () => {
  const saved = fixture({ auth_type: 'key', private_key: plainKey, passphrase: 'unused-passphrase' })
  const { normalized } = edit(saved, { passphrase: '' })
  assert.equal(normalized.passphrase, null)
  assert.throws(() => edit(keyFixture(), { passphrase: '' }), { code: 'invalid_private_key' })
  assert.throws(() => edit(keyFixture(), { passphrase: 'wrong-passphrase' }), { code: 'invalid_private_key' })
})

test('node edits reject inactive authentication fields and non-string secrets', () => {
  for (const patch of [{ private_key: plainKey }, { passphrase: '' }, { password: 123 }, { auth_type: 'agent' }]) {
    assert.throws(() => edit(fixture(), patch), {
      code: patch.auth_type ? 'invalid_auth_type' : 'invalid_node_patch',
    })
  }
  assert.throws(() => edit(keyFixture(), { password: '' }), { code: 'invalid_node_patch' })
  for (const port of [null, false, {}]) {
    assert.throws(() => edit(fixture(), { port }), { code: 'invalid_port' })
  }
})

test('endpoint fields are normalized before candidate verification', () => {
  const saved = fixture()
  const { normalized } = edit(saved, {
    host: ` ${saved.node.host} `,
    username: ` ${saved.node.username} `,
    port: String(saved.node.port),
  })
  assert.equal(normalized.host, saved.node.host)
  assert.equal(normalized.username, saved.node.username)
  assert.equal(normalized.port, saved.node.port)
})
