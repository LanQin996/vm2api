import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { firstHistoryDiff } from '../../src/lib/protocol/cache-prefix.mjs'

for (const model of ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5.1[1m]', 'claude-opus-5-5']) {
  for (const repaired of [false, true]) {
    test(`cli-hop retains the cache prefix across system reminders: ${model}, repaired=${repaired}`, () => {
      const initial = {
        model,
        max_tokens: 64,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: 'Keep the caller instructions unchanged.' }],
        messages: [
          { role: 'user', content: 'Review the supplied material.' },
          { role: 'system', content: '<total_tokens>14999900 tokens left</total_tokens>' },
        ],
      }
      const continuation = structuredClone(initial)
      continuation.messages.push(
        { role: 'assistant', content: 'Review complete.' },
        { role: 'user', content: 'Continue with the next material.' },
        { role: 'system', content: '<total_tokens>14999800 tokens left</total_tokens>' },
      )
      const before = structuredClone(continuation)
      const first = prepareCliHopBody(initial, { repaired })
      const next = prepareCliHopBody(continuation, { repaired })
      assert.deepEqual(next.system, first.system, 'a new reminder must not grow the top-level system')
      assert.equal(next.messages.filter((message) => message.role === 'system').length, 2)
      assert.equal(firstHistoryDiff(first, next).section, null, 'history must remain an append-only prefix')
      assert.deepEqual(continuation, before, 'do not mutate the caller request')
    })
  }
}

test('cli-hop still lifts system reminders for models that reject the message role', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    thinking: { type: 'disabled' },
    messages: [
      { role: 'user', content: 'Review this material.' },
      { role: 'system', content: 'Keep the required output format.' },
    ],
  })
  assert.equal(
    body.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.ok(JSON.stringify(body.system).includes('Keep the required output format.'))
})
