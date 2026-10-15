import { useMemo } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { fmtAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type ProxyHover,
  useProxyHoverId,
  useProxyHovered,
} from './proxy-hover'
import {
  type ProxyRegionFilter,
  REGION_ANY,
  type RegionGroup,
  proxyRegion,
} from './proxy-region'
import {
  PROXY_HEALTH_KEYS,
  PROXY_HEALTH_LABEL,
  type ProxyFilter,
  proxyBindLimit,
  proxyBindable,
  proxyBoundIds,
  proxyHealthKey,
  proxyIsLocal,
  proxyLabel,
} from './proxy-sort'
import { PROXY_HEALTH_SOLID } from './proxy-tone'
import { VmChip } from './vm-chip'

/** 一个点的边长与间距（px）。点阵靠这两个数对齐，不随容器缩放。 */
const DOT = 7
const GAP = 3
/** 一列最多几个点；上限更高的代理折成相邻的几列，紧挨着画。 */
const MAX_ROWS = 10

/**
 * 席位点阵：每个点是一个绑定位，实心 = 已绑（按代理健康着色），空心 = 可绑空位，
 * 淡点 = 失效 / 禁用代理上用不了的位。一条代理一列，按地区成簇。
 *
 * 一眼回答「哪个地区还能塞、塞在哪条上」：簇名旁是该地区空位数，点簇名即筛到该地区；
 * 列和表格行双向联动（悬停同亮，点列滚到那一行）。
 */
