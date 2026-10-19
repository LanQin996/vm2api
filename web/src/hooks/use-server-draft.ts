import { useEffect, useRef, useState } from 'react'
import { resyncDraft } from './server-draft'

/** `toDraft` 和 `differs` 须是稳定引用（模块级函数）。 */
export function useServerDraft<S, D>(
  data: S | undefined,
  toDraft: (data: S) => D,
  differs: (a: D, b: D) => boolean
) {
  const [draft, setDraft] = useState<D | null>(null)
  const base = useRef<D | null>(null)
  useEffect(() => {
    if (data === undefined) return
    const next = toDraft(data)
    const prev = base.current
    base.current = next
    setDraft((cur) => resyncDraft(cur, prev, next, differs))
  }, [data, toDraft, differs])
  return [draft, setDraft] as const
}
