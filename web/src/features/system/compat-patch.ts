import {
  personaInjectFromPreset,
  personaPresetFromCompat,
} from '@/lib/persona-template'

type Compat = Record<string, unknown>

/**
 * 系统提示词页保存体：只发 `compatibility` 里改过的键。PUT /routing 按段合并、
 * compatibility 内再浅合并，整份回写会把别处（设置页、其它标签）改过的值回滚。
 * persona_preset / persona_inject 照旧每次都带，后端据此重推内核人设。
 */
export function compatibilityPatch(
  draft: Compat,
  server: Compat | undefined
): { compatibility: Compat } {
  const preset = personaPresetFromCompat(draft)
  const full: Compat = {
    ...draft,
    persona_preset: preset,
    persona_inject: personaInjectFromPreset(preset, draft.persona_inject),
  }
  const out: Compat = {}
  for (const [key, value] of Object.entries(full)) {
    if (JSON.stringify(value) !== JSON.stringify(server?.[key]))
      out[key] = value
  }
  out.persona_preset = full.persona_preset
  out.persona_inject = full.persona_inject
  return { compatibility: out }
}
