import { useState } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { proxyLabel } from './proxy-sort'

/**
 * 给一条代理挑槽位。选中即绑定 —— 挑选本身就是明确动作，不再要求二次点「绑定」。
 *
 * 候选分两组：没接任何代理的槽位排前面（有凭证的会 fail closed，最需要处理）；
 * 已接别的代理的放后面并标出来源，选中等于从那条换绑过来。
 */
export function ProxyBindPicker({
  vms,
  boundHere,
  ownerOf,
  free,
  disabled,
  compact = false,
  onBind,
}: {
  vms: Vm[]
  /** 已绑在这条代理上的槽位，不进候选。 */
  boundHere: string[]
  /** 槽位 → 当前所在代理。 */
  ownerOf: Map<string, VmProxySnap>
  /** 剩余席位数。 */
  free: number
  disabled: boolean
  /** 表格行内用：只留「+ 空 n」。 */
  compact?: boolean
  onBind: (vmId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const candidates = vms.filter((v) => !boundHere.includes(v.id))
  const loose = candidates.filter((v) => !ownerOf.has(v.id))
  const moving = candidates.filter((v) => ownerOf.has(v.id))

  if (!candidates.length) {
    return compact ? null : (
      <span className='text-xs text-muted-foreground'>无可绑槽位</span>
    )
  }

  const pick = (vmId: string) => {
    setOpen(false)
    onBind(vmId)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          aria-label={`绑定槽位，空 ${free}`}
          title='绑定槽位'
          className={cn(
            'inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-dashed border-foreground/25 text-xs text-muted-foreground transition-colors',
            compact ? 'px-1.5' : 'px-2',
            'hover:border-primary/60 hover:bg-primary/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
            'data-[state=open]:border-primary/60 data-[state=open]:text-foreground'
          )}
        >
          <Plus className='size-3.5' aria-hidden='true' />
          {compact ? null : '绑定槽位'}
          <span className='text-muted-foreground/80 tabular-nums'>
            {compact ? `空 ${free}` : `· 空 ${free}`}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-72 p-0'>
        <Command>
          <CommandInput placeholder='搜槽位名或 ID' />
          <CommandList>
            <CommandEmpty>没有匹配的槽位</CommandEmpty>
            {loose.length ? (
              <CommandGroup heading='无代理'>
                {loose.map((v) => (
                  <CommandItem
                    key={v.id}
                    value={v.id}
                    keywords={[v.name || '']}
                    onSelect={() => pick(v.id)}
                  >
                    <span className='truncate'>{v.name || v.id}</span>
                    {v.has_token ? (
                      <span className='ms-auto shrink-0 text-[11px] text-[color:var(--status-bad)]'>
                        出站被拒
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {moving.length ? (
              <CommandGroup heading='从其它代理换绑'>
                {moving.map((v) => {
                  const from = ownerOf.get(v.id)
                  return (
                    <CommandItem
                      key={v.id}
                      value={v.id}
                      keywords={[v.name || '']}
                      onSelect={() => pick(v.id)}
                    >
                      <span className='truncate'>{v.name || v.id}</span>
                      <span className='field-host ms-auto max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground'>
                        {from ? proxyLabel(from) : ''}
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
