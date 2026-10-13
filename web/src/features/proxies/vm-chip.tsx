import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { GripVertical, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 槽位拖拽的 dataTransfer 类型。自定义 MIME，避免和文本拖拽混淆。 */
export const VM_DRAG_TYPE = 'application/x-vm2api-vm'

const DOT: Record<'ok' | 'bad' | 'none', string> = {
  ok: 'var(--status-ok-solid)',
  bad: 'var(--status-bad-solid)',
  none: 'var(--status-none)',
}

/**
 * 槽位小片：名字链到槽位详情，整片可拖去别的代理行换绑。
 * 圆点只表达「这台槽位出站是否被拒」：有凭证无代理为红，其余中性。
 */
export function VmChip({
  vm,
  vmId,
  tone,
  disabled,
  compact = false,
  onUnbind,
  onDragChange,
}: {
  vm?: Vm
  /** 槽位已不在舰队里（残留绑定）时仍要展示 id。 */
  vmId?: string
  tone: 'ok' | 'bad' | 'none'
  disabled?: boolean
  /** 表格行内用：去掉拖拽把手，整片仍可拖。 */
  compact?: boolean
  onUnbind?: () => void
  onDragChange: (vmId: string) => void
}) {
  const id = vm?.id || vmId || ''
  const name = vm?.name || id
  return (
    <span
      draggable={!disabled}
      onDragStart={(e) => {
        e.dataTransfer.setData(VM_DRAG_TYPE, id)
        e.dataTransfer.setData('text/plain', name)
        e.dataTransfer.effectAllowed = 'move'
        onDragChange(id)
      }}
      onDragEnd={() => onDragChange('')}
      className={cn(
        'group/chip inline-flex h-6 max-w-full items-center gap-1 rounded-md border bg-background pe-1.5 text-xs transition-colors',
        compact ? 'ps-1.5' : 'ps-1',
        !disabled &&
          'cursor-grab hover:border-foreground/25 active:cursor-grabbing'
      )}
    >
      {compact ? null : (
        <GripVertical
          aria-hidden='true'
          className='size-3 shrink-0 text-muted-foreground/50 group-hover/chip:text-muted-foreground'
        />
      )}
      <span
        aria-hidden='true'
        className='size-1.5 shrink-0 rounded-full'
        style={{ backgroundColor: DOT[tone] }}
      />
      {vm ? (
        <Link
          to='/vm/$id'
          params={{ id }}
          draggable={false}
          className='truncate underline-offset-2 hover:underline'
        >
          {name}
        </Link>
      ) : (
        <span className='truncate text-muted-foreground' title='槽位已不存在'>
          {name}
        </span>
      )}
      {onUnbind ? (
        <button
          type='button'
          aria-label={`解绑 ${name}`}
          title='解绑'
          disabled={disabled}
          onClick={onUnbind}
          className='-me-0.5 grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50'
        >
          <X className='size-3' aria-hidden='true' />
        </button>
      ) : null}
    </span>
  )
}
