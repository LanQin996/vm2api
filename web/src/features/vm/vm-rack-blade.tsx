import {
  memo,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { Clock, Download, Link2, RefreshCw } from 'lucide-react'
import { credEndpointLabel, credEndpointOf } from '@/lib/cred-type'
import { resetCountdown } from '@/lib/fable-status'
import { fmtAgo, fmtNum, fmtUsd } from '@/lib/format'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import {
  claudeTier,
  credentialStatus,
  poolStatus,
  restrictionCopy,
  vmFailedAt,
} from '@/lib/vm-status'
import { SeatCells } from '@/components/scheduler-viz'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import { ClaudeResetActions } from '@/features/vm/claude-reset-actions'
import { runtimeTypeLabel, runtimeTypeOf } from '@/features/vm/machine-spec'
import { OpenaiQuotaActions } from '@/features/vm/openai-quota-actions'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import { RISK_SOLID, riskFg, riskLevel } from '@/features/vm/usage-meter'
import { VmActionMenu } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'
import {
  bladeState,
  resetShort,
  vmReadout,
  zoneOf,
  type BladeState,
} from '@/features/vm/vm-rack-model'

export type RackSize = 's' | 'm' | 'l'

const TIER_VARS: Record<string, CSSProperties> = {
  pro: {
    '--tc': 'var(--tier-pro-solid)',
    '--tf': 'var(--tier-pro-fg)',
  } as CSSProperties,
  max: {
    '--tc': 'var(--tier-max-solid)',
    '--tf': 'var(--tier-max-fg)',
  } as CSSProperties,
  codex: {
    '--tc': 'var(--tier-codex-solid)',
    '--tf': 'var(--tier-codex-fg)',
  } as CSSProperties,
}

/** 等级只占左沿一截色标与徽标，不再整卡染色——机架是一块底，等级是标签。 */
export function tierStyle(vm: Vm): CSSProperties | undefined {
  return TIER_VARS[tierVisual(vm).key]
}

export function TierBadge({ vm, className }: { vm: Vm; className?: string }) {
  const skin = tierVisual(vm)
  if (skin.key === 'none') return null
  return (
    <span
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-[10px] leading-none font-bold tracking-[0.04em] uppercase',
        skin.badge,
        className
      )}
    >
      {claudeTier(vm).label}
    </span>
  )
}

export const BLADE_STATE_CLASS: Record<BladeState, string> = {
  live: 'bg-muted/50',
  unprobed: 'bg-muted/50',
  dead: 'bg-[color:color-mix(in_oklch,var(--status-bad-bg)_35%,var(--card))]',
  vacant: 'bg-transparent shadow-[inset_0_0_0_1px_var(--border)]',
}

export function useOpenOnKey(vm: Vm) {
  const actions = useVmActions()
  return {
    onClick: () => actions.openDetail(vm),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      actions.openDetail(vm)
    },
  }
}

