import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { patchVm } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Segmented } from '@/components/choice-tiles'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  runtimeTypeOf,
  VM_MEMORY_LABELS,
  VM_MEMORY_OPTIONS,
  type VmMemoryOption,
} from '@/features/vm/machine-spec'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'

function configuredMemory(vm: Vm): VmMemoryOption | string {
  const raw =
    vm.machine?.memory || (vm.runtime?.memory as string | undefined) || '512m'
  return VM_MEMORY_OPTIONS.includes(raw as VmMemoryOption)
    ? (raw as VmMemoryOption)
    : String(raw)
}

function memoryIndex(value: string) {
  const idx = VM_MEMORY_OPTIONS.indexOf(value as VmMemoryOption)
  return idx >= 0 ? idx : VM_MEMORY_OPTIONS.indexOf('512m')
}

function VmMemoryBlockInner({ vm }: { vm: Vm }) {
  const current = configuredMemory(vm)
  const runtimeMem =
    typeof vm.runtime?.memory === 'string' ? vm.runtime.memory : null
  const minIdx = memoryIndex(String(current))
  const raiseOptions = useMemo(
    () =>
      VM_MEMORY_OPTIONS.filter((_, i) => i > minIdx).map((id) => ({
        value: id,
        label: VM_MEMORY_LABELS[id],
      })),
    [minIdx]
  )

  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<VmMemoryOption | null>(
    (raiseOptions[0]?.value as VmMemoryOption) ?? null
  )
  const qc = useQueryClient()

  const save = useMutation({
    mutationFn: (memory: VmMemoryOption) =>
      patchVm<{ memory_raise?: { memory?: string } }>(vm.id, {
        machine: { memory },
      }),
    onSuccess: async (data) => {
      const applied = data?.memory_raise?.memory
      toast.success(applied ? `内存已提升至 ${applied}` : '内存已提升')
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
      setOpen(false)
    },
    onError: (error: Error) => toast.error(error.message || '提升内存失败'),
  })

  if (!raiseOptions.length) {
    return (
      <div className='space-y-1 rounded-md border px-2.5 py-2 text-xs'>
        <div className='font-medium'>内存</div>
        <div className='text-muted-foreground'>
          配置 {VM_MEMORY_LABELS[current as VmMemoryOption] || current}
          {runtimeMem && runtimeMem !== current
            ? ` · 容器 ${VM_MEMORY_LABELS[runtimeMem as VmMemoryOption] || runtimeMem}`
            : ''}
          {' · 已是可选上限'}
        </div>
      </div>
    )
  }

  return (
    <div className='space-y-2 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2'>
      <div className='flex items-center justify-between gap-2'>
        <div className='min-w-0 text-xs'>
          <div className='font-medium'>内存</div>
          <div className='text-muted-foreground'>
            配置 {VM_MEMORY_LABELS[current as VmMemoryOption] || current}
            {runtimeMem && runtimeMem !== current
              ? ` · 容器 ${VM_MEMORY_LABELS[runtimeMem as VmMemoryOption] || runtimeMem}`
              : ''}
          </div>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 text-xs'
            >
              提升
            </Button>
          </DialogTrigger>
          <DialogContent className='sm:max-w-md'>
            <DialogHeader>
              <DialogTitle>提升容器内存</DialogTitle>
              <DialogDescription>
                在线执行 docker update，成功后才写入槽位配置。不支持降配或 KVM。
              </DialogDescription>
            </DialogHeader>
            <div className='space-y-2'>
              <div className='text-xs text-muted-foreground'>
                当前 {VM_MEMORY_LABELS[current as VmMemoryOption] || current}
              </div>
              <Segmented
                label='目标内存'
                value={target || raiseOptions[0].value}
                onChange={(v) => setTarget(v as VmMemoryOption)}
                options={raiseOptions}
              />
            </div>
            <DialogFooter>
              <Button
                type='button'
                disabled={!target || save.isPending}
                onClick={() => target && save.mutate(target)}
              >
                {save.isPending ? '应用中…' : '确认提升'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <p className={cn('text-[11px] text-muted-foreground')}>
        仅可上调；memory-swap 与 memory 同步，不重建容器。
      </p>
    </div>
  )
}

export function VmMemoryBlock({ vm }: { vm: Vm }) {
  if (runtimeTypeOf(vm) !== 'docker') return null
  return <VmMemoryBlockInner vm={vm} />
}
