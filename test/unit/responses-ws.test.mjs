import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import {
  createResponsesWsHandler,
  createSseJsonBridge,
  isProtocolWarmup,
} from '../../src/lib/protocol/responses-ws.mjs'

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function listen({ routing, requireAuth, handleProtocol, maxBodyBytes }) {
  const httpHits = []
  const handler = createResponsesWsHandler({
    handleProtocol,
    requireAuth,
    json,
    getRouting: () => routing,
    maxBodyBytes,
  })
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.url === '/v1/responses' || req.url === '/responses')) {
      httpHits.push(req.url)
      json(res, 200, { ok: true, transport: 'http' })
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (!handler.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    server,
    port,
    httpHits,
    url: `ws://127.0.0.1:${port}/v1/responses`,
    httpUrl: `http://127.0.0.1:${port}/v1/responses`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function openWs(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    ws.once('open', () => done({ ok: true, ws }))
    ws.once('unexpected-response', (_req, res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let body = null
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
          body = {}
        }
        done({ ok: false, status: res.statusCode, body, ws: null })
      })
    })
    ws.once('error', (error) => {
      setTimeout(() => {
        if (!settled) done({ ok: false, error, ws: null })
      }, 20)
    })
  })
}

function nextFrame(ws, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('frame timeout')), timeoutMs)
    const onMessage = (data) => {
      const frame = JSON.parse(String(data))
      if (!predicate(frame)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(frame)
    }
    ws.on('message', onMessage)
  })
}

function allowAuth(req) {
  req.apiKeyKind = 'managed'
  req.apiKeyRecord = { id: 'key-1' }
  req.presentedApiKey = 'sk-test'
  return true
}

function denyAuth(_req, res) {
  json(res, 401, {
    error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid credentials' },
  })
  return false
}

const ENABLED = {
  websocket: { enabled: true },
  codex: { websocket: { enabled: true }, upstream_transport: 'prefer_websocket' },
}

test('a terminal SSE event without a final newline reaches the WebSocket client', async () => {
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(_req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"type":"response.completed","response":{"id":"resp_last","status":"completed","output":[]}}')
    },
  })
  const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
  try {
    const completed = nextFrame(opened.ws, (frame) => frame.type === 'response.completed')
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'hi' }))
    assert.equal((await completed).response.id, 'resp_last')
  } finally {
    opened.ws.close()
    await live.close()
  }
})

test('a frame above the request ceiling closes before protocol execution', async () => {
  let hops = 0
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    maxBodyBytes: 256,
    async handleProtocol() {
      hops++
    },
  })
  const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
  try {
    const closed = once(opened.ws, 'close')
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'x'.repeat(512) }))
    assert.equal((await closed)[0], 1009)
    assert.equal(hops, 0)
  } finally {
    opened.ws.terminate()
    await live.close()
  }
})

test('SSE bridge emits JSON frames and never treats [DONE] as completed', () => {
  const bridge = createSseJsonBridge()
  bridge.push('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","output":[]}}\n\n')
  bridge.push('data: [DONE]\n\n')
  bridge.finish()
  assert.equal(bridge.frames.length, 1)
  assert.equal(bridge.terminal, null)
  assert.equal(bridge.snapshot().id, 'resp_1')
})

test('disabled gates reject the handshake with zero upstream hops', async () => {
  const hops = []
  const live = await listen({
    routing: { websocket: { enabled: false }, codex: { websocket: { enabled: true } } },
    requireAuth: allowAuth,
    handleProtocol: async (req) => {
      hops.push(await readJson(req))
    },
  })
  try {
    const ws = await openWs(live.url, { authorization: 'Bearer sk-test' })
    assert.equal(ws.ok, false)
    assert.equal(ws.status, 403)
    assert.equal(ws.body.error.code, 'websocket_disabled')
    assert.equal(hops.length, 0)
    const gptOff = await listen({
      routing: { websocket: { enabled: true }, codex: { websocket: { enabled: false } } },
      requireAuth: allowAuth,
      handleProtocol: async (req) => {
        hops.push(await readJson(req))
      },
    })
    try {
      const second = await openWs(gptOff.url, { authorization: 'Bearer sk-test' })
      assert.equal(second.ok, false)
      assert.equal(second.status, 403)
      assert.equal(hops.length, 0)
      const httpRes = await fetch(gptOff.httpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body: JSON.stringify({ model: 'gpt-5.4', input: 'hi' }),
      })
      assert.equal(httpRes.status, 200)
      assert.deepEqual(await httpRes.json(), { ok: true, transport: 'http' })
    } finally {
      await gptOff.close()
    }
  } finally {
    await live.close()
  }
})

test('auth failure rejects the handshake with zero upstream hops', async () => {
  const hops = []
  const live = await listen({
    routing: ENABLED,
    requireAuth: denyAuth,
    handleProtocol: async (req) => {
      hops.push(await readJson(req))
    },
  })
  try {
    const ws = await openWs(live.url, { authorization: 'Bearer nope' })
    assert.equal(ws.ok, false)
    assert.equal(ws.status, 401)
    assert.equal(ws.body.error.code, 'invalid_api_key')
    assert.equal(hops.length, 0)
  } finally {
    await live.close()
  }
})

