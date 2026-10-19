import { opsSince } from '@/lib/ops-window'
import type { ExportOptions, ExportWindow } from './export-dialog'
import {
  filtersToApi,
  type LogsFilterState,
  usageLogFiltersQuery,
} from './search'

/** 导出窗口起点。`opsSince` 只认 1h/6h/24h，7d 在这里补。 */
function exportSince(window: ExportWindow): string | null {
  if (!window) return null
  if (window === '7d') {
    const t = Date.now() - 7 * 86400_000
    return new Date(t - (t % 60_000)).toISOString()
  }
  return opsSince(window)
}

/**
 * 导出查询串。「跟随当前筛选」与列表走同一套 `filtersToApi` → 查询串，
 * 后端导出也用列表的筛选解析，所以导出的就是页面上看到的那些行。
 */
export function exportQuery(
  opts: ExportOptions,
  filters: LogsFilterState,
  muted: readonly string[]
): URLSearchParams {
  const since = exportSince(opts.window)
  let qs: URLSearchParams
  if (opts.scope === 'current') {
    const api = filtersToApi(filters, muted)
    if (opts.includeMuted && !api.errorClass) {
      delete api.excludeErrorClass
      api.includeMuted = true
    }
    if (since) api.startTime = since
    qs = usageLogFiltersQuery(api)
  } else {
    qs = new URLSearchParams()
    if (opts.scope === 'all') {
      // 不带 include_muted 时服务端默认屏蔽仍会吃掉数据。
      qs.set('include_muted', '1')
    } else if (opts.errorClass) {
      qs.set('error_class', opts.errorClass)
    } else {
      qs.set('status', 'error')
      if (opts.includeMuted) qs.set('include_muted', '1')
      else if (muted.length) qs.set('exclude_error_class', muted.join(','))
    }
    if (since) qs.set('start_time', since)
  }
  qs.set('format', opts.format)
  qs.set('limit', String(opts.limit))
  return qs
}