/** 底栏右侧：调度开关 + 扩展菜单。点击不冒泡到卡片。 */
export function BladeControls({
  vm,
  className,
}: {
  vm: Vm
  className?: string
}) {
  return (
    <div
      className={cn('ms-auto flex items-center gap-0.5', className)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <SchedulableSwitch {...vmSchedulableProps(vm)} />
      <VmActionMenu vm={vm} />
    </div>
  )
}

export function VmSeats({
  vm,
  compact = false,
}: {
  vm: Vm
  compact?: boolean
}) {
  if (vm.seats_max == null) return null
  const used = Number(vm.seats_used) || 0
  const max = Number(vm.seats_max) || 0
  const queued = Number(vm.queue_depth) || 0
  return (
    <span
      className='inline-flex items-center gap-1.5 whitespace-nowrap'
      title={`席位 ${used}/${max}${queued ? ` · 排队 ${queued}` : ''}`}
    >
      <SeatCells
        used={used}
        grace={Number(vm.seats_grace) || 0}
        max={max}
        size='sm'
        className='flex-nowrap'
      />
      <span className='tabular-nums'>
        {used}/{max}
      </span>
      {queued ? (
        <span className='font-medium text-[color:var(--status-warn)] tabular-nums'>
          {compact ? `+${queued}` : `排队 ${queued}`}
        </span>
      ) : null}
    </span>
  )
}

/** 一行规格：调用形式 · 形态 · 节点 · 出口。替代原先五枚边框 chip。 */
function SpecLine({ vm }: { vm: Vm }) {
  const lane = credEndpointOf(vm)
  const parts = [
    lane === 'none' ? null : credEndpointLabel(lane),
    runtimeTypeLabel(runtimeTypeOf(vm)),
    vm.node_name || vm.node_id || 'local',
  ].filter(Boolean)
  return (
    <div className='flex min-w-0 items-center gap-1.5 overflow-hidden text-[11.5px] whitespace-nowrap text-muted-foreground'>
      {parts.map((p, i) => (
        <span key={i} className='flex shrink-0 items-center gap-1.5'>
          {p}
          <span
            aria-hidden='true'
            className='text-[color:var(--text-tertiary)]'
          >
            ·
          </span>
        </span>
      ))}
      <ProxyChip vm={vm} className='min-w-0 shrink' />
    </div>
  )
}

function Callout({
  tone,
  title,
  children,
  action,
}: {
  tone: 'bad' | 'caution' | 'none'
  title: ReactNode
  children?: ReactNode
  action: ReactNode
}) {
  return (
    <div
      className={cn(
        'grid min-w-0 content-center gap-1.5 rounded-lg px-3.5 py-3 text-[12.5px]',
        tone === 'bad' &&
          'bg-[color:var(--status-bad-bg)] text-[color:var(--status-bad)]',
        tone === 'caution' &&
          'bg-[color:var(--status-caution-bg)] text-[color:var(--status-caution)]',
        tone === 'none' &&
          'border border-dashed border-border text-muted-foreground'
      )}
    >
      <b className='font-semibold'>{title}</b>
      {children}
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {action}
      </div>
    </div>
  )
}

function CalloutAction({
  icon,
  children,
  onClick,
}: {
  icon: ReactNode
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='inline-flex h-[26px] items-center gap-1.5 rounded-md border border-current px-2.5 text-xs transition-colors hover:bg-[color:color-mix(in_oklch,currentColor_12%,transparent)] [&_svg]:size-3'
    >
      {icon}
      {children}
    </button>
  )
}

function lifeLine(vm: Vm, accounts?: UsageAccountRow[]) {
  const r = vmReadout(vm, accounts)
  if (!r.totalCost) return null
  return (
    <span className='font-mono text-[11.5px] text-muted-foreground tabular-nums'>
      累计 {fmtUsd(r.totalCost, 2)} · {fmtNum(r.totalTokens)} tok
    </span>
  )
}

export function BladeCallout({
  vm,
  accounts,
  state,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  state: BladeState
}) {
  const actions = useVmActions()
  if (state === 'dead') {
    const failed = vmFailedAt(vm)
    const ago = failed ? fmtAgo(new Date(failed).toISOString()) : ''
    return (
      <Callout
        tone='bad'
        title={`${credentialStatus(vm).text || '无效凭证'}${ago ? ` · ${ago}` : ''}`}
        action={
          <CalloutAction
            icon={<Link2 />}
            onClick={() => actions.openReauth(vm)}
          >
            重新授权
          </CalloutAction>
        }
      >
        {vm.refresh_error ? (
          <span className='truncate font-mono text-[11.5px] opacity-90'>
            {String(vm.refresh_error)}
          </span>
        ) : null}
        {lifeLine(vm, accounts)}
      </Callout>
    )
  }
  if (state === 'vacant') {
    return (
      <Callout
        tone='none'
        title='未绑定账号'
        action={
          <CalloutAction
            icon={<Download />}
            onClick={() => actions.openReauth(vm)}
          >
            绑定凭证
          </CalloutAction>
        }
      >
        <span>绑定后进入探测，再按结果入池。</span>
      </Callout>
    )
  }
  return (
    <Callout
      tone='caution'
      title='额度未探测'
      action={
        <CalloutAction
          icon={<RefreshCw />}
          onClick={() => actions.refreshToken(vm)}
        >
          刷新并探测
        </CalloutAction>
      }
    >
      <span>未探测的槽不计入可用余量。</span>
      {lifeLine(vm, accounts)}
    </Callout>
  )
}

function Rail({ pct, width }: { pct: number | null; width: number }) {
  return (
    <span
      className='relative h-full justify-self-center overflow-hidden rounded-[4px] bg-[color:var(--track)]'
      style={{ width }}
    >
      {pct == null ? null : (
        <>
          <i
            className='absolute inset-x-0 bottom-0 rounded-[3px]'
            style={{
              height: `${Math.max(pct, 2)}%`,
              backgroundColor: RISK_SOLID[riskLevel(pct)],
            }}
          />
          {/* 70% 风险线：越过它开始变色。 */}
          <i className='absolute -inset-x-0.5 bottom-[70%] h-px bg-[color:color-mix(in_oklch,var(--foreground)_28%,transparent)]' />
        </>
      )}
    </span>
  )
}

/**
 * 读数表。窗口列 = 百分比 / 竖柱 / 窗口名（+ 重置）/ 费用 / token，
 * 累计是同一张表的最后一列，费用与 token 和窗口同行对齐。
 */
function UsageMatrix({
  vm,
  accounts,
  size,
  now,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  size: RackSize
  now: number
}) {
  const r = vmReadout(vm, accounts)
  const n = r.windows.length
  const large = size === 'l'
  const at = (row: number | string, col: number): CSSProperties => ({
    gridRow: row,
    gridColumn: col,
  })
  const muted = 'text-[color:var(--text-tertiary)]'
  const cell = (v: number | null, fmt: (x: number) => string) =>
    v == null ? <span className={muted}>—</span> : fmt(v)
  const L = n + 2
  return (
    <div
      className='grid items-center gap-x-2 gap-y-1'
      style={{
        gridTemplateColumns: `2.4rem repeat(${n}, minmax(38px, 1fr)) minmax(92px, 1.25fr)`,
        gridTemplateRows: `auto ${large ? 92 : 56}px auto auto auto`,
      }}
    >
      <span style={at(4, 1)} className='text-[11px] text-muted-foreground'>
        费用
      </span>
      <span style={at(5, 1)} className='text-[11px] text-muted-foreground'>
        token
      </span>
      {r.windows.map((w, i) => {
        const c = i + 2
        const reset = w.reset ? resetCountdown(w.reset, now) : null
        const short = resetShort(w.reset, now)
        const level = w.pct == null ? 'ok' : riskLevel(w.pct)
        return (
          <div key={w.key} className='contents'>
            <span
              style={at(1, c)}
              title={w.note ?? undefined}
              className={cn(
                'truncate text-center font-mono font-semibold tracking-[-0.02em] tabular-nums',
                large ? 'text-[12.5px]' : 'text-[11.5px]',
                w.pct == null ? muted : level !== 'ok' && riskFg(w.pct)
              )}
            >
              {w.pct == null ? (w.note ?? '—') : `${Math.round(w.pct)}%`}
            </span>
            <span style={at(2, c)} className='grid h-full'>
              <Rail pct={w.pct} width={large ? 14 : 10} />
            </span>
            <span
              style={at(3, c)}
              title={reset ? `${reset} 后重置` : undefined}
              className='inline-flex items-center justify-center gap-1 text-[11px] font-medium whitespace-nowrap text-muted-foreground'
            >
              {w.label}
              {large && short ? (
                <span className='inline-flex items-center gap-0.5 font-mono text-[10.5px] font-normal text-[color:var(--text-tertiary)]'>
                  <Clock className='size-2.5' aria-hidden='true' />
                  {short}
                </span>
              ) : null}
            </span>
            <span
              style={at(4, c)}
              className='text-center font-mono text-xs whitespace-nowrap tabular-nums'
            >
              {cell(w.cost, (x) => fmtUsd(x, 2))}
            </span>
            <span
              style={at(5, c)}
              className='text-center font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums'
            >
              {cell(w.tokens, fmtNum)}
            </span>
          </div>
        )
      })}
      <span
        aria-hidden='true'
        style={at('1 / 6', L)}
        className='ms-0.5 self-stretch border-l border-[color:color-mix(in_oklch,var(--tc,var(--border))_55%,transparent)]'
      />
      {r.weekShare != null ? (
        <span
          style={at('1 / 3', L)}
          className='grid w-full content-end justify-items-end gap-1.5 self-end ps-3'
        >
          {large ? (
            <span className='text-[10.5px] text-[color:var(--text-tertiary)]'>
              近 7d 占累计
            </span>
          ) : null}
          <span className='font-mono text-[13px] font-semibold text-muted-foreground tabular-nums'>
            {r.weekShare < 1 && r.weekShare > 0
              ? '<1'
              : Math.round(r.weekShare)}
            %
          </span>
          <span className='relative h-1 w-full overflow-hidden rounded-full bg-[color:var(--track)]'>
            <i
              className='absolute inset-y-0 right-0 rounded-full bg-[color:var(--tc,var(--muted-foreground))]'
              style={{ width: `${Math.max(r.weekShare, 2)}%` }}
            />
          </span>
        </span>
      ) : null}
      <span
        style={at(3, L)}
        className='justify-self-end ps-3 text-[11px] font-semibold tracking-[0.02em] text-muted-foreground'
      >
        累计
      </span>
      <span
        style={at(4, L)}
        className={cn(
          'justify-self-end ps-3 leading-[1.1] font-[640] tracking-[-0.02em] whitespace-nowrap text-[color:var(--tf,var(--foreground))] tabular-nums',
          large ? 'text-[17px]' : 'text-sm'
        )}
      >
        {fmtUsd(r.totalCost, 2)}
      </span>
      <span
        style={at(5, L)}
        className='justify-self-end ps-3 font-mono text-xs text-muted-foreground tabular-nums'
      >
        {fmtNum(r.totalTokens)}
      </span>
    </div>
  )
}

function QuotaActions({ vm, now }: { vm: Vm; now: number }) {
  return isCodexVm(vm) ? (
    <OpenaiQuotaActions vm={vm} compact />
  ) : (
    <ClaudeResetActions vm={vm} compact now={now} />
  )
}

export const VmBlade = memo(function VmBlade({
  vm,
  accounts,
  size,
  now,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  size: Exclude<RackSize, 's'>
  now: number
}) {
  const open = useOpenOnKey(vm)
  const state = bladeState(vm)
  const large = size === 'l'
  const email = String(vm.email || '')
  const restricted = zoneOf(vm) === 'restricted'
  return (
    <article
      role='button'
      tabIndex={0}
      aria-label={`查看 ${vm.id} 详情`}
      style={tierStyle(vm)}
      className={cn(
        'relative grid min-w-0 cursor-pointer grid-rows-[auto_auto_1fr_auto] rounded-[10px] shadow-[inset_0_0_0_1px_var(--hairline)] transition-[background-color,box-shadow] duration-150 ease-out hover:bg-muted hover:shadow-[inset_0_0_0_1px_var(--border)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        "before:absolute before:top-3 before:left-0 before:h-[18px] before:w-[3px] before:rounded-r-[2px] before:bg-[color:var(--tc,transparent)] before:content-['']",
        large
          ? 'gap-2.5 px-3 ps-3.5 pt-3 pb-2'
          : 'gap-2 px-2.5 ps-3 pt-2.5 pb-1.5',
        BLADE_STATE_CLASS[state],
        zoneOf(vm) === 'off' && 'opacity-80'
      )}
      {...open}
    >
      <div className='grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5'>
        <span className='flex min-w-0 items-baseline gap-2'>
          <span className='font-mono text-[11.5px] text-muted-foreground'>
            {vm.id}
          </span>
          {vm.name && vm.name !== vm.id ? (
            <span className='truncate text-[11.5px] text-[color:var(--text-tertiary)]'>
              {vm.name}
            </span>
          ) : null}
        </span>
        <TierBadge vm={vm} />
        <span
          title={email || undefined}
          className={cn(
            'col-span-2 truncate font-semibold tracking-[-0.012em]',
            large ? 'text-sm' : 'text-[13px]',
            email
              ? state === 'dead'
                ? 'text-muted-foreground'
                : ''
              : 'font-medium text-muted-foreground'
          )}
        >
          {email || '空槽'}
        </span>
        {restricted && state !== 'dead' ? (
          <StatusMark
            variant='pill'
            className='col-span-2 justify-self-start'
            tone={{
              ...poolStatus(vm),
              label: restrictionCopy(vm) || poolStatus(vm).text,
            }}
          />
        ) : null}
      </div>
      <SpecLine vm={vm} />
      {state === 'live' ? (
        <UsageMatrix vm={vm} accounts={accounts} size={size} now={now} />
      ) : (
        <BladeCallout vm={vm} accounts={accounts} state={state} />
      )}
      <div className='hairline-t flex min-h-9 items-center gap-1.5 pt-1.5 text-[11.5px] text-muted-foreground'>
        {vm.seats_max != null ? (
          <span className='me-0.5 border-e border-[color:var(--hairline)] pe-2'>
            <VmSeats vm={vm} />
          </span>
        ) : null}
        {state === 'live' || state === 'unprobed' ? (
          <QuotaActions vm={vm} now={now} />
        ) : null}
        <BladeControls vm={vm} />
      </div>
    </article>
  )
})