export function ProxyOverview({
  proxies,
  vms,
  ownerOf,
  poolLimit,
  slotsUsed,
  slotsCap,
  probeMin,
  filter,
  onFilter,
  regions,
  region,
  onRegion,
  hover,
  visible,
  onLocate,
  onVmDragChange,
}: {
  /** 已排序的全集（不受筛选影响，保证图形稳定）。 */
  proxies: VmProxySnap[]
  vms: Vm[]
  ownerOf: Map<string, VmProxySnap>
  poolLimit: number
  slotsUsed: number
  slotsCap: number
  probeMin: number
  filter: ProxyFilter
  onFilter: (next: ProxyFilter) => void
  /** 地区顺序与名称，和地区栏同一份。 */
  regions: RegionGroup[]
  region: ProxyRegionFilter
  onRegion: (next: ProxyRegionFilter) => void
  hover: ProxyHover
  /** 只用来调暗「不在当前筛选里」的列；地区、搜索的命中由调用方算。 */
  visible: (prx: VmProxySnap) => boolean
  onLocate: (id: string) => void
  onVmDragChange: (vmId: string) => void
}) {
  const counts = useMemo(() => {
    const out = Object.fromEntries(
      PROXY_HEALTH_KEYS.map((k) => [k, 0])
    ) as Record<(typeof PROXY_HEALTH_KEYS)[number], number>
    for (const p of proxies) out[proxyHealthKey(p)] += 1
    return out
  }, [proxies])
  const byId = useMemo(
    () => new Map(proxies.map((p) => [p.id || '', p])),
    [proxies]
  )
  const lastProbe = useMemo(() => {
    let max = 0
    for (const p of proxies) {
      const t = Date.parse(p.last_probe_at || '')
      if (Number.isFinite(t) && t > max) max = t
    }
    return max ? new Date(max).toISOString() : ''
  }, [proxies])
  const clusters = useMemo(() => {
    const byCountry = new Map<string, VmProxySnap[]>()
    for (const p of proxies) {
      const key = proxyRegion(p).country
      const list = byCountry.get(key)
      if (list) list.push(p)
      else byCountry.set(key, [p])
    }
    return regions
      .filter((g) => byCountry.has(g.country))
      .map((g) => {
        const list = byCountry.get(g.country) || []
        return {
          country: g.country,
          label: g.label,
          proxies: list,
          // 与地区栏同一个数：按当前席位 / 健康 / 搜索筛选算，不是整池空位。
          free: g.free,
        }
      })
  }, [proxies, regions])
  // 行数按 SOCKS5 的上限定：本地代理上限常常大很多，让它多占几列，而不是把整张图拉高。
  const rows = useMemo(() => {
    const socks = proxies.filter((p) => !proxyIsLocal(p))
    const src = socks.length ? socks : proxies
    const max = src.reduce(
      (n, p) => Math.max(n, proxyBindLimit(p, poolLimit)),
      1
    )
    return Math.min(MAX_ROWS, max)
  }, [proxies, poolLimit])
  const loose = vms.filter((v) => !ownerOf.has(v.id))
  const stranded = loose.filter((v) => v.has_token).length
  // 页头是整池读数，不受筛选影响。
  const freeSeats = proxies.reduce((n, p) => n + freeOf(p, poolLimit), 0)

  return (
    <section
      aria-labelledby='proxy-seat-title'
      className='rounded-xl border bg-card px-4 pt-3 pb-2.5'
    >
      <div className='flex flex-wrap items-center justify-between gap-x-6 gap-y-2'>
        <div className='flex flex-wrap items-baseline gap-x-5 gap-y-1'>
          <h3
            id='proxy-seat-title'
            className='flex items-baseline gap-2 text-sm font-semibold tracking-[-0.01em]'
          >
            席位
            <span className='text-xs font-normal text-muted-foreground tabular-nums'>
              <span className='text-base font-[620] tracking-[-0.02em] text-foreground'>
                {slotsUsed}
              </span>{' '}
              / {slotsCap || '—'} 已绑
            </span>
          </h3>
          <dl className='flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs'>
            <Figure label='空余席位' value={freeSeats} />
            <Figure label='代理' value={proxies.length} />
            <Figure
              label='池外槽位'
              value={loose.length}
              tone={stranded ? 'bad' : undefined}
            />
          </dl>
        </div>
        {proxies.length ? (
          <div
            role='group'
            aria-label='按健康筛选'
            className='-mx-1.5 flex flex-wrap items-center gap-0.5'
          >
            {PROXY_HEALTH_KEYS.map((k) => (
              <button
                key={k}
                type='button'
                aria-pressed={filter === k}
                onClick={() => onFilter(filter === k ? 'all' : k)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors hover:bg-accent/60',
                  filter === k
                    ? 'bg-accent/70 font-medium text-foreground'
                    : 'text-muted-foreground',
                  !counts[k] && filter !== k && 'opacity-45'
                )}
              >
                <span
                  aria-hidden='true'
                  className='size-2 shrink-0 rounded-full'
                  style={{ backgroundColor: PROXY_HEALTH_SOLID[k] }}
                />
                {PROXY_HEALTH_LABEL[k]}
                <span className='font-medium tabular-nums'>{counts[k]}</span>
              </button>
            ))}
            <span className='ms-1 inline-flex h-7 items-center gap-1.5 px-1.5 text-xs text-muted-foreground'>
              <span
                aria-hidden='true'
                className='size-2 shrink-0 rounded-full border border-muted-foreground/60'
              />
              空位
            </span>
          </div>
        ) : null}
      </div>

      {proxies.length ? (
        <>
          <p className='sr-only'>
            共 {proxies.length} 条代理，已绑 {slotsUsed} 个席位，空余{' '}
            {freeSeats} 个。
          </p>
          <div className='mt-3 flex flex-wrap items-end gap-x-6 gap-y-3'>
            {clusters.map((c) => {
              const on = region.country === c.country
              return (
                <div key={c.country} className='min-w-0'>
                  <button
                    type='button'
                    aria-pressed={on}
                    onClick={() =>
                      onRegion(
                        on && !region.city
                          ? REGION_ANY
                          : { country: c.country, city: '' }
                      )
                    }
                    title={`${c.label}：${c.proxies.length} 条代理，当前筛选下空位 ${c.free}。点击筛选该地区`}
                    className={cn(
                      '-mx-1 mb-1.5 flex items-baseline gap-1.5 rounded px-1 text-[11px] whitespace-nowrap transition-colors hover:bg-accent/60',
                      on ? 'text-primary' : 'text-muted-foreground'
                    )}
                  >
                    <span
                      className={cn(
                        'font-medium',
                        on ? 'text-primary' : 'text-foreground/85'
                      )}
                    >
                      {c.label}
                    </span>
                    <span
                      className={cn(
                        'tabular-nums',
                        c.free
                          ? 'text-[color:var(--status-ok)]'
                          : 'text-muted-foreground/70'
                      )}
                    >
                      空 {c.free}
                    </span>
                  </button>
                  <div
                    className='flex flex-wrap items-end'
                    style={{ gap: `${GAP + 2}px` }}
                  >
                    {c.proxies.map((p) => (
                      <ProxyDots
                        key={p.id}
                        proxy={p}
                        limit={proxyBindLimit(p, poolLimit)}
                        rows={rows}
                        dim={!visible(p)}
                        hover={hover}
                        onLocate={onLocate}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
          <SeatReadout
            hover={hover}
            byId={byId}
            poolLimit={poolLimit}
            idle={`${lastProbe ? `最近探测 ${fmtAgo(lastProbe)}` : '还没有探测记录'} · 每 ${probeMin} 分钟自动探测 · 一个点一个席位，点地区名筛选，点一列定位到表格行`}
          />
        </>
      ) : (
        <p className='mt-2 text-xs text-muted-foreground'>
          池里还没有代理。导入后每条代理在这里占一列，点数即它的绑定上限。
        </p>
      )}

      {loose.length ? (
        <div
          className='mt-2 flex items-center gap-x-3 border-t pt-2'
          title='拖到表格行上即可绑定；已绑的槽位也能拖去换绑'
        >
          <h4 className='flex shrink-0 items-center gap-2 text-xs font-medium'>
            待接代理 {loose.length}
            {stranded ? (
              <span className='font-normal text-[color:var(--status-bad)]'>
                {stranded} 台出站被拒
              </span>
            ) : null}
          </h4>
          <div className='flex min-w-0 flex-1 gap-1 overflow-x-auto'>
            {loose.map((v) => (
              <VmChip
                key={v.id}
                compact
                vm={v}
                tone={v.has_token ? 'bad' : 'none'}
                onDragChange={onVmDragChange}
              />
            ))}
          </div>
          {proxies.length ? (
            <p className='hidden shrink-0 text-[11px] text-muted-foreground xl:block'>
              拖到表格行上绑定
            </p>
          ) : null}
        </div>
      ) : vms.length ? (
        <p className='mt-2 border-t pt-2 text-[11px] text-muted-foreground'>
          {vms.length} 台槽位都已接代理。
        </p>
      ) : null}
    </section>
  )
}

function freeOf(prx: VmProxySnap, poolLimit: number): number {
  if (!proxyBindable(prx)) return 0
  return Math.max(0, proxyBindLimit(prx, poolLimit) - proxyBoundIds(prx).length)
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'bad'
}) {
  return (
    <div className='flex items-baseline gap-1.5'>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd
        className={cn(
          'text-sm leading-none font-[620] tracking-[-0.02em] tabular-nums',
          tone === 'bad' && 'text-[color:var(--status-bad)]'
        )}
      >
        {value}
      </dd>
    </div>
  )
}

/**
 * 一条代理的点列。自底向上填：底部先满，和「水位」的直觉一致。
 * 上限超过 `rows` 时从左到右折成几列，列间距比代理之间更紧，读起来仍是一条。
 */
function ProxyDots({
  proxy,
  limit,
  rows,
  dim,
  hover,
  onLocate,
}: {
  proxy: VmProxySnap
  limit: number
  rows: number
  dim: boolean
  hover: ProxyHover
  onLocate: (id: string) => void
}) {
  const id = proxy.id || ''
  const lit = useProxyHovered(hover, id)
  const used = proxyBoundIds(proxy).length
  const bindable = proxyBindable(proxy)
  const color = PROXY_HEALTH_SOLID[proxyHealthKey(proxy)]
  const cols = Math.max(1, Math.ceil(limit / rows))
  const cells: ('bound' | 'free' | 'void' | 'pad')[] = []
  // CSS grid 按列从上往下排，所以每列先排顶部的位。
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const seat = c * rows + (rows - 1 - r)
      cells.push(
        seat >= limit
          ? 'pad'
          : seat < used
            ? 'bound'
            : bindable
              ? 'free'
              : 'void'
      )
    }
  }
  return (
    <button
      type='button'
      tabIndex={-1}
      aria-hidden='true'
      onMouseEnter={() => hover.set(id)}
      onMouseLeave={() => hover.set('')}
      onClick={() => onLocate(id)}
      className={cn(
        'grid grid-flow-col rounded-[3px] p-[2px] outline-offset-1 transition-opacity duration-200',
        lit && 'outline-2 outline-primary',
        dim && !lit && 'opacity-20'
      )}
      style={{
        gridTemplateRows: `repeat(${rows}, ${DOT}px)`,
        gridAutoColumns: `${DOT}px`,
        gap: `${GAP}px`,
      }}
    >
      {cells.map((kind, i) => (
        <span
          key={i}
          className={cn(
            'rounded-full transition-colors duration-300',
            kind === 'free' && 'border border-muted-foreground/45',
            kind === 'void' && 'scale-50 bg-muted-foreground/25'
          )}
          style={kind === 'bound' ? { backgroundColor: color } : undefined}
        />
      ))}
    </button>
  )
}

/** 悬停读数：一行文字代替几百个 tooltip。 */
function SeatReadout({
  hover,
  byId,
  poolLimit,
  idle,
}: {
  hover: ProxyHover
  byId: Map<string, VmProxySnap>
  poolLimit: number
  /** 没有悬停时显示的说明。 */
  idle: string
}) {
  const id = useProxyHoverId(hover)
  const p = id ? byId.get(id) : undefined
  return (
    <div className='mt-2 flex h-5 min-w-0 items-center gap-2 text-[11px] text-muted-foreground'>
      {p ? (
        <>
          <span
            aria-hidden='true'
            className='size-2 shrink-0 rounded-full'
            style={{ backgroundColor: PROXY_HEALTH_SOLID[proxyHealthKey(p)] }}
          />
          <span className='field-host truncate text-foreground'>
            {proxyLabel(p)}
          </span>
          <span className='shrink-0 tabular-nums'>
            {proxyBoundIds(p).length}/{proxyBindLimit(p, poolLimit)}
          </span>
          <span className='shrink-0'>
            {PROXY_HEALTH_LABEL[proxyHealthKey(p)]}
          </span>
          {p.latency_ms != null ? (
            <span className='shrink-0 tabular-nums'>{p.latency_ms}ms</span>
          ) : null}
        </>
      ) : (
        <span className='truncate'>{idle}</span>
      )}
    </div>
  )
}
