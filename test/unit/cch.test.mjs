import { test } from 'node:test'
import assert from 'node:assert/strict'
import { xxh64 } from '../../src/lib/identity/xxh64.mjs'
import {
  CCH_PLACEHOLDER,
  CCH_XXH64_SEED,
  computeClaudeCodeCch,
  projectClaudeCodeCchText,
  sealClaudeCodeCch,
} from '../../src/lib/identity/cch.mjs'
import {
  CRS_OFFICIAL_AGENT_PROMPT,
  applyCrsUnofficialPersona,
  buildBillingAttributionText,
} from '../../src/lib/identity/crs-persona.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'

test('xxh64 matches Python xxhash.xxh64 intdigest vectors', () => {
  const seed = CCH_XXH64_SEED
  assert.equal(xxh64(Buffer.alloc(0), 0n), 0xef46db3751d8e999n)
  assert.equal(xxh64(Buffer.from('a'), 0n), 0xd24ec4f1a98c6e5bn)
  assert.equal(xxh64(Buffer.from('abc'), 0n), 0x44bc2cf5ad770999n)
  assert.equal(xxh64(Buffer.from('abc'), seed), 0xdfc4f4d6913699b6n)
  assert.equal(xxh64(Buffer.from('hello'), seed), 0xfc8105d2d40e53f1n)
  assert.equal(xxh64(Buffer.from('0123456789abcdef0123456789abcdef'), 0n), 0x642a94958e71e6c5n)
  assert.equal(xxh64(Buffer.from('0123456789abcdef0123456789abcdefXXXX'), seed), 0x35f35a19b70a062en)
  assert.equal(xxh64(Buffer.from('{"x":"cch=00000"}'), seed), 0xd9938bad051d0a74n)
})

test('computeClaudeCodeCch is xxh64(bytes, 2.1.280 seed) & 0xfffff as 5 hex', () => {
  const raw = Buffer.from('{"x":"cch=00000"}')
  assert.equal(computeClaudeCodeCch(raw), 'd0a74')
  assert.equal(computeClaudeCodeCch(Buffer.from('hello')), 'e53f1')
})

test('buildBillingAttributionText leaves cch=00000 for later seal', () => {
  const text = buildBillingAttributionText('hello', '2.1.263', 's-1')
  assert.match(text, new RegExp(`cch=${CCH_PLACEHOLDER};`))
  assert.doesNotMatch(text, /cch=(?!00000)[0-9a-f]{5}/)
})

test('sealClaudeCodeCch hashes the 2.1.280 projection then writes digest', () => {
  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 64000,
    fallbacks: ['claude-haiku-4-5'],
    fallback_credit_token: 'tok',
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=sdk-cli; cch=00000; cc_prompt_id=00000000-0000-4000-8000-000000000000;',
      },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const raw = JSON.stringify(body)
  const projected = projectClaudeCodeCchText(raw)
  const projectedBody = JSON.parse(projected)
  assert.equal(projectedBody.model, '')
  assert.equal(Object.hasOwn(projectedBody, 'max_tokens'), false)
  assert.equal(Object.hasOwn(projectedBody, 'fallbacks'), false)
  assert.equal(Object.hasOwn(projectedBody, 'fallback_credit_token'), false)
  assert.match(projected, /cch=00000/)
  const expected = computeClaudeCodeCch(Buffer.from(projected, 'utf8'))
  assert.notEqual(expected, computeClaudeCodeCch(Buffer.from(raw, 'utf8')))
  const sealed = sealClaudeCodeCch(body)
  assert.equal(expected.length, 5)
  assert.notEqual(expected, CCH_PLACEHOLDER)
  assert.match(sealed.system[0].text, new RegExp(`cch=${expected};`))
  assert.equal(sealed.model, 'claude-sonnet-5')
  assert.equal(sealed.max_tokens, 64000)
  assert.deepEqual(sealed.fallbacks, ['claude-haiku-4-5'])
  assert.equal(sealed.fallback_credit_token, 'tok')
  assert.equal(JSON.stringify(sealed), raw.replace(/cch=00000/, `cch=${expected}`))
})

test('projectClaudeCodeCchText edits the original text and clears every model string', () => {
  const raw =
    '{"z":1,"model":"sonnet","messages":[{"model":"other"}],"max_tokens":9,"fallbacks":["haiku",{"model":"inside"}],"fallback_credit_token":"tok","system":[{"text":"cch=3180f"}]}'
  const projected = projectClaudeCodeCchText(raw)
  assert.equal(projected, '{"z":1,"model":"","messages":[{"model":""}],"system":[{"text":"cch=00000"}]}')
  assert.equal(
    projectClaudeCodeCchText('{"model":"","max_tokens":"nope","system":"cch=00000"}'),
    '{"model":"","max_tokens":"nope","system":"cch=00000"}',
  )
})

test('sealClaudeCodeCch is a no-op when billing already has a real cch', () => {
  const body = {
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.241.abc; cc_entrypoint=cli; cch=cc746;',
      },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const sealed = sealClaudeCodeCch(body)
  assert.equal(sealed.system[0].text, body.system[0].text)
  assert.equal(sealed, body)
})

test('applyCrsUnofficialPersona keeps the placeholder until hop finalize', () => {
  const out = applyCrsUnofficialPersona({
    messages: [{ role: 'user', content: 'ping' }],
  })
  const billing = out.system.find((block) => /x-anthropic-billing-header:/i.test(block?.text || ''))
  assert.match(billing.text, new RegExp(`cch=${CCH_PLACEHOLDER};`))
  const sealed = finalizeWorkerPayload({
    body: out,
    reqHeaders: {},
    exec: { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } },
    identity: null,
  }).body
  const sealedBilling = sealed.system.find((block) => /x-anthropic-billing-header:/i.test(block?.text || ''))
  const cch = sealedBilling.text.match(/cch=([0-9a-f]{5})/)[1]
  assert.notEqual(cch, CCH_PLACEHOLDER)
  const replay = JSON.stringify(sealed).replace(`cch=${cch}`, `cch=${CCH_PLACEHOLDER}`)
  const projected = projectClaudeCodeCchText(replay)
  assert.equal(computeClaudeCodeCch(Buffer.from(projected, 'utf8')), cch)
})

test('no inbound system still emits billing, identity, official prompt, and env', () => {
  const sessionId = '11111111-2222-4333-8444-555555555555'
  const out = applyCrsUnofficialPersona(
    {
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: '你好呀。' }],
    },
    { mode: 'official_prompt', sessionId },
  )
  assert.equal(out.system.length, 4)
  assert.match(out.system[0].text, /^x-anthropic-billing-header: /)
  assert.equal(out.system[1].text, "You are a Claude agent, built on Anthropic's Claude Agent SDK.")
  assert.equal(out.system[2].text, CRS_OFFICIAL_AGENT_PROMPT)
  assert.deepEqual(out.system[2].cache_control, { type: 'ephemeral', ttl: '1h', scope: 'global' })
  assert.match(out.system[3].text, /^# Environment\n/)
})
