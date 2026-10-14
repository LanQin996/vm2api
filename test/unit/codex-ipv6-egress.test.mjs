import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {
  codexIpv6DestinationAllowed,
  codexIpv6ProxyUrl,
  createCodexIpv6SocksServer,
} from '../../src/lib/vm/codex-ipv6-egress.mjs'

function socketReader(socket) {
  let buffer = Buffer.alloc(0)
  const waiters = []
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (waiters.length && buffer.length >= waiters[0].size) {
      const { size, resolve } = waiters.shift()
      resolve(buffer.subarray(0, size))
      buffer = buffer.subarray(size)
    }
  })
  return (size) => {
    if (buffer.length >= size) {
      const out = buffer.subarray(0, size)
      buffer = buffer.subarray(size)
      return Promise.resolve(out)
    }
    return new Promise((resolve) => waiters.push({ size, resolve }))
  }
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

test('Codex IPv6 proxy URL is deterministic for each VM', () => {
  assert.equal(codexIpv6ProxyUrl('vm-gpt-1'), codexIpv6ProxyUrl('vm-gpt-1'))
  assert.notEqual(codexIpv6ProxyUrl('vm-gpt-1'), codexIpv6ProxyUrl('vm-gpt-2'))
  assert.match(codexIpv6ProxyUrl('vm-gpt-1'), /^socks5h:\/\/127\.0\.0\.1:\d+$/)
})

test('Codex IPv6 egress rejects IPv4 literals and permits hostnames or IPv6 literals', () => {
  assert.equal(codexIpv6DestinationAllowed('203.0.113.8'), false)
  assert.equal(codexIpv6DestinationAllowed('2606:4700:4700::1111'), true)
  assert.equal(codexIpv6DestinationAllowed('chatgpt.com'), true)
  assert.equal(codexIpv6DestinationAllowed('::ffff:192.0.2.10'), false)
})

test('Codex SOCKS proxy binds upstream connections to the assigned IPv6 source', async (t) => {
  let remoteAddress
  const sockets = []
  const upstream = net.createServer((socket) => {
    sockets.push(socket)
    remoteAddress = socket.remoteAddress
    socket.on('data', (chunk) => socket.write(chunk))
  })
  const upstreamPort = await listen(upstream, '::1')

  const proxy = createCodexIpv6SocksServer('::1')
  proxy.on('connection', (socket) => sockets.push(socket))
  const proxyPort = await listen(proxy, '127.0.0.1')

  const client = net.connect(proxyPort, '127.0.0.1')
  sockets.push(client)
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ])
  })
  const read = socketReader(client)
  client.write(Buffer.from([5, 1, 0]))
  assert.deepEqual(await read(2), Buffer.from([5, 0]))
  const target = Buffer.alloc(16)
  target[15] = 1
  const port = Buffer.alloc(2)
  port.writeUInt16BE(upstreamPort)
  client.write(Buffer.concat([Buffer.from([5, 1, 0, 4]), target, port]))
  assert.equal((await read(10))[1], 0)
  client.write(Buffer.from('ipv6-only'))
  assert.equal((await read(9)).toString(), 'ipv6-only')
  assert.equal(remoteAddress, '::1')
})

test('Codex SOCKS proxy rejects IPv4 CONNECT requests', async (t) => {
  const proxy = createCodexIpv6SocksServer('::1')
  const proxyPort = await listen(proxy, '127.0.0.1')

  const client = net.connect(proxyPort, '127.0.0.1')
  proxy.on('connection', (socket) => socket.once('close', () => {}))
  t.after(async () => {
    client.destroy()
    await new Promise((resolve) => proxy.close(resolve))
  })
  const read = socketReader(client)
  client.write(Buffer.from([5, 1, 0]))
  assert.deepEqual(await read(2), Buffer.from([5, 0]))
  client.write(Buffer.from([5, 1, 0, 1, 203, 0, 113, 8, 0, 80]))
  assert.equal((await read(10))[1], 5)
})
