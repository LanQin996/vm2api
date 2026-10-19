import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('directory mount sees replaced bin files; pinned single-file inode does not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bin-mount-'))
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const worker = path.join(binDir, 'kin-worker')
  fs.writeFileSync(worker, 'v1')
  const pinned = path.join(root, 'pinned-inode')
  fs.linkSync(worker, pinned)
  fs.unlinkSync(worker)
  fs.writeFileSync(worker, 'v2')
  assert.equal(fs.readFileSync(path.join(binDir, 'kin-worker'), 'utf8'), 'v2')
  assert.equal(fs.readFileSync(pinned, 'utf8'), 'v1')
  fs.rmSync(root, { recursive: true, force: true })
})
