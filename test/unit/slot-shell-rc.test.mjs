import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { panelShellLaunch } from '../../src/lib/vm/slot-shell.mjs'
import { OFFICIAL_CLI_VERSION } from '../../src/lib/identity/vm-identity.mjs'
test('claude in the panel shell runs cli-node and points config at .claude', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-rc-'))
  const bin = path.join(dir, 'cli-node')
  const decoyDir = path.join(dir, 'decoy')
  const home = path.join(dir, 'home')
  fs.mkdirSync(decoyDir)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'credentials.json'), '{}\n')
  fs.writeFileSync(path.join(home, '.claude', '.claude.json'), '{"oauthAccount":{}}\n')
  fs.writeFileSync(bin, '#!/bin/sh\necho "cli-node $*"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(decoyDir, 'claude'), '#!/bin/sh\necho DECOY\n', { mode: 0o755 })
  const { rc, cmd } = panelShellLaunch(bin)
  assert.match(cmd.at(-1), /bash --rcfile/)
  assert.match(rc, /CLAUDE_CONFIG_DIR/)
  assert.match(rc, /CLAUDE_CODE_HOST_REFRESH=1/)
  assert.match(rc, new RegExp(`CLAUDE_CODE_VERSION=${OFFICIAL_CLI_VERSION.replaceAll('.', '\\.')}`))
  assert.match(rc, /USER_TYPE=external/)
  const rcPath = path.join(dir, 'rc')
  fs.writeFileSync(rcPath, `${rc}\n`)
  const ran = spawnSync(
    'bash',
    ['--rcfile', rcPath, '-ic', 'type claude; printf %s "$CLAUDE_CONFIG_DIR"; echo; claude --flag'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${decoyDir}:${process.env.PATH}`,
        KIN_PANEL_RCFILE: rcPath,
      },
    },
  )
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /claude is a function/)
  assert.match(ran.stdout, /cli-node --flag/)
  assert.doesNotMatch(ran.stdout, /DECOY/)
  assert.equal(fs.readlinkSync(path.join(home, '.claude', '.credentials.json')), 'credentials.json')
  assert.equal(fs.readlinkSync(path.join(home, '.claude.json')), '.claude/.claude.json')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('panelShellLaunch rejects a non-absolute cli-node path', () => {
  assert.throws(() => panelShellLaunch('cli-node'), /invalid cli-node path/)
  assert.throws(() => panelShellLaunch('/tmp/a\nb'), /invalid cli-node path/)
})

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function writeLaunchRc(dir) {
  const bin = path.join(dir, 'cli-node')
  fs.writeFileSync(bin, '#!/bin/sh\necho "cli-node $*"\n', { mode: 0o755 })
  const { rc } = panelShellLaunch(bin)
  const rcPath = path.join(dir, 'rc')
  fs.writeFileSync(rcPath, `${rc}\n`)
  return rcPath
}

test('panel shell prints live 系统特征 before the prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-facts-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, '.bashrc'), 'set -e\n')
  const rcPath = writeLaunchRc(dir)
  const ran = spawnSync('bash', ['--rcfile', rcPath, '-ic', 'true'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      KIN_PANEL_RCFILE: rcPath,
      TERM: 'xterm',
    },
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /^系统特征$/m)
  const host = spawnSync('sh', ['-c', 'hostname 2>/dev/null || uname -n'], {
    encoding: 'utf8',
  }).stdout.trim()
  const krel = spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim()
  const kmach = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim()
  assert.match(ran.stdout, new RegExp(`主机\\s+${escapeRe(host)}`))
  assert.match(ran.stdout, new RegExp(`内核\\s+${escapeRe(krel)}`))
  assert.match(ran.stdout, new RegExp(`架构\\s+${escapeRe(kmach)}`))
  assert.match(ran.stdout, /CPU\s+\S/)
  assert.match(ran.stdout, /核数\s+\d+/)
  assert.match(ran.stdout, /内存\s+\d+[GMk]/)
  assert.match(ran.stdout, /磁盘\s+\S/)
  assert.match(ran.stdout, /MAC\s+\S/)
  assert.match(ran.stdout, /厂商\s+\S/)
  assert.match(ran.stdout, /机器ID\s+(已采集|未采集)/)
  assert.match(ran.stdout, /Shell\s+bash/)
  if (fs.existsSync('/etc/os-release')) {
    const text = fs.readFileSync('/etc/os-release', 'utf8')
    const pretty = (text.match(/^PRETTY_NAME=(.*)$/m)?.[1] || '').replace(/^["']|["']$/g, '')
    if (pretty) assert.match(ran.stdout, new RegExp(escapeRe(pretty)))
  }
  if (fs.existsSync('/etc/machine-id')) {
    const mid = fs.readFileSync('/etc/machine-id', 'utf8').trim()
    if (mid) assert.doesNotMatch(ran.stdout, new RegExp(escapeRe(mid)))
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('panel shell 系统特征 still prints under sh -i fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-facts-sh-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  const rcPath = writeLaunchRc(dir)
  const ran = spawnSync('sh', ['-ic', ':'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      ENV: rcPath,
      KIN_PANEL_RCFILE: rcPath,
      TERM: 'xterm',
    },
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /系统特征/)
  assert.match(ran.stdout, /机器ID\s+(已采集|未采集)/)
  fs.rmSync(dir, { recursive: true, force: true })
})
