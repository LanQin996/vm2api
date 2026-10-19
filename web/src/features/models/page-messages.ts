/** 同步目录会重载策略并覆盖草稿；有未保存改动时要先问。没改动就直接同步。 */
export function syncConfirmText(dirty: boolean, label: string): string | null {
  if (!dirty) return null
  return `有未保存更改。同步${label}目录会重新载入模型策略，这些改动会丢失。确认同步？`
}

/** 恢复默认不可撤销，无论有没有草稿都要确认。 */
export function resetConfirmText(dirty: boolean): string {
  return dirty
    ? '恢复官方默认模型矩阵？已保存的自定义开关与参数，以及当前未保存的改动都会丢失。'
    : '恢复官方默认模型矩阵？已保存的自定义开关与参数将丢失。'
}

/** models.dev 拉取失败时网关仍回 200，状态在 `models_dev.status` 里。 */
export type ModelsDevSyncResult = {
  models_dev?: { status?: string; error?: string | null; models?: number }
}

export function modelsDevSyncOutcome(data?: ModelsDevSyncResult): {
  ok: boolean
  text: string
} {
  const status = data?.models_dev
  if (status?.status === 'error') {
    return {
      ok: false,
      text: `models.dev 同步失败：${status.error || '未知错误'}，继续使用上次的价格`,
    }
  }
  return {
    ok: true,
    text:
      status?.models != null
        ? `已同步 models.dev（${status.models} 个模型）`
        : '已同步 models.dev',
  }
}
