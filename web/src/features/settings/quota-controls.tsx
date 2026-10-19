import { type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { CircleAlert, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RATIO_STEPS, withCurrent } from '@/features/vm/scheduling-steps'
import { recordOf } from './quota-values'
import { ChipGroup, SliderSetting } from './scheduler-controls'

function ratioOptions(current: number): [number, string][] {
  return withCurrent(
    RATIO_STEPS.map((value): [number, string] => [value, `${value}%`]),
    current
  )
}

export function RatioSetting({
  id,
  label,
  value,
  fallback,
  onChange,
}: {
  id: string
  label: string
  value: number
  fallback: number
  onChange: (value: number) => void
}) {
  const percent = Math.round(value * 100)
  return (
    <div className='space-y-2'>
      <SliderSetting
        id={id}
        label={label}
        value={percent}
        min={30}
        max={100}
        step={1}
        format={(next) => `${next}%`}
        fallback={fallback * 100}
        onChange={(next) => onChange(next / 100)}
      />
      <ChipGroup
        label={`${label}常用值`}
        value={percent}
        options={ratioOptions(percent)}
        onChange={(next) => onChange(next / 100)}
      />
    </div>
  )
}

export function QuotaSummary({
  icon: Icon,
  title,
  value,
  desc,
  pending,
  buttonRef,
  disabled,
  onClick,
}: {
  icon: LucideIcon
  title: string
  value: ReactNode
  desc: string
  pending: boolean
  buttonRef: (node: HTMLButtonElement | null) => void
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      ref={buttonRef}
      type='button'
      variant='outline'
      disabled={disabled}
      onClick={onClick}
      className='h-auto min-h-24 min-w-0 justify-start gap-3 px-4 py-3 text-left'
    >
      <Icon className='size-4 shrink-0 text-primary' aria-hidden />
      <span className='min-w-0'>
        <span className='flex items-center gap-2 text-xs text-muted-foreground'>
          <span className='truncate'>{title}</span>
          {pending ? (
            <span className='shrink-0 rounded bg-[color:var(--status-caution)]/15 px-1.5 py-0.5 text-[10px] text-[color:var(--status-caution)]'>
              待保存
            </span>
          ) : null}
        </span>
        <span className='block text-sm leading-5 font-semibold break-words whitespace-normal'>
          {value}
        </span>
        <span className='block truncate text-xs font-normal text-muted-foreground'>
          {desc}
        </span>
      </span>
    </Button>
  )
}

export function PlatformAccountList({
  platform,
  items,
  loading,
  error,
}: {
  platform: 'claude' | 'openai'
  items: Vm[]
  loading: boolean
  error: unknown
}) {
  if (loading) {
    return (
      <p className='rounded-md border px-3 py-6 text-center text-sm text-muted-foreground'>
        读取账号状态中…
      </p>
    )
  }
  if (error) {
    return (
      <div className='flex items-start gap-2 rounded-md border border-[color:var(--status-bad)]/40 px-3 py-3 text-sm text-[color:var(--status-bad)]'>
        <CircleAlert className='mt-0.5 size-4 shrink-0' aria-hidden />
        <span>
          账号状态读取失败：
          {error instanceof Error ? error.message : String(error)}
        </span>
      </div>
    )
  }
  if (!items.length) {
    return (
      <div className='rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground'>
        当前没有 {platform === 'claude' ? 'Claude' : 'OpenAI'}{' '}
        VM；全局策略仍可保存。
      </div>
    )
  }
  return (
    <div className='space-y-2'>
      {items.map((vm) => {
        const hasSource =
          platform === 'claude'
            ? Object.keys(recordOf(vm.quota_override)).length > 0
            : vm.concurrency_override === true ||
              vm.rpm_override === true ||
              vm.max_sessions_override === true
        const status = vm.availability?.text || vm.status || '状态未知'
        return (
          <div
            key={vm.id}
            className='flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5'
          >
            <div className='max-w-full min-w-0 flex-1 basis-40'>
              <div className='truncate text-sm font-medium' title={vm.id}>
                {vm.name || vm.id}
              </div>
              <div className='mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground'>
                <span>来源：{hasSource ? '本槽覆盖' : '跟随全局'}</span>
                <span>状态：{status}</span>
              </div>
            </div>
            <Link
              to='/vm/$id'
              params={{ id: vm.id }}
              className='inline-flex min-h-11 items-center gap-1 text-xs text-primary hover:underline'
            >
              查看 VM 调度
            </Link>
          </div>
        )
      })}
    </div>
  )
}
