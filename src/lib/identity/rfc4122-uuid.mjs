import crypto from 'node:crypto'

/** RFC4122 string form (any version/variant nibble). */
export const RFC4122_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isRfc4122Uuid(value) {
  const s = String(value ?? '').trim()
  if (!s || s === '-') return false
  return RFC4122_UUID_RE.test(s)
}

/** Never pass empty, `-`, or malformed values to QEMU `-uuid`. */
export function coerceRfc4122Uuid(value) {
  const s = String(value ?? '').trim()
  if (isRfc4122Uuid(s)) return s.toLowerCase()
  return crypto.randomUUID()
}
