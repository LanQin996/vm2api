/**
 * Prompt-cache hit rate.
 * After billing normalize, `input_tokens` is the uncached slice for every
 * provider: prompt = input + read + write.
 * Per-row SQL twin over usage_logs: PROMPT_TOKENS_SQL in db/repos/usage-log-preds.mjs.
 */
export function cacheHitStats({
  input_tokens = 0,
  cache_read_tokens = 0,
  cache_creation_tokens = 0,
  prompt_tokens = null,
} = {}) {
  const input = Number(input_tokens) || 0
  const read = Number(cache_read_tokens) || 0
  const write = Number(cache_creation_tokens) || 0
  // Mixed-provider aggregates may supply a denominator computed per usage row.
  const prompt = prompt_tokens == null ? input + read + write : Number(prompt_tokens) || 0
  return {
    input_tokens: input,
    cache_read_tokens: read,
    cache_creation_tokens: write,
    prompt_tokens: prompt,
    cache_hit_rate: prompt > 0 ? Math.min(1, read / prompt) : null,
  }
}
