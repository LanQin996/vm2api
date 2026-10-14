import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'

const exits = new Map()
const assignments = new Map()

function runIp(args) {
  return execFileSync('ip', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function ipv6BigInt(input) {
  let value = String(input || '')
    .split('%')[0]
    .toLowerCase()
  if (net.isIP(value) !== 6) throw new Error('invalid IPv6 address')
  const embeddedV4 = value.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (embeddedV4) {
    const octets = embeddedV4[1].split('.').map(Number)
    value = value.replace(
      embeddedV4[1],
      `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`,
    )
  }
  const halves = value.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group || '0'}`), 0n)
}

function ipv6Text(value) {
  const groups = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt((7 - i) * 16)) & 0xffffn).toString(16))
  let bestStart = -1
  let bestLength = 1
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== '0') {
      i++
      continue
    }
    let end = i
    while (end < groups.length && groups[end] === '0') end++
    if (end - i > bestLength) {
      bestStart = i
      bestLength = end - i
    }
    i = end
  }
  if (bestStart < 0) return groups.join(':')
  const before = groups.slice(0, bestStart).join(':')
  const after = groups.slice(bestStart + bestLength).join(':')
  return `${before}::${after}`
}

function hostIpv6Prefix() {
  const configured = String(process.env.KIN_CODEX_IPV6_CIDR || '').trim()
  const configuredIface = String(process.env.KIN_CODEX_IPV6_INTERFACE || '').trim()
  if (!!configured !== !!configuredIface) {
    throw new Error('KIN_CODEX_IPV6_CIDR and KIN_CODEX_IPV6_INTERFACE must be configured together')
  }
  if (configured) {
    const [address, bits] = configured.split('/')
    if (net.isIP(address) !== 6 || bits !== '64') throw new Error('KIN_CODEX_IPV6_CIDR must be an IPv6 /64')
    return { base: ipv6BigInt(address) & (((1n << 64n) - 1n) << 64n), iface: configuredIface }
  }

  const rows = JSON.parse(runIp(['-j', '-6', 'addr', 'show', 'scope', 'global']))
  for (const row of rows) {
    for (const info of row.addr_info || []) {
      if (info.family !== 'inet6' || info.scope !== 'global' || info.prefixlen !== 64) continue
      if ((info.flags || []).some((flag) => ['temporary', 'tentative', 'deprecated'].includes(flag))) continue
      return { base: ipv6BigInt(info.local) & (((1n << 64n) - 1n) << 64n), iface: row.ifname }
    }
  }
  throw new Error('no global IPv6 /64 found; configure KIN_CODEX_IPV6_CIDR and KIN_CODEX_IPV6_INTERFACE')
}

function getSlotAddress(vmId, prefix) {
  const previous = assignments.get(vmId)
  if (previous) return previous
  const used = new Set([...assignments.values()].map((row) => row.address))
  const existing = JSON.parse(runIp(['-j', '-6', 'addr', 'show', 'scope', 'global'])).flatMap((row) =>
    (row.addr_info || []).map((info) => ({ address: info.local, iface: row.ifname })),
  )
  const existingOnInterface = new Set(existing.filter((row) => row.iface === prefix.iface).map((row) => row.address))
  const occupied = new Set([...used, ...existing.map((row) => row.address)])
  const iid = BigInt(`0x${crypto.createHash('sha256').update(String(vmId)).digest('hex').slice(0, 16)}`)
  for (let offset = 0n; offset < 1n << 16n; offset++) {
    const candidateIid = (iid + offset) & ((1n << 64n) - 1n)
    if (candidateIid < 2n) continue
    const address = ipv6Text(prefix.base | candidateIid)
    // Reuse the deterministic address if it is already on the selected interface.
    if (used.has(address) || (occupied.has(address) && !(offset === 0n && existingOnInterface.has(address)))) continue
    const row = { address, iface: prefix.iface }
    assignments.set(vmId, row)
    return row
  }
  throw new Error('could not allocate an unused IPv6 address for GPT slot')
}

function portForVm(vmId) {
  const hash = crypto.createHash('sha256').update(String(vmId)).digest().readUInt32BE(0)
  return 32000 + (hash % 24000)
}

function readExactly(socket) {
  let buffered = Buffer.alloc(0)
  const waiters = []
  let ended = false
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    while (waiters.length && buffered.length >= waiters[0].count) {
      const waiter = waiters.shift()
      const out = buffered.subarray(0, waiter.count)
      buffered = buffered.subarray(waiter.count)
      waiter.resolve(out)
    }
  })
  socket.once('close', () => {
    ended = true
    while (waiters.length) waiters.shift().reject(new Error('socket closed'))
  })
  return (n) => {
    if (ended) return Promise.reject(new Error('socket closed'))
    if (buffered.length >= n) {
      const out = buffered.subarray(0, n)
      buffered = buffered.subarray(n)
      return Promise.resolve(out)
    }
    return new Promise((resolve, reject) => waiters.push({ count: n, resolve, reject }))
  }
}

function socksReply(socket, status) {
  socket.write(Buffer.from([5, status, 0, 1, 0, 0, 0, 0, 0, 0]))
}

async function connectIpv6(
  socket,
  sourceAddress,
  hostname,
  port,
  { resolve6 = dns.resolve6, connect = net.connect } = {},
) {
  let targets
  if (net.isIP(hostname) === 6) {
    if (!codexIpv6DestinationAllowed(hostname)) throw new Error('IPv4-mapped destinations are disabled for GPT egress')
    targets = [hostname]
  } else if (!codexIpv6DestinationAllowed(hostname)) throw new Error('IPv4 destinations are disabled for GPT egress')
  else targets = (await resolve6(hostname)).filter(codexIpv6DestinationAllowed)
  let lastError
  for (const host of targets) {
    try {
      await new Promise((resolve, reject) => {
        const upstream = connect({ host, port, family: 6, localAddress: sourceAddress })
        upstream.once('connect', () => {
          socksReply(socket, 0)
          socket.pipe(upstream)
          upstream.pipe(socket)
          socket.resume()
          resolve()
        })
        upstream.once('error', reject)
        socket.once('close', () => upstream.destroy())
      })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('destination has no IPv6 address')
}

function handleSocks(socket, sourceAddress, dialOptions) {
  socket.pause()
  const read = readExactly(socket)
  socket.resume()
  ;(async () => {
    const [version, methodCount] = await read(2)
    if (version !== 5 || methodCount < 1) throw new Error('invalid SOCKS greeting')
    const methods = await read(methodCount)
    if (!methods.includes(0)) {
      socket.end(Buffer.from([5, 255]))
      return
    }
    socket.write(Buffer.from([5, 0]))
    const header = await read(4)
    if (header[0] !== 5 || header[1] !== 1 || header[2] !== 0) throw new Error('unsupported SOCKS request')
    let host
    if (header[3] === 1) {
      await read(4)
      throw new Error('IPv4 destinations are disabled for GPT egress')
    }
    if (header[3] === 4) {
      const bytes = await read(16)
      host = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':')
    } else if (header[3] === 3) {
      const size = (await read(1))[0]
      host = (await read(size)).toString('utf8')
    } else throw new Error('unsupported SOCKS address type')
    const port = (await read(2)).readUInt16BE(0)
    await connectIpv6(socket, sourceAddress, host, port, dialOptions)
  })().catch(() => {
    if (!socket.destroyed) socksReply(socket, 5)
    socket.destroy()
  })
}

export function codexIpv6ProxyUrl(vmId) {
  return `socks5h://127.0.0.1:${portForVm(vmId)}`
}

export function codexIpv6EgressStatus(vmId) {
  const exit = exits.get(String(vmId || ''))
  return exit
    ? { active: true, address: exit.address, interface: exit.iface }
    : { active: false, address: null, interface: null }
}

export function codexIpv6DestinationAllowed(hostname) {
  const value = String(hostname || '')
  const family = net.isIP(value)
  if (family === 4) return false
  if (family === 6) {
    const numeric = ipv6BigInt(value)
    const high96 = numeric >> 32n
    return high96 !== 0xffffn && !(high96 === 0n && numeric > 1n)
  }
  return true
}

export function createCodexIpv6SocksServer(sourceAddress, dialOptions) {
  if (net.isIP(sourceAddress) !== 6 || ipv6BigInt(sourceAddress) >> 32n === 0xffffn) {
    throw new Error('Codex SOCKS source must be a native IPv6 address')
  }
  return createServer((socket) => handleSocks(socket, sourceAddress, dialOptions))
}

export async function ensureCodexIpv6Egress(vm) {
  if (process.platform !== 'linux') throw new Error('per-slot IPv6 egress requires Linux')
  if (!vm?.id) throw new Error('GPT VM id is required for IPv6 egress')
  const running = exits.get(vm.id)
  if (running) return { ...running, proxyUrl: codexIpv6ProxyUrl(vm.id) }
  const prefix = hostIpv6Prefix()
  const row = getSlotAddress(vm.id, prefix)
  const addresses = JSON.parse(runIp(['-j', '-6', 'addr', 'show', 'dev', row.iface]))
    .flatMap((entry) => entry.addr_info || [])
    .map((info) => info.local)
  const addressAlreadyPresent = addresses.includes(row.address)
  if (!addressAlreadyPresent) runIp(['-6', 'addr', 'add', `${row.address}/128`, 'dev', row.iface, 'nodad'])
  const server = createCodexIpv6SocksServer(row.address)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(portForVm(vm.id), '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    try {
      server.close()
    } catch {}
    if (!addressAlreadyPresent) {
      try {
        runIp(['-6', 'addr', 'del', `${row.address}/128`, 'dev', row.iface])
      } catch {}
    }
    assignments.delete(vm.id)
    throw error
  }
  const result = { address: row.address, iface: row.iface, server, proxyUrl: codexIpv6ProxyUrl(vm.id) }
  exits.set(vm.id, result)
  return result
}

export function stopCodexIpv6Egress(vmId, { removeAddress = true } = {}) {
  const row = assignments.get(vmId)
  const exit = exits.get(vmId)
  exits.delete(vmId)
  if (exit?.server) exit.server.close()
  if (removeAddress && row && process.platform === 'linux') {
    try {
      runIp(['-6', 'addr', 'del', `${row.address}/128`, 'dev', row.iface])
    } catch {}
  }
  assignments.delete(vmId)
  return { ok: true }
}
