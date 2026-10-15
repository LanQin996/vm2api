import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Diagnosis } from '@/features/vm/vm-recovery-types'

export function vmDiagnoseQueryOptions(id: string, enabled = true) {
  return queryOptions({
    queryKey: ['panel', 'vm', id, 'diagnose'] as const,
    queryFn: () =>
      api<Diagnosis>(`/api/panel/vms/${encodeURIComponent(id)}/diagnose`),
    enabled: enabled && !!id,
  })
}
