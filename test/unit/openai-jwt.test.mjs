import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeJwtPayload,
  openaiIdentityFromJwt,
  openaiIdentityFromOauthTokens,
} from '../../src/lib/oauth/openai-jwt.mjs'

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${body}.sig`
}

test('decodeJwtPayload returns null for garbage', () => {
  assert.equal(decodeJwtPayload(''), null)
  assert.equal(decodeJwtPayload('not-a-jwt'), null)
  assert.equal(decodeJwtPayload('a.b'), null)
})

test('openaiIdentityFromJwt reads email and chatgpt_account_id', () => {
  const token = jwt({
    email: 'user@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-jwt-1' },
  })
  assert.deepEqual(openaiIdentityFromJwt(token), {
    email: 'user@example.com',
    chatgpt_account_id: 'acc-jwt-1',
  })
})

test('openaiIdentityFromOauthTokens prefers id_token email and merges account id', () => {
  const idToken = jwt({ email: 'from-id@example.com' })
  const accessToken = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-from-at' },
  })
  assert.deepEqual(openaiIdentityFromOauthTokens({ id_token: idToken, access_token: accessToken }), {
    email: 'from-id@example.com',
    chatgpt_account_id: 'acc-from-at',
  })
})

test('openaiIdentityFromOauthTokens tolerates missing tokens', () => {
  assert.deepEqual(openaiIdentityFromOauthTokens({}), { email: null, chatgpt_account_id: null })
})
