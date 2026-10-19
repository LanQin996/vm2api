import type { OpenAIQuotaPolicy } from '@/types/panel-vm'
import { cn } from '@/lib/utils'

export type Obj = Record<string, unknown>

export const OPENAI_DEFAULTS: OpenAIQuotaPolicy = {
  limit_5h: 1,
  limit_7d: 1,
  max_concurrency: 2,
  max_rpm: 0,
  max_sessions: 0,
}

export const OPENAI_SESSION_STEPS: [number, string][] = [
  [0, '不限'],
  [1, '1'],
  [2, '2'],
  [4, '4'],
  [8, '8'],
  [16, '16'],
  [32, '32'],
  [64, '64'],
  [128, '128'],
  [256, '256'],
]

export function numberOf(value: unknown, fallback: number): number {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

export function recordOf(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : {}
}

export function formatRpm(value: number): string {
  return value === 0 ? '不限' : `${value}`
}

export function openaiPolicy(
  source: Partial<OpenAIQuotaPolicy> | undefined
): OpenAIQuotaPolicy {
  return { ...OPENAI_DEFAULTS, ...source }
}
export function quotaDialogClass(kind: string, tall: boolean) {
  return cn(
    'max-h-[90dvh] overflow-hidden sm:max-w-2xl',
    tall && kind === 'gates'
      ? 'grid h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto]'
      : 'flex flex-col'
  )
}
