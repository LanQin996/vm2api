import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildClaudeCodeNoopDeltaKeepalive,
  buildPingKeepalive,
  compareSemver,
  createDownstreamKeepalive,
  observeKeepaliveEvent,
  resolveKeepaliveChunk,
  shouldUseClaudeCodeNoopDeltaKeepalive,
} from '../../src/lib/protocol/stream-keepalive.mjs'

test('noop delta keepalive is for official CLI 2.1.193+', () => {
  assert.equal(shouldUseClaudeCodeNoopDeltaKeepalive('claude-cli/2.1.193 (external, cli)'), true)
  assert.equal(shouldUseClaudeCodeNoopDeltaKeepalive('claude-cli/2.1.241 (external, sdk-cli)'), true)
  assert.equal(shouldUseClaudeCodeNoopDeltaKeepalive('claude-cli/2.1.187 (external, cli)'), false)
  assert.equal(shouldUseClaudeCodeNoopDeltaKeepalive('kin-console-test/1.0'), false)
  assert.equal(compareSemver('2.1.193', '2.1.193'), 0)
})

test('keepalive chunk uses empty delta during tool_use for new CLI', () => {
  let state = { blockIndex: -1, deltaType: '' }
  state = observeKeepaliveEvent(state, {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', name: 'Agent' },
  })
  const chunk = resolveKeepaliveChunk({
    protocol: 'anthropic.messages',
    userAgent: 'claude-cli/2.1.241 (external, sdk-cli)',
    state,
  })
  assert.equal(chunk, buildClaudeCodeNoopDeltaKeepalive(1, 'input_json_delta'))
  assert.match(chunk, /"partial_json":""/)
})

test('keepalive chunk uses ping for older CLI or after block stop', () => {
  let state = observeKeepaliveEvent(
    { blockIndex: -1, deltaType: '' },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
  )
  assert.equal(
    resolveKeepaliveChunk({
      protocol: 'anthropic.messages',
      userAgent: 'claude-cli/2.1.187 (external, cli)',
      state,
    }),
    buildPingKeepalive(),
  )
  state = observeKeepaliveEvent(state, { type: 'content_block_stop', index: 0 })
  assert.equal(
    resolveKeepaliveChunk({
      protocol: 'anthropic.messages',
      userAgent: 'claude-cli/2.1.241 (external, sdk-cli)',
      state,
    }),
    buildPingKeepalive(),
  )
})

test('OpenAI protocol keepalive is an SSE comment', () => {
  assert.equal(resolveKeepaliveChunk({ protocol: 'openai.chat' }), ': keepalive\n\n')
})

test('createDownstreamKeepalive emits a ping after idle', async () => {
  const writes = []
  const keepalive = createDownstreamKeepalive({
    intervalMs: 20,
    userAgent: 'claude-cli/2.1.187 (external, cli)',
    protocol: 'anthropic.messages',
    write: (chunk) => writes.push(chunk),
  })
  keepalive.start()
  keepalive.observeLine('data: {"type":"message_start","message":{}}')
  await new Promise((resolve) => setTimeout(resolve, 80))
  keepalive.stop()
  assert.ok(writes.some((chunk) => chunk.includes('event: ping')))
})

test('keepalive arm starts pinging before the first upstream event', async () => {
  const writes = []
  const keepalive = createDownstreamKeepalive({
    intervalMs: 20,
    userAgent: 'claude-cli/2.1.187 (external, cli)',
    protocol: 'anthropic.messages',
    write: (chunk) => writes.push(chunk),
  })
  keepalive.start()
  keepalive.arm()
  await new Promise((resolve) => setTimeout(resolve, 80))
  keepalive.stop()
  assert.ok(writes.some((chunk) => chunk.includes('event: ping')))
})

test('keepalive start alone does not write before the first upstream event', async () => {
  const writes = []
  const keepalive = createDownstreamKeepalive({
    intervalMs: 20,
    userAgent: 'claude-cli/2.1.187 (external, cli)',
    protocol: 'anthropic.messages',
    write: (chunk) => writes.push(chunk),
  })
  keepalive.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  keepalive.stop()
  assert.equal(writes.length, 0)
})

test('armAfter holds the first ping until the queue delay', async () => {
  const writes = []
  const keepalive = createDownstreamKeepalive({
    intervalMs: 20,
    userAgent: 'claude-cli/2.1.187 (external, cli)',
    protocol: 'anthropic.messages',
    write: (chunk) => writes.push(chunk),
  })
  keepalive.armAfter(70)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(writes.length, 0)
  await new Promise((resolve) => setTimeout(resolve, 60))
  keepalive.stop()
  assert.ok(writes.some((chunk) => chunk.includes('event: ping')))
})

test('a fast attempt does not ping before the queue delay', async () => {
  const writes = []
  const keepalive = createDownstreamKeepalive({
    intervalMs: 25,
    userAgent: 'claude-cli/2.1.187 (external, cli)',
    protocol: 'anthropic.messages',
    write: (chunk) => writes.push(chunk),
  })
  keepalive.armAfter(80)
  keepalive.arm()
  keepalive.endAttempt()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(writes.length, 0)
  await new Promise((resolve) => setTimeout(resolve, 70))
  keepalive.stop()
  assert.ok(writes.some((chunk) => chunk.includes('event: ping')))
})

test('an active attempt still pings before the queue delay', async () => {
  const writes = []
  const keepalive = createDownstreamKeepalive({
    intervalMs: 20,
    userAgent: 'claude-cli/2.1.187 (external, cli)',
    protocol: 'anthropic.messages',
    write: (chunk) => writes.push(chunk),
  })
  keepalive.armAfter(400)
  keepalive.arm()
  await new Promise((resolve) => setTimeout(resolve, 70))
  keepalive.stop()
  assert.ok(writes.some((chunk) => chunk.includes('event: ping')))
})

test('pings continue between attempts after the first byte', async () => {
  const writes = []
  const keepalive = createDownstreamKeepalive({
    intervalMs: 20,
    userAgent: 'claude-cli/2.1.187 (external, cli)',
    protocol: 'anthropic.messages',
    write: (chunk) => writes.push(chunk),
  })
  keepalive.armAfter(0)
  assert.ok(writes.some((chunk) => chunk.includes('event: ping')))
  const first = writes.length
  keepalive.endAttempt()
  await new Promise((resolve) => setTimeout(resolve, 70))
  keepalive.stop()
  assert.ok(writes.length > first)
})
