const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  interval_sec: 86400,
  vm_id: '',
  model: 'gpt-5.4',
  max_tokens: 4096,
  min_confidence: 0.55,
})

function int(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

export function normalizeModelTraceConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: src.enabled === true,
    interval_sec: int(src.interval_sec, 3600, 604800, DEFAULT_CONFIG.interval_sec),
    vm_id: String(src.vm_id || '')
      .trim()
      .slice(0, 80),
    model:
      String(src.model || DEFAULT_CONFIG.model)
        .trim()
        .slice(0, 120) || DEFAULT_CONFIG.model,
    max_tokens: int(src.max_tokens, 1024, 8192, DEFAULT_CONFIG.max_tokens),
    min_confidence: Math.min(0.95, Math.max(0.3, Number(src.min_confidence) || DEFAULT_CONFIG.min_confidence)),
  }
}
