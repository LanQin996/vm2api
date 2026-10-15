import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Check, CircleAlert, Loader2, Minus, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SlotIdentity } from '@/components/platform-chip'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { vmDiagnoseQueryOptions } from '@/features/vm/use-vm-recovery'
import {
  firstFailingCheck,
  firstRecoverFailure,
  type CheckStatus,
  type Diagnosis,
  type DiagnosisCheck,
  type RecoverReport,
  type RecoverStep,
} from '@/features/vm/vm-recovery-types'

const CHECK_TONE: Record<CheckStatus, { icon: typeof Check; color: string }> = {
  ok: { icon: Check, color: 'var(--status-ok)' },
  warn: { icon: CircleAlert, color: 'var(--status-warn)' },
  error: { icon: X, color: 'var(--status-bad)' },
  skip: { icon: Minus, color: 'var(--status-none)' },
}

function toastApiError(error: Error) {
  const code = isApiError(error) ? error.code : ''
  toast.error(code ? `${error.message} [${code}]` : error.message)
}

function CheckRow({ check }: { check: DiagnosisCheck }) {
  const tone = CHECK_TONE[check.status] ?? CHECK_TONE.skip
  const Icon = tone.icon
  return (
    <li className='flex min-w-0 items-start gap-2 text-sm'>
      <Icon
        className='mt-0.5 size-3.5 shrink-0'
        style={{ color: tone.color }}
        aria-hidden='true'
      />
      <div className='min-w-0 flex-1'>
        <div className='flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5'>
          <span className='font-medium'>{check.label}</span>
          {check.code ? (
            <span className='font-mono text-xs text-muted-foreground'>
              {check.code}
            </span>
          ) : null}
        </div>
        <p className='text-xs break-words text-muted-foreground'>
          {check.message}
        </p>
      </div>
    </li>
  )
}

function DiagnosisList({ diagnosis }: { diagnosis: Diagnosis }) {
  return (
    <ul className='space-y-2'>
      {diagnosis.checks.map((check) => (
        <CheckRow key={check.id} check={check} />
      ))}
    </ul>
  )
}

function StepRow({ step }: { step: RecoverStep }) {
  const Icon = step.ok ? Check : X
  const color = step.ok ? 'var(--status-ok)' : 'var(--status-bad)'
  return (
    <li className='flex min-w-0 items-start gap-2 text-sm'>
      <Icon
        className='mt-0.5 size-3.5 shrink-0'
        style={{ color }}
        aria-hidden='true'
      />
      <div className='min-w-0 flex-1'>
        <div className='flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5'>
          <span className='font-medium'>{step.label}</span>
          {step.code ? (
            <span className='font-mono text-xs text-muted-foreground'>
              {step.code}
            </span>
          ) : null}
          <span className='ms-auto shrink-0 text-xs text-muted-foreground tabular-nums'>
            {step.ms}ms
          </span>
        </div>
        <p className='text-xs break-words text-muted-foreground'>
          {step.message}
        </p>
      </div>
    </li>
  )
}

export function VmRecoveryDialog({
  vm,
  open,
  onOpenChange,
}: {
  vm: Vm | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const vmId = vm?.id ?? ''
  const [report, setReport] = useState<RecoverReport | null>(null)
  const diagnose = useQuery(vmDiagnoseQueryOptions(vmId, open && !!vmId))

  useEffect(() => {
    setReport(null)
  }, [open, vmId])

  const recover = useMutation({
    mutationFn: (id: string) =>
      api<RecoverReport>(`/api/panel/vms/${encodeURIComponent(id)}/recover`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: async (data) => {
      if (data.vm_id === vmId) setReport(data)
      qc.setQueryData(
        vmDiagnoseQueryOptions(data.vm_id).queryKey,
        data.diagnosis
      )
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({
          queryKey: vmQueryOptions(data.vm_id).queryKey,
        }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
      if (data.ok) {
        toast.success(`服务已恢复 · ${data.duration_ms}ms`)
        return
      }
      const fail = firstRecoverFailure(data)
      toast.error(
        fail.code
          ? `恢复失败：[${fail.code}] ${fail.message}`
          : `恢复失败：${fail.message}`
      )
    },
    onError: (error: Error) => toastApiError(error),
  })

  const diagnosis = report?.diagnosis ?? diagnose.data
  const failing = diagnosis ? firstFailingCheck(diagnosis) : null
  const summary = !diagnosis
    ? null
    : diagnosis.ok
      ? '正常'
      : (failing?.label ?? '异常')
  const summaryColor = !diagnosis
    ? undefined
    : diagnosis.ok
      ? 'var(--status-ok)'
      : failing?.status === 'warn'
        ? 'var(--status-warn)'
        : 'var(--status-bad)'
  const pending = recover.isPending
  const busy = pending || diagnose.isFetching

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[88vh] flex-col gap-3 sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2 text-base'>
            恢复服务
            {vm ? <SlotIdentity vm={vm} compact /> : null}
          </DialogTitle>
          <DialogDescription>
            检查槽位链路，必要时关机再开机拉起服务。
          </DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 space-y-3 overflow-y-auto pe-3'>
          {summary ? (
            <p className='text-sm'>
              检查结果：
              <span className='font-medium' style={{ color: summaryColor }}>
                {summary}
              </span>
            </p>
          ) : diagnose.isLoading ? (
            <p className='flex items-center gap-1.5 text-sm text-muted-foreground'>
              <Loader2 className='size-3.5 animate-spin' />
              正在检查槽位服务…
            </p>
          ) : null}
          {diagnose.isError ? (
            <p className='text-sm text-[color:var(--status-bad)]'>
              {(diagnose.error as Error).message}
            </p>
          ) : null}
          {diagnosis ? <DiagnosisList diagnosis={diagnosis} /> : null}
          {report ? (
            <div className='space-y-2'>
              <p className='text-xs font-medium text-muted-foreground'>
                执行步骤
                <span className='ms-2 font-normal tabular-nums'>
                  {report.duration_ms}ms
                </span>
              </p>
              <ul className='space-y-2'>
                {report.steps.map((step) => (
                  <StepRow key={step.id} step={step} />
                ))}
              </ul>
            </div>
          ) : null}
          {pending ? (
            <p className='flex items-center gap-1.5 text-sm text-muted-foreground'>
              <Loader2 className='size-3.5 animate-spin' />
              正在关机并重新拉起服务，大约需要 30–60 秒…
            </p>
          ) : null}
          <p className='text-xs text-[color:var(--status-warn)]'>
            恢复服务会中断该槽位正在进行的对话。
          </p>
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            disabled={!vmId || busy}
            onClick={() => {
              setReport(null)
              void diagnose.refetch()
            }}
          >
            重新检查
          </Button>
          <Button
            disabled={!vmId || pending}
            loading={pending}
            onClick={() => recover.mutate(vmId)}
          >
            恢复服务（关机→开机）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
