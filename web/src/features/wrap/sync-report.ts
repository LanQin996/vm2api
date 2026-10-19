import { isApiError } from '@/lib/api'
import type { WrapSyncReport } from './queries'

type SyncItem = NonNullable<WrapSyncReport['items']>[number]

/**
 * 槽同步部分失败时网关回 400/503，但正文仍是 `{ ok: true, data: 报告 }`；
 * api() 抛错时把 data 留在 ApiError 上，这里把逐槽报告取回来。
 */
export function syncReportFromError(error: unknown): WrapSyncReport | null {
  if (!isApiError(error)) return null
  const data = error.data
  if (!data || typeof data !== 'object') return null
  const rec = data as Record<string, unknown>
  if (Array.isArray(rec.items)) return rec as WrapSyncReport
  const sync = rec.sync as Record<string, unknown> | undefined
  if (sync && Array.isArray(sync.items)) return sync as WrapSyncReport
  return null
}

export function syncItemFailed(item: SyncItem): boolean {
  return item.ok === false || item.kernel?.ok === false
}

function itemReason(item: SyncItem): string {
  return String(item.error || item.kernel?.error || item.code || '').trim()
}

export function slotFailureLabel(item: SyncItem): string {
  const reason = itemReason(item)
  return `${item.id || '?'}${reason ? `（${reason}）` : ''}`
}

/** 「3/5 槽成功；失败 vm-1（原因）、vm-2…」 */
export function syncReportSummary(report: WrapSyncReport, limit = 3): string {
  const items = report.items || []
  const total = report.total ?? items.length
  const failed = items.filter(syncItemFailed)
  const ok = report.ok_count ?? items.length - failed.length
  const head = `${ok}/${total} 槽成功`
  if (!failed.length) return head
  const shown = failed.slice(0, limit).map(slotFailureLabel).join('、')
  const more = failed.length > limit ? ` 等 ${failed.length} 台` : ''
  return `${head}；失败 ${shown}${more}`
}
