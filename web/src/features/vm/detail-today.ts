import type { Vm } from '@/types/panel-vm'

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export type VmTodayCounts = { requests: number; input: number; output: number }

/**
 * 今日请求 / 入 / 出。槽位上的 today_* 与详情 billing.today 同源；
 * 槽位没带出 token 时退回 billing.today，再退回 today_tokens 减其余三项。
 * 不读 requests / tokens_in（那是累计计数）或 window_5h_requests。
 */
export function vmTodayCounts(
  vm: Vm,
  billing?: Record<string, unknown> | null
): VmTodayCounts {
  const raw = billing?.today
  const t =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const input = num(vm.today_input_tokens ?? t?.input_tokens)
  const derivedOut = Math.max(
    0,
    num(vm.today_tokens) -
      input -
      num(vm.today_cache_read_tokens) -
      num(vm.today_cache_creation_tokens)
  )
  return {
    requests: num(vm.today_requests ?? t?.requests),
    input,
    output: num(vm.today_output_tokens ?? t?.output_tokens ?? derivedOut),
  }
}

type StartResponse = {
  vm?: { schedulable?: boolean }
  boot?: {
    rust_ok?: boolean
    rust?: { error?: unknown; reason?: unknown; code?: unknown }
  }
}

/**
 * POST /start 的结果。容器起来但内核没就绪时后端仍回 200、boot.rust_ok=false，
 * 不能报成功。开机会按有无凭证重开调度，一并说明。
 */
export function bootOutcome(data: unknown): { ok: boolean; message: string } {
  const res = (data || {}) as StartResponse
  if (res.boot?.rust_ok === false) {
    const r = res.boot.rust || {}
    const why = r.error || r.reason || r.code
    return {
      ok: false,
      message: `已开机，但内核未就绪${why ? `：${String(why)}` : ''}`,
    }
  }
  return {
    ok: true,
    message: res.vm?.schedulable === true ? '已开机，调度已开启' : '已开机',
  }
}
