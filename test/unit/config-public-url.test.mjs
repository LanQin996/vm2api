import test from 'node:test'
import assert from 'node:assert/strict'
import { isBindWildcardHost, resolvePublicBaseUrl, resolvePublicHost, loadConfig } from '../../src/lib/core/config.mjs'

test('isBindWildcardHost rejects listen wildcards', () => {
  assert.equal(isBindWildcardHost('0.0.0.0'), true)
  assert.equal(isBindWildcardHost('::'), true)
  assert.equal(isBindWildcardHost('[::]'), true)
  assert.equal(isBindWildcardHost('127.0.0.1'), false)
  assert.equal(isBindWildcardHost('api.example.com'), false)
})

test('HOST=0.0.0.0 without PUBLIC_* does not yield 0.0.0.0 base_url', () => {
  const env = {
    HOST: '0.0.0.0',
    PORT: '8787',
  }
  assert.equal(resolvePublicHost(env), null)
  assert.equal(resolvePublicBaseUrl(env, 8787), null)
})

test('PUBLIC_BASE_URL wins and strips trailing slash', () => {
  const env = {
    HOST: '0.0.0.0',
    PUBLIC_BASE_URL: 'https://gateway.example/',
  }
  assert.equal(resolvePublicBaseUrl(env, 8787), 'https://gateway.example')
})

test('PUBLIC_HOST builds http URL with port; https omits default port suffix', () => {
  const env = { HOST: '0.0.0.0', PUBLIC_HOST: '127.0.0.1', PORT: '8787' }
  assert.equal(resolvePublicHost(env), '127.0.0.1')
  assert.equal(resolvePublicBaseUrl(env, 8787), 'http://127.0.0.1:8787')

  const tls = { ...env, PUBLIC_SCHEME: 'https', PUBLIC_HOST: 'gateway.example' }
  assert.equal(resolvePublicBaseUrl(tls, 8787), 'https://gateway.example')
})

test('loadConfig keeps bind host separate from public base_url', () => {
  const saved = {
    VM2API_API_KEY: process.env.VM2API_API_KEY,
    KIN_API_KEY: process.env.KIN_API_KEY,
    HOST: process.env.HOST,
    PUBLIC_HOST: process.env.PUBLIC_HOST,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    PUBLIC_SCHEME: process.env.PUBLIC_SCHEME,
    PORT: process.env.PORT,
  }
  try {
    process.env.VM2API_API_KEY = 'unit-test-public-url-key'
    delete process.env.KIN_API_KEY
    process.env.HOST = '0.0.0.0'
    process.env.PORT = '8787'
    delete process.env.PUBLIC_HOST
    delete process.env.PUBLIC_BASE_URL
    delete process.env.PUBLIC_SCHEME
    const cfg = loadConfig()
    assert.equal(cfg.host, '0.0.0.0')
    assert.equal(cfg.public_host, null)
    assert.equal(cfg.base_url, null)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})
