import {
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  type ProxyRegionFilter,
  REGION_ANY,
  type RegionGroup,
  type RegionTally,
  regionShort,
} from './proxy-region'

/**
 * 地区分面。超宽屏（2xl）是表格左侧的竖栏；更窄时折成表格上方的一排
 * （sm 以上换行，手机横向滚动），把宽度让给表格 —— 笔记本宽度下竖栏会把
 * 列表挤到表格断点以下，退回卡片排布。
 *
 * 可收起：竖栏收成只显示地区代码与空位数的窄条；横排收成只剩当前选中的一档。
 * 收起不清除筛选。
 *
 * 每档右侧两个数：当前筛选下的条数、其中可绑的空位。找节点的问题通常是
 * 「这个地区还能不能塞」，所以空位和条数并排，不用点进去再数。
 */
export function ProxyRegionRail({
  groups,
  value,
  onChange,
  totalCount,
  totalFree,
  collapsed,
  onCollapsedChange,
}: {
  groups: RegionGroup[]
  value: ProxyRegionFilter
  onChange: (next: ProxyRegionFilter) => void
  totalCount: number
  totalFree: number
  collapsed: boolean
  onCollapsedChange: (next: boolean) => void
}) {
  const active = groups.find((g) => g.country === value.country)
  const toggleLabel = collapsed ? '展开地区栏' : '收起地区栏'
  const toggle = () => onCollapsedChange(!collapsed)
  return (
    <nav
      aria-label='按地区筛选'
      className='min-w-0 2xl:sticky 2xl:top-20 2xl:max-h-[calc(100svh-6rem)] 2xl:overflow-y-auto 2xl:overscroll-contain'
    >
      <div
        className={cn(
          'mb-1.5 hidden items-center gap-1 2xl:flex',
          collapsed ? 'justify-center' : 'justify-between ps-2'
        )}
      >
        {collapsed ? null : (
          <h3 className='text-xs font-medium text-muted-foreground'>地区</h3>
        )}
        <button
          type='button'
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          className='grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground'
        >
          {collapsed ? (
            <PanelLeftOpen className='size-4' aria-hidden='true' />
          ) : (
            <PanelLeftClose className='size-4' aria-hidden='true' />
          )}
        </button>
      </div>
      <ul className='-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible 2xl:mx-0 2xl:flex-col 2xl:flex-nowrap 2xl:gap-px 2xl:px-0 2xl:pb-0'>
        <li className='shrink-0 2xl:hidden'>
          <button
            type='button'
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={toggleLabel}
            title={toggleLabel}
            className='flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground'
          >
            地区
            {collapsed ? (
              <ChevronRight className='size-3.5' aria-hidden='true' />
            ) : (
              <ChevronLeft className='size-3.5' aria-hidden='true' />
            )}
          </button>
        </li>
        <li
          className={cn(
            'shrink-0',
            collapsed && value.country && 'hidden 2xl:block'
          )}
        >
          <RegionButton
            label='全部地区'
            short='全部'
            collapsed={collapsed}
            tally={{ count: totalCount, free: totalFree }}
            on={!value.country}
            onClick={() => onChange(REGION_ANY)}
          />
        </li>
        {groups.map((g) => {
          const on = value.country === g.country
          return (
            <li
              key={g.country}
              className={cn('shrink-0', collapsed && !on && 'hidden 2xl:block')}
            >
              <RegionButton
                label={g.label}
                short={regionShort(g.country)}
                collapsed={collapsed}
                tally={g}
                on={on && !value.city}
                within={on && !!value.city}
                onClick={() =>
                  onChange(
                    on && !value.city
                      ? REGION_ANY
                      : { country: g.country, city: '' }
                  )
                }
              />
              {on && g.cities.length && !collapsed ? (
                <ul
                  aria-label={`${g.label}的城市`}
                  className='hidden 2xl:mt-px 2xl:flex 2xl:flex-col 2xl:gap-px'
                >
                  {g.cities.map((c) => (
                    <li key={c.city}>
                      <RegionButton
                        label={c.city}
                        short={c.city}
                        tally={c}
                        nested
                        on={value.city === c.city}
                        onClick={() =>
                          onChange({
                            country: g.country,
                            city: value.city === c.city ? '' : c.city,
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          )
        })}
        {/* 横排里城市跟在选中的国家后面，竖栏里它们已经嵌在国家下方。 */}
        {collapsed
          ? null
          : active?.cities.map((c) => (
              <li key={`m-${c.city}`} className='shrink-0 2xl:hidden'>
                <RegionButton
                  label={c.city}
                  short={c.city}
                  tally={c}
                  nested
                  on={value.city === c.city}
                  onClick={() =>
                    onChange({
                      country: active.country,
                      city: value.city === c.city ? '' : c.city,
                    })
                  }
                />
              </li>
            ))}
      </ul>
    </nav>
  )
}

function RegionButton({
  label,
  short,
  tally,
  on,
  within = false,
  nested = false,
  collapsed = false,
  onClick,
}: {
  label: string
  /** 竖栏收起时显示的短名。 */
  short: string
  tally: RegionTally
  on: boolean
  /** 选中的是这个国家下的某个城市。 */
  within?: boolean
  nested?: boolean
  collapsed?: boolean
  onClick: () => void
}) {
  const empty = tally.count === 0
  return (
    <button
      type='button'
      aria-pressed={on}
      aria-label={
        collapsed
          ? `${label}：${tally.count} 条，空位 ${tally.free}`
          : undefined
      }
      onClick={onClick}
      title={`${label}：${tally.count} 条，空位 ${tally.free}`}
      className={cn(
        'group flex h-8 w-full items-center gap-2 rounded-md px-2 text-start text-[13px] whitespace-nowrap transition-colors',
        'border border-transparent bg-muted/50 2xl:bg-transparent',
        'hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-ring',
        nested && '2xl:h-7 2xl:ps-5 2xl:text-xs',
        collapsed &&
          '2xl:h-10 2xl:flex-col 2xl:items-center 2xl:justify-center 2xl:gap-0.5 2xl:px-0',
        on
          ? 'border-primary/30 bg-primary/10 font-medium text-foreground 2xl:bg-primary/10'
          : within
            ? 'text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        empty && !on && 'opacity-50'
      )}
    >
      <span
        className={cn('min-w-0 flex-1 truncate', collapsed && '2xl:hidden')}
      >
        {label}
      </span>
      {collapsed ? (
        <span className='hidden max-w-full truncate text-xs leading-none font-medium 2xl:block'>
          {short}
        </span>
      ) : null}
      <span
        className={cn(
          'shrink-0 text-xs text-foreground/80 tabular-nums',
          collapsed && '2xl:hidden'
        )}
      >
        {tally.count}
      </span>
      <span
        className={cn(
          'w-9 shrink-0 text-end text-[11px] tabular-nums',
          collapsed &&
            '2xl:w-auto 2xl:text-center 2xl:text-[10px] 2xl:leading-none',
          tally.free
            ? 'text-[color:var(--status-ok)]'
            : 'text-muted-foreground/70'
        )}
      >
        <span className={cn(collapsed && '2xl:hidden')}>空 </span>
        {tally.free}
      </span>
    </button>
  )
}
