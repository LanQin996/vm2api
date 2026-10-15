import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  localProxyText,
  localProxyOptsFromProxy,
  proxyHostLabel,
} from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { TabsContent } from '@/components/ui/tabs'
import { StatusMark } from '@/components/status-mark'
import { HealthDonut } from '@/features/overview/health-gauge'
import {
  proxyIsLocal,
  proxyLabel,
  proxyMatchesQuery,
  proxyStatusLabel,
} from '@/features/proxies/proxy-sort'
import {
  proxyFieldClass,
  proxyLatencyTone,
} from '@/features/proxies/proxy-tone'
import { useLocalProxyLabelOpts } from '@/features/proxies/use-vps-ip'
import { Field } from '@/features/vm/detail-section-primitives'
import { proxyHealthOf } from '@/features/vm/proxy-health'

type VmProxyTabProps = {
  vm: Vm
  proxy: VmProxySnap
  boundId: string
  free: VmProxySnap[]
  /** 整个池（父组件仍传入；标签已改走节点名，不再读出口 IP）。 */
  pool: VmProxySnap[]
  bindId: string
  onBindIdChange: (id: string) => void
  onUnbind: () => void
  onAllocate: () => void
  onBind: () => void
  onProbe: () => void
  onGeo: () => void
}

export function VmProxyTab(props: VmProxyTabProps) {
  const {
    vm,
    proxy,
    boundId,
    free,
    bindId,
    onBindIdChange,
    onUnbind,
    onAllocate,
    onBind,
    onProbe,
    onGeo,
  } = props
  const health = proxyHealthOf(vm, proxy)
  const local = !!boundId && proxyIsLocal(proxy)
  const fallbackOpts = useLocalProxyLabelOpts(vm.node_id)
  const labelOpts = localProxyOptsFromProxy(proxy, fallbackOpts)
  const localLabel = localProxyText(labelOpts)
  // 本地代理行的地理/延迟是控制面那台；节点槽从节点出网，那份探测不代表它。
  const selectedId = bindId || free[0]?.id || ''
  const selected = free.find((p) => p.id === selectedId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [nodeQuery, setNodeQuery] = useState('')
  const q = nodeQuery.trim().toLowerCase()
  // 下拉里显示的是带节点名的标签（本地代理），裸地址匹配不到它，两边都比。
  const matched = q
    ? free.filter(
        (p) =>
          proxyMatchesQuery(p, q, () => '') ||
          proxyLabel(p, labelOpts).toLowerCase().includes(q)
      )
    : free

  return (
    <TabsContent value='proxy' className='space-y-3 pt-4'>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>
            {local ? '绑定的本地代理' : '绑定的 SOCKS5'}
          </CardTitle>
        </CardHeader>
        <p className='px-6 pb-2 text-xs text-muted-foreground'>
          {local
            ? `${localLabel}：槽内流量与控制面代发请求（换票、刷新、测试）都从所在机器出网。每台 VPS 一条本地代理，绑定额度、测通与测地理都只算这台机器。`
            : '出站经这条代理的 egress 网关。槽内不 Dial SOCKS。'}
        </p>
        <CardContent className='flex flex-wrap gap-6 pt-0'>
          <HealthDonut score={health.score} label='健康' size={80} />
          <div className='min-w-0 flex-1 divide-y'>
            <Field label='绑定 ID'>
              <span className='field-host text-xs'>{boundId || '—'}</span>
            </Field>
            {proxy.label ? (
              <Field label='代理名称'>
                <span className='text-xs'>{proxy.label}</span>
              </Field>
            ) : null}
            <Field label='地址'>
              <span className='field-host text-xs'>
                {proxyHostLabel(proxy, labelOpts)}
              </span>
            </Field>
            <Field label='状态'>
              <span className='flex items-center gap-2'>
                {proxyStatusLabel(proxy)}
                {vm.has_token && !proxy.host && !vm.proxy_id ? (
                  <StatusMark
                    variant='pill'
                    tone={{
                      key: 'bad',
                      text: '缺 SOCKS5',
                      cls: 'bad',
                      label: '缺 SOCKS5 · fail closed',
                    }}
                  />
                ) : null}
              </span>
            </Field>
            <Field label='延迟'>
              <span
                className={cn(
                  'field-metric text-sm',
                  proxyFieldClass(proxyLatencyTone(proxy))
                )}
              >
                {proxy.latency_ms != null ? `${proxy.latency_ms}ms` : '—'}
              </span>
            </Field>
            <Field label='认证'>{proxy.has_auth ? '有' : '无'}</Field>
            <Field label='出口'>
              {proxy.geo?.country || proxy.geo?.timezone ? (
                <span className='flex flex-wrap items-center gap-1.5'>
                  {[proxy.geo.country_code || proxy.geo.country, proxy.geo.city]
                    .filter(Boolean)
                    .map((v) => (
                      <StatusMark
                        key={v}
                        variant='pill'
                        tone={{ key: 'none', text: String(v), cls: 'none' }}
                      />
                    ))}
                  {proxy.geo.timezone ? (
                    <>
                      <StatusMark
                        variant='pill'
                        tone={{
                          key: 'none',
                          text: proxy.geo.timezone,
                          cls:
                            proxy.geo.timezone !== vm.timezone
                              ? 'caution'
                              : 'none',
                        }}
                      />
                      {proxy.geo.timezone !== vm.timezone ? (
                        <span className='text-[11px] text-muted-foreground'>
                          槽位为 {vm.timezone || '—'}，可在「运维 · 环境」跟随
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  {proxy.geo.isp ? (
                    <span className='text-[11px] text-muted-foreground'>
                      {proxy.geo.isp}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className='text-xs text-muted-foreground'>
                  {proxy.blocked_reason
                    ? 'IPv6 已关闭'
                    : proxy.geo?.error
                      ? '检测失败'
                      : '未检测'}
                </span>
              )}
            </Field>
          </div>
        </CardContent>
      </Card>
      <div className='flex flex-wrap gap-2'>
        {boundId ? (
          <>
            <Button
              size='sm'
              variant='outline'
              onClick={onProbe}
              disabled={!!proxy.blocked_reason}
            >
              测通
            </Button>
            <Button
              size='sm'
              variant='outline'
              onClick={onGeo}
              disabled={!!proxy.blocked_reason}
            >
              测地理
            </Button>
            <Button size='sm' variant='outline' onClick={onUnbind}>
              解绑
            </Button>
          </>
        ) : null}
        <Button size='sm' variant='outline' onClick={onAllocate}>
          分配空闲出口
        </Button>
        <Button size='sm' variant='ghost' asChild>
          <Link to='/settings/$tab' params={{ tab: 'socks5' }}>
            设置里管理池
          </Link>
        </Button>
      </div>
      {free.length ? (
        <div className='flex gap-2'>
          <Popover
            open={pickerOpen}
            onOpenChange={(open) => {
              setPickerOpen(open)
              if (!open) setNodeQuery('')
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant='outline'
                role='combobox'
                aria-expanded={pickerOpen}
                aria-label='选择出口'
                className='h-9 w-64 justify-between px-3 font-normal'
              >
                <span className='truncate'>
                  {selected ? proxyLabel(selected, labelOpts) : '选择出口'}
                </span>
                <ChevronsUpDown
                  aria-hidden='true'
                  className='size-4 shrink-0 opacity-50'
                />
              </Button>
            </PopoverTrigger>
            <PopoverContent align='start' className='w-80 p-0'>
              {/* 自己过滤：与代理页同一套子串匹配，cmdk 默认的模糊打分会把不相干的地址也排进来。 */}
              <Command shouldFilter={false}>
                <CommandInput
                  value={nodeQuery}
                  onValueChange={setNodeQuery}
                  placeholder='筛选可用节点：名称、地址、国家或时区'
                />
                <CommandList>
                  <CommandEmpty>没有匹配的可用节点</CommandEmpty>
                  {matched.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={p.id}
                      onSelect={() => {
                        onBindIdChange(p.id || '')
                        setPickerOpen(false)
                        setNodeQuery('')
                      }}
                    >
                      <span className='truncate'>
                        {proxyLabel(p, labelOpts)}
                      </span>
                      <Check
                        aria-hidden='true'
                        className={cn(
                          'ms-auto size-4 shrink-0',
                          p.id === selectedId ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Button
            size='sm'
            onClick={onBind}
            disabled={!selectedId || selectedId === boundId}
          >
            绑定
          </Button>
        </div>
      ) : (
        <p className='text-sm text-muted-foreground'>池里没有可绑的空闲出口</p>
      )}
    </TabsContent>
  )
}