test('two response.create rounds replay full output including reasoning and tools', async () => {
  const hops = []
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req, res) {
      const body = await readJson(req)
      hops.push(body)
      const n = hops.length
      const id = `resp_${n}`
      const output = [
        { type: 'reasoning', id: `rs_${n}`, summary: [{ type: 'summary_text', text: 'think' }] },
        {
          type: 'function_call',
          id: `fc_${n}`,
          name: 'lookup',
          arguments: '{"q":"x"}',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `pong${n}` }],
        },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id, output: [] } })}\n\n`,
      )
      res.write(
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id, output } })}\n\n`,
      )
      res.end()
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    assert.equal(opened.ok, true)
    const { ws } = opened
    ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'hi' }))
    const first = await nextFrame(ws, (frame) => frame.type === 'response.completed')
    assert.equal(first.response.id, 'resp_1')
    assert.equal(hops.length, 1)
    assert.equal(hops[0].previous_response_id, undefined)
    ws.send(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.4',
        previous_response_id: 'resp_1',
        input: 'again',
      }),
    )
    const second = await nextFrame(ws, (frame) => frame.type === 'response.completed' && frame.response.id === 'resp_2')
    assert.equal(second.response.id, 'resp_2')
    assert.equal(hops.length, 2)
    assert.equal(hops[1].previous_response_id, undefined)
    const types = hops[1].input.map((item) => item.type)
    assert.deepEqual(types, ['message', 'reasoning', 'function_call', 'message', 'message'])
    assert.equal(hops[1].input[0].content, 'hi')
    assert.equal(hops[1].input[1].id, 'rs_1')
    assert.equal(hops[1].input[2].name, 'lookup')
    assert.equal(hops[1].input[4].content, 'again')
    ws.close()
    await once(ws, 'close')
  } finally {
    await live.close()
  }
})

test('unknown previous_response_id is a recovery error with zero hop', async () => {
  const hops = []
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req) {
      hops.push(await readJson(req))
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    assert.equal(opened.ok, true)
    opened.ws.send(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.4',
        previous_response_id: 'resp_missing',
        input: 'hi',
      }),
    )
    const frame = await nextFrame(opened.ws, (event) => event.type === 'error')
    assert.equal(frame.error.code, 'previous_response_not_found')
    assert.equal(hops.length, 0)
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('real protocol errors keep type/code and do not fabricate response.completed', async () => {
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(_req, res) {
      json(res, 400, {
        error: { type: 'invalid_request_error', code: 'model_not_found', message: 'no such model' },
      })
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    const frames = []
    opened.ws.on('message', (data) => frames.push(JSON.parse(String(data))))
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'nope', input: 'hi' }))
    const frame = await nextFrame(opened.ws, (event) => event.type === 'error')
    assert.equal(frame.status, 400)
    assert.equal(frame.error.type, 'invalid_request_error')
    assert.equal(frame.error.code, 'model_not_found')
    assert.equal(frame.error.message, 'no such model')
    assert.equal(
      frames.some((event) => event.type === 'response.completed'),
      false,
    )
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('client disconnect aborts the in-flight handleProtocol request', async () => {
  let hops = 0
  let aborted = false
  let started
  const startedP = new Promise((resolve) => {
    started = resolve
  })
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req, res) {
      hops += 1
      started()
      await new Promise((resolve) => req.once('aborted', resolve))
      aborted = true
      if (!res.writableEnded) {
        json(res, 499, {
          error: { type: 'timeout_error', code: 'client_cancelled', message: 'client disconnected' },
        })
      }
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'hang' }))
    await startedP
    opened.ws.close()
    await once(opened.ws, 'close')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(hops, 1)
    assert.equal(aborted, true)
  } finally {
    await live.close()
  }
})

test('generate=false warmup is rejected when upstream is HTTP-only', async () => {
  const hops = []
  const live = await listen({
    routing: {
      websocket: { enabled: true },
      codex: { websocket: { enabled: true }, upstream_transport: 'http' },
    },
    requireAuth: allowAuth,
    async handleProtocol(req) {
      hops.push(await readJson(req))
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    opened.ws.send(
      JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'warmup', generate: false, store: false }),
    )
    const frame = await nextFrame(opened.ws, (event) => event.type === 'error')
    assert.equal(frame.error.code, 'unsupported_prewarm')
    assert.equal(hops.length, 0)
    assert.equal(isProtocolWarmup({ generate: false, store: false }), true)
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('unknown control events are protocol errors, not a fake completed', async () => {
  const hops = []
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req) {
      hops.push(await readJson(req))
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    opened.ws.send(JSON.stringify({ type: 'response.interrupt', response_id: 'resp_x' }))
    const frame = await nextFrame(opened.ws, (event) => event.type === 'error')
    assert.equal(frame.error.code, 'invalid_value')
    assert.equal(hops.length, 0)
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('PUT /api/panel/routing rejects illegal websocket fields before persist', async () => {
  const response = {}
  let persisted = false
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: '/tmp' }, limits: { max_body_bytes: 4096 } },
    routingConfig: {},
    stickyRouter: { stats: () => ({}) },
    persistRoutingPatch() {
      persisted = true
    },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => ({ websocket: { enabled: 'nope' } }),
  })
  await handlePanel({ method: 'PUT' }, {}, new URL('http://localhost/api/panel/routing'))
  assert.equal(response.status, 400)
  assert.equal(response.body?.error?.code, 'invalid_websocket')
  assert.equal(persisted, false)
})

test('unexpected handler failures do not expose internal exception details', async () => {
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol() {
      throw new Error('/private/slot/credentials.json contains secret-fixture-token')
    },
  })
  const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
  try {
    const failed = nextFrame(opened.ws, (frame) => frame.type === 'error')
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'hi' }))
    const frame = await failed
    assert.equal(frame.status, 500)
    assert.equal(frame.error.code, 'api_error')
    assert.doesNotMatch(JSON.stringify(frame), /private|credentials|secret-fixture-token/)
  } finally {
    opened.ws.close()
    await live.close()
  }
})
