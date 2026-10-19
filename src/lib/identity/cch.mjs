/**
 * Claude Code 2.1.296-compatible cch over compact final JSON.
 * Normalize the billing value before hashing, including caller-supplied values.
 * Billing's `cch=` goes back to `00000`. Every `"model":"..."` value is cleared.
 * `"fallbacks":[...]`, `"fallback_credit_token":"..."`, and a numeric
 * `"max_tokens"` are cut out, including the adjacent comma.
 * Seed `0x4D659218E32A3268` is the ELF immediate, same as 2.1.177.
 * Low 20 bits, 5 lowercase hex. The bytes on the wire keep the real fields.
 */
import { xxh64 } from './xxh64.mjs'

export const CCH_PLACEHOLDER = '00000'
export const CCH_XXH64_SEED = 0x4d659218e32a3268n

function cut(text, start, end) {
  if (end < text.length && text[end] === ',') end += 1
  else if (start > 0 && text[start - 1] === ',') start -= 1
  return text.slice(0, start) + text.slice(end)
}

function clearModelValues(text) {
  const needle = '"model":"'
  const out = []
  let i = 0
  while (true) {
    const j = text.indexOf(needle, i)
    if (j < 0) {
      out.push(text.slice(i))
      break
    }
    let k = j + needle.length
    while (k < text.length) {
      if (text[k] === '\\' && k + 1 < text.length) {
        k += 2
        continue
      }
      if (text[k] === '"') break
      k += 1
    }
    out.push(text.slice(i, j + needle.length))
    i = k
  }
  return out.join('')
}

function stripFallbacks(text) {
  const key = '"fallbacks":['
  const j = text.indexOf(key)
  if (j < 0) return text
  let i = j + key.length - 1
  let depth = 0
  let inStr = false
  let esc = false
  while (i < text.length) {
    const c = text[i]
    if (inStr) {
      esc = !esc || c !== '\\' ? !esc && c === '\\' : false
      if (c === '"' && !esc) inStr = false
      else if (c === '\\') esc = !esc
      else esc = false
    } else if (c === '"') inStr = true
    else if (c === '[') depth += 1
    else if (c === ']') {
      depth -= 1
      if (depth === 0) return cut(text, j, i + 1)
    }
    i += 1
  }
  return text
}

function stripFallbackCreditToken(text) {
  const key = '"fallback_credit_token":"'
  const j = text.indexOf(key)
  if (j < 0) return text
  let k = j + key.length
  while (k < text.length) {
    if (text[k] === '\\' && k + 1 < text.length) {
      k += 2
      continue
    }
    if (text[k] === '"') return cut(text, j, k + 1)
    k += 1
  }
  return text
}

function stripMaxTokens(text) {
  const key = '"max_tokens":'
  const j = text.indexOf(key)
  if (j < 0) return text
  let k = j + key.length
  if (k >= text.length || !/\d/.test(text[k])) return text
  while (k < text.length && /\d/.test(text[k])) k += 1
  return cut(text, j, k)
}

export function projectClaudeCodeCchText(raw) {
  const source = String(raw ?? '')
  const billingCch = /(x-anthropic-billing-header:[^"]*?\bcch=)[0-9a-f]{5}(?=;)/i
  if (!billingCch.test(source)) throw new Error('billing cch not found')
  const replaced = source.replace(billingCch, (_match, prefix) => `${prefix}00000`)
  return stripMaxTokens(stripFallbackCreditToken(stripFallbacks(clearModelValues(replaced))))
}

export function computeClaudeCodeCch(bodyBytes) {
  const h = xxh64(bodyBytes, CCH_XXH64_SEED)
  return (h & 0xfffffn).toString(16).padStart(5, '0')
}

function normalizeBillingCch(text) {
  return text.replace(/(^\s*x-anthropic-billing-header:)([^\r\n]*)/gim, (line) => {
    let found = false
    const normalized = line.replace(/\s*cch=[^;\s]*;?/gi, () => {
      if (found) return ''
      found = true
      return ` cch=${CCH_PLACEHOLDER};`
    })
    if (found) return normalized
    return `${normalized.trimEnd()}${normalized.trimEnd().endsWith(';') ? '' : ';'} cch=${CCH_PLACEHOLDER};`
  })
}

function normalizeSystemCch(body) {
  if (typeof body.system === 'string') {
    const system = normalizeBillingCch(body.system)
    return system === body.system ? body : { ...body, system }
  }
  if (!Array.isArray(body.system)) return body
  let changed = false
  const system = body.system.map((block) => {
    if (typeof block === 'string') {
      const text = normalizeBillingCch(block)
      changed ||= text !== block
      return text
    }
    if (!block || typeof block.text !== 'string') return block
    const text = normalizeBillingCch(block.text)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? { ...body, system } : body
}

/** Native hops leave the placeholder for the CLI's final SDK serialization. */
export function sealClaudeCodeCch(body, { enabled = true, seal = true } = {}) {
  if (body == null || (typeof body !== 'string' && typeof body !== 'object')) return body
  const stringBody = typeof body === 'string'
  const normalized = normalizeSystemCch(stringBody ? JSON.parse(body) : body)
  if (!enabled || !seal) return stringBody ? JSON.stringify(normalized) : normalized
  const raw = JSON.stringify(normalized)
  if (!/x-anthropic-billing-header:[^"]*cch=00000/i.test(raw)) return stringBody ? raw : normalized
  const cch = computeClaudeCodeCch(Buffer.from(projectClaudeCodeCchText(raw), 'utf8'))
  const sealed = raw.replace(/(x-anthropic-billing-header:[^"]*?cch=)00000/gi, `$1${cch}`)
  return stringBody ? sealed : JSON.parse(sealed)
}
