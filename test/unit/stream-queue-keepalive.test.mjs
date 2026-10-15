import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

const MESSAGE = {
  model: 'claude-haiku-4-5',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hello from the queue' }],
}

function overloaded() {
  return {
    ok: false,
    status: 529,
    terminalState: 'exhausted',
    body: {
      type: 'error',
      error: {
        type: 'overloaded_error',
        code: 'pool_overloaded',
        message: '号池负载过高，稍后再试',
        details: { reason: 'pool_deadline_exceeded' },
      },
    },
  }
}

function createResponse() {
  const chunks = []
  const res = {
    statusCode: 0,
    body: null,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    chunks,
    writeHead(status) {
      this.statusCode = status
      this.headersSent = true
    },
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    end() {
      this.writableEnded = true
    },
    on(event, fn) {
      if (event === 'finish') this.finish = fn
    },
    once() {},
    off() {},
    setHeader() {},
  }
  return res
}

function createHandler({ root, routing, run, stream = true }) {
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {}, failover: routing.failover || {} }))
  return createHandleProtocol({
    json(res, status, body) {
      res.statusCode = status
      res.body = body
      res.headersSent = true
      return body
    },
    writeSSEHeaders(res) {
      res.writeHead(200)
    },
    readBody: async () => ({ ...MESSAGE, stream }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: {
        max_body_bytes: 1024 * 1024,
        upstream_timeout_ms: 2000,
        stream_idle_timeout_ms: 2000,
        stream_keepalive_ms: routing.failover?.stream_keepalive_ms ?? 20,
        queue_keepalive_delay_ms: routing.failover?.queue_keepalive_delay_ms ?? 60_000,
      },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: 'queue-keepalive', mode: 'normal', t0: Date.now() }),
      finish() {},
    },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: { run },
  })
}

async function invoke(handler, res) {
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer master', 'user-agent': 'claude-cli/2.1.187 (external, cli)' },
    apiKeyKind: 'master',
    once() {},
    off() {},
  }
  await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
  res.finish?.()
}

test('a Claude stream pings during the queue and reports a later failure as SSE error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-queue-keepalive-'))
  const res = createResponse()
  let sawPingBeforeReturn = false
  const handler = createHandler({
    root,
    routing: {
      compatibility: {},
      failover: { stream_keepalive_ms: 20, queue_keepalive_delay_ms: 30 },
    },
    run: async () => {
      const started = Date.now()
      while (Date.now() - started < 400) {
        if (res.chunks.some((chunk) => chunk.includes('event: ping'))) {
          sawPingBeforeReturn = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return overloaded()
    },
  })
  try {
    await invoke(handler, res)
    assert.equal(sawPingBeforeReturn, true)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headersSent, true)
    const body = res.chunks.join('')
    assert.match(body, /event: ping/)
    assert.match(body, /event: error/)
    const errorLine = body.split('\n').find((line) => line.startsWith('data:') && line.includes('overloaded_error'))
    const payload = JSON.parse(errorLine.slice(5).trim())
    assert.equal(payload.type, 'error')
    assert.equal(payload.error.type, 'overloaded_error')
    assert.equal(payload.error.details, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a Claude stream that fails before the queue delay keeps the HTTP status', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-queue-keepalive-fast-'))
  const res = createResponse()
  const handler = createHandler({
    root,
    routing: {
      compatibility: {},
      failover: { stream_keepalive_ms: 1000, queue_keepalive_delay_ms: 5_000 },
    },
    run: async () => overloaded(),
  })
  try {
    await invoke(handler, res)
    assert.equal(res.chunks.length, 0)
    assert.equal(res.statusCode, 529)
    assert.equal(res.body.error.type, 'overloaded_error')
    assert.equal(res.body.error.code, 'pool_overloaded')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a non-stream Claude request does not emit queue pings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-queue-keepalive-json-'))
  const res = createResponse()
  const handler = createHandler({
    root,
    stream: false,
    routing: {
      compatibility: {},
      failover: { stream_keepalive_ms: 20, queue_keepalive_delay_ms: 20 },
    },
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      return overloaded()
    },
  })
  try {
    await invoke(handler, res)
    assert.equal(res.chunks.length, 0)
    assert.equal(res.statusCode, 529)
    assert.equal(res.body.error.type, 'overloaded_error')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
