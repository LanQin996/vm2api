export type KeyResult = {
  ok?: boolean
  status?: number
  text?: string
  error?: string
  proxy?: boolean
  row?: number
}

export type ConsoleResult = KeyResult & {
  items?: KeyResult[]
}

export function endpointHasTestableKey(endpoint: {
  apiKey: string
  keyId?: string
}): boolean {
  return Boolean(endpoint.apiKey.trim() || endpoint.keyId)
}

/** Map panel batch results onto endpoint rows; never bind by filtered-array offset. */
export function applyConsoleResults(
  endpoints: { id: string }[],
  hasKey: (row: number) => boolean,
  current: Record<string, KeyResult>,
  data: ConsoleResult,
  index: number | null
): Record<string, KeyResult> {
  const incoming = data.items?.length ? data.items : [data]
  const next = { ...current }

  if (index == null) {
    endpoints.forEach((endpoint, row) => {
      if (!hasKey(row)) delete next[endpoint.id]
    })
    for (const item of incoming) {
      const row = item.row
      if (row == null || row < 0 || row >= endpoints.length) continue
      next[endpoints[row].id] = item
    }
    return next
  }

  const endpoint = endpoints[index]
  if (!endpoint) return next
  const item =
    incoming.find((entry) => entry.row === index) ??
    (incoming.length === 1 ? incoming[0] : undefined)
  if (item) next[endpoint.id] = item
  return next
}
