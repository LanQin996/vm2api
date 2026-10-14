import { useState } from 'react'
import { format, subDays } from 'date-fns'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { RepriceResult } from '@/types/panel-pricing'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtUsd } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { invalidatePricing } from '@/features/models/queries'

function toLocal(d: Date): string {
  return format(d, "yyyy-MM-dd'T'HH:mm")
}

function defaultRange() {
  const until = new Date()
  return {
    since: toLocal(subDays(until, 7)),
    until: toLocal(until),
  }
}

export function RepriceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [range, setRange] = useState(defaultRange)
  const [result, setResult] = useState<RepriceResult | null>(null)

  const reprice = useMutation({
    mutationFn: () => {
      const since = new Date(range.since)
      const until = new Date(range.until)
      if (
        !Number.isFinite(since.getTime()) ||
        !Number.isFinite(until.getTime())
      ) {
        throw new Error('时间无效')
      }
      if (since >= until) throw new Error('起始时间必须早于结束时间')
      return api<RepriceResult>('/api/panel/pricing/reprice', {
        method: 'POST',
        body: JSON.stringify({
          since: since.toISOString(),
          until: until.toISOString(),
        }),
      })
    },
    onSuccess: async (data) => {
      setResult(data)
      toast.success(
        `已重算 ${data.rows} 行，改写 ${data.changed}，仍未定价 ${data.still_unpriced}`
      )
      await invalidatePricing(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setResult(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>按当前价重算</DialogTitle>
          <DialogDescription>
            只改写 total_cost 及其分项，并给未定价行补价。actual_cost
            与倍率不动。
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label htmlFor='reprice-since'>起始</Label>
            <Input
              id='reprice-since'
              type='datetime-local'
              value={range.since}
              onChange={(e) =>
                setRange((prev) => ({ ...prev, since: e.target.value }))
              }
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='reprice-until'>结束</Label>
            <Input
              id='reprice-until'
              type='datetime-local'
              value={range.until}
              onChange={(e) =>
                setRange((prev) => ({ ...prev, until: e.target.value }))
              }
            />
          </div>
        </div>
        {result ? (
          <dl className='grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 text-sm'>
            <div>
              <dt className='text-xs text-muted-foreground'>处理行</dt>
              <dd className='font-mono tabular-nums'>{result.rows}</dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>改写</dt>
              <dd className='font-mono tabular-nums'>{result.changed}</dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>仍未定价</dt>
              <dd className='font-mono tabular-nums'>
                {result.still_unpriced}
              </dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>差额 USD</dt>
              <dd className='font-mono tabular-nums'>
                {result.delta_usd > 0 ? '+' : ''}
                {fmtUsd(result.delta_usd, 4)}
              </dd>
            </div>
          </dl>
        ) : null}
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
          <Button
            type='button'
            disabled={reprice.isPending}
            onClick={() => reprice.mutate()}
          >
            {reprice.isPending ? '重算中…' : '开始重算'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
