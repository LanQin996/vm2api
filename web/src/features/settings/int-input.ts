/** 输入框文本 → 整数并限到 [min, max]；空或非数字回落到 fallback。 */
export function settleInt(
  raw: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (!raw.trim()) return fallback
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 输入过程中的值：只要是数字就原样交出去，不限范围，失焦时再用 settleInt 收口。 */
export function typingInt(raw: string): number | null {
  if (!raw.trim()) return null
  const n = Math.round(Number(raw))
  return Number.isFinite(n) ? n : null
}
