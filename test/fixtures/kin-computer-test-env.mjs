import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = path.dirname(fileURLToPath(import.meta.url))
const stubPath = path.join(fixturesDir, 'kin-computer-stub.mjs')
const wrapperPath = path.join(os.tmpdir(), `kin-computer-stub-wrap-${process.pid}.sh`)

/** Point unit tests at the kin-computer stub unless the runner already set a bin. */
export function ensureKinComputerStubEnv() {
  if (String(process.env.KIN_COMPUTER_BIN || '').trim()) return process.env.KIN_COMPUTER_BIN
  const node = process.execPath.replace(/'/g, `'\\''`)
  const stub = stubPath.replace(/'/g, `'\\''`)
  fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec '${node}' '${stub}' "$@"\n`, { encoding: 'utf8', mode: 0o755 })
  process.env.KIN_COMPUTER_BIN = wrapperPath
  return wrapperPath
}

ensureKinComputerStubEnv()
