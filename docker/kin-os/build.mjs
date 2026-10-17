#!/usr/bin/env node
/**
 * Guest image provisioning: pull the prebuilt kin-os images, fall back to the
 * in-repo Dockerfiles. `--pull-only` never builds (boot prewarm must not block
 * on apt; the slot start path builds lazily).
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OS_CATALOG } from '../../src/lib/vm/os-catalog.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const force = args.includes('--force')
const pullOnly = args.includes('--pull-only')
const pull = pullOnly || args.includes('--pull')
const only = args.filter((a) => !a.startsWith('--'))

function imageExists(tag) {
  return spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0
}

for (const [kernel, meta] of Object.entries(OS_CATALOG)) {
  if (only.length && !only.some((arg) => kernel.includes(arg) || meta.dir.includes(arg) || meta.family === arg)) continue
  // Tags are mutable: --pull refreshes an existing image so guest fixes reach cached hosts.
  if (pull && spawnSync('docker', ['pull', meta.image], { stdio: 'inherit' }).status === 0) continue
  if (!force && imageExists(meta.image)) {
    console.log(`vm2api: keep existing ${meta.image}`)
    continue
  }
  if (pullOnly) {
    console.warn(`vm2api: ${meta.image} not pulled; will build on first slot start`)
    continue
  }
  const r = spawnSync('docker', ['build', '-t', meta.image, path.join(root, meta.dir)], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
}
