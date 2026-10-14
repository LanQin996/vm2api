import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { canReuseRemoteEgress, remoteEgressContainer } from '../../src/lib/cluster/remote-slot.mjs'

const base = {
  vmId: 'vm-01',
  proxyId: 'px-1',
  dir: '/root/.vm2api/slots/vm-01/egress',
  imageRef: 'kin-os-ubuntu:24.04',
  body: '{"proxy_id":"px-1"}\n',
}

test('a root login runs the helper as root, the owner of its 0600 config', () => {
  const { spec } = remoteEgressContainer({ ...base, host: { uid: 0, gid: 0 } })
  assert.equal(spec.User, '0:0')
  // uid 0 inside has no capabilities to escalate with.
  assert.deepEqual(spec.HostConfig.CapDrop, ['ALL'])
  assert.deepEqual(spec.HostConfig.SecurityOpt, ['no-new-privileges'])
  assert.equal(spec.HostConfig.ReadonlyRootfs, true)
})

test('a non-root login runs the helper as the SSH user', () => {
  const { spec } = remoteEgressContainer({ ...base, host: { uid: 1000, gid: 1001 } })
  assert.equal(spec.User, '1000:1001')
})

test('the user is part of the digest, so helpers from the old spec are rebuilt', () => {
  const root = remoteEgressContainer({ ...base, host: { uid: 0, gid: 0 } })
  const user = remoteEgressContainer({ ...base, host: { uid: 1000, gid: 1000 } })
  assert.notEqual(root.digest, user.digest)
  assert.equal(root.spec.Labels['kin.egress.cfg'], root.digest)
  // The pre-fix label hashed only body + image; a node upgraded in place must not match it.
  const legacy = crypto.createHash('sha256').update(base.body).update(base.imageRef).digest('hex').slice(0, 16)
  assert.notEqual(root.digest, legacy)
  const crashLooping = { State: { Running: true, Restarting: true }, Config: { Labels: { 'kin.egress.cfg': legacy } } }
  assert.equal(canReuseRemoteEgress(crashLooping, root.digest), false)
})

test('only a healthy helper with the current digest is kept', () => {
  const { digest } = remoteEgressContainer({ ...base, host: { uid: 0, gid: 0 } })
  const labels = { 'kin.egress.cfg': digest }
  assert.equal(canReuseRemoteEgress({ State: { Running: true }, Config: { Labels: labels } }, digest), true)
  // Docker reports a crash loop as Running + Restarting.
  assert.equal(
    canReuseRemoteEgress({ State: { Running: true, Restarting: true }, Config: { Labels: labels } }, digest),
    false,
  )
  assert.equal(canReuseRemoteEgress({ State: { Running: false }, Config: { Labels: labels } }, digest), false)
  assert.equal(
    canReuseRemoteEgress({ State: { Running: true }, Config: { Labels: { 'kin.egress.cfg': 'old' } } }, digest),
    false,
  )
  assert.equal(canReuseRemoteEgress(null, digest), false)
})
