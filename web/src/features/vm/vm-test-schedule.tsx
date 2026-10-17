import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Clock3, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { validTimezone } from '@/lib/timezone'
import { isCodexVm } from '@/lib/vm-kind'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { meQueryOptions } from '@/features/auth/queries'
import { TimezonePicker } from '@/features/vm/timezone-picker'

type ScheduleFrequency = 'hourly' | 'daily' | 'weekly'

type TestSchedule = {
  enabled: boolean
  frequency: ScheduleFrequency
  minute?: number
  time?: string
  weekdays?: number[]
  timezone: string
  parse_error?: boolean
  model: string
  prompt: string
  max_tokens: number | null
  reasoning_effort: string | null
  last_run_at: string | null
  last_ok: boolean | null
  last_duration_ms: number | null
  last_error: string | null
  next_run_at: string | null
  running: boolean
}

type ScheduleStructure = Pick<
  TestSchedule,
  'frequency' | 'minute' | 'time' | 'weekdays' | 'timezone'
>

type SchedulePayload = { schedule: TestSchedule | null }
type DefaultPayload = { schedule: ScheduleStructure | null }
type SyncPayload = {
  updated: string[]
  missing: string[]
  schedule: ScheduleStructure
}

type TestParams = {
  vm: Vm
  models: { id: string }[]
  model: string
  prompt: string
  maxTokens: number
  reasoningEffort: string
  onPromptChange: (value: string) => void
  onLoadSchedule: (schedule: TestSchedule) => void
}

const WEEKDAY_OPTIONS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
]

const MINUTES = Array.from({ length: 60 }, (_, i) => i)

function localTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return validTimezone(tz) || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

function defaultStructure(): ScheduleStructure {
  return { frequency: 'daily', time: '09:00', timezone: localTimezone() }
}

function formatAt(value: string | null, timezone: string) {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value))
  } catch {
    return value
  }
}

function structureFromSchedule(
  schedule: TestSchedule | ScheduleStructure | null
) {
  if (!schedule) return defaultStructure()
  return {
    frequency: schedule.frequency || 'daily',
    minute: schedule.minute ?? 0,
    time: schedule.time || '09:00',
    weekdays: schedule.weekdays?.length ? schedule.weekdays : [1],
    timezone: schedule.timezone || localTimezone(),
  }
}

function structureEqual(a: ScheduleStructure, b: ScheduleStructure) {
  return (
    a.frequency === b.frequency &&
    a.timezone === b.timezone &&
    (a.frequency !== 'hourly' || a.minute === b.minute) &&
    (a.frequency === 'hourly' ||
      (a.time === b.time &&
        (a.frequency !== 'weekly' ||
          JSON.stringify([...(a.weekdays || [])].sort()) ===
            JSON.stringify([...(b.weekdays || [])].sort()))))
  )
}

export function VmTestSchedule({
  vm,
  models,
  model,
  prompt,
  maxTokens,
  reasoningEffort,
  onPromptChange,
  onLoadSchedule,
}: TestParams) {
  const codex = isCodexVm(vm)
  const qc = useQueryClient()
  const me = useQuery(meQueryOptions())
  const isAdmin = me.data?.role === 'admin'
  const queryKey = ['panel', 'vm', vm.id, 'test-schedule'] as const
  const endpoint = `/api/panel/vms/${encodeURIComponent(vm.id)}/test-schedule`
  const loaded = useRef(false)
  const [enabled, setEnabled] = useState(false)
  const [structure, setStructure] =
    useState<ScheduleStructure>(defaultStructure)
  const [syncOpen, setSyncOpen] = useState(false)
  const [syncAllOpen, setSyncAllOpen] = useState(false)
  const scheduleQuery = useQuery({
    queryKey,
    queryFn: ({ queryKey: key, signal }) =>
      api<SchedulePayload>(
        `/api/panel/vms/${encodeURIComponent(key[2])}/test-schedule`,
        { signal }
      ),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.schedule?.enabled ? 30_000 : false,
  })
  const defaultQuery = useQuery({
    queryKey: ['panel', 'test-schedule', 'default'] as const,
    queryFn: ({ signal }) =>
      api<DefaultPayload>('/api/panel/test-schedule/default', { signal }),
    retry: false,
  })
  const saved = scheduleQuery.data?.schedule || null

  useEffect(() => {
    if (loaded.current || !scheduleQuery.data) return
    loaded.current = true
    const schedule = scheduleQuery.data.schedule
    if (!schedule) {
      if (defaultQuery.data?.schedule) {
        setStructure(structureFromSchedule(defaultQuery.data.schedule))
      }
      return
    }
    setEnabled(schedule.enabled)
    setStructure(structureFromSchedule(schedule))
    onLoadSchedule(schedule)
  }, [defaultQuery.data?.schedule, onLoadSchedule, scheduleQuery.data])

  const selectedModel = model || models[0]?.id || ''
  const savedStructure = useMemo(
    () => (saved ? structureFromSchedule(saved) : null),
    [saved]
  )
  const dirty = saved
    ? enabled !== saved.enabled ||
      !savedStructure ||
      !structureEqual(structure, savedStructure) ||
      selectedModel !== saved.model ||
      prompt.trim() !== saved.prompt ||
      (codex
        ? reasoningEffort !== saved.reasoning_effort
        : maxTokens !== saved.max_tokens)
    : enabled || !structureEqual(structure, defaultStructure())

  const save = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey }),
    mutationFn: () =>
      api<SchedulePayload>(endpoint, {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          ...structure,
          model: selectedModel,
          prompt,
          ...(codex
            ? { reasoning_effort: reasoningEffort }
            : { max_tokens: maxTokens }),
        }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data)
      if (data.schedule) {
        setEnabled(data.schedule.enabled)
        setStructure(structureFromSchedule(data.schedule))
        onPromptChange(data.schedule.prompt)
      }
      toast.success(
        data.schedule?.enabled ? '定时测试已启用' : '测试计划已保存'
      )
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  })
  const remove = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey }),
    mutationFn: () => api<SchedulePayload>(endpoint, { method: 'DELETE' }),
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data)
      setEnabled(false)
      setStructure(defaultStructure())
      toast.success('测试计划已删除')
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  })
  const saveDefault = useMutation({
    mutationFn: () =>
      api<DefaultPayload>('/api/panel/test-schedule/default', {
        method: 'PUT',
        body: JSON.stringify({ schedule: structure }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['panel', 'test-schedule', 'default'], data)
      toast.success('已保存全局默认调度模板')
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const syncSchedule = useMutation({
    mutationFn: (scope: 'ids' | 'all') =>
      api<SyncPayload>('/api/panel/test-schedule/sync', {
        method: 'POST',
        body: JSON.stringify({
          scope,
          ...(scope === 'ids' ? { vm_ids: [vm.id] } : {}),
          schedule: structure,
        }),
      }),
    onSuccess: (data) => {
      toast.success(`已覆盖 ${data.updated.length} 个槽的调度时间`)
      void scheduleQuery.refetch()
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      setSyncOpen(false)
      setSyncAllOpen(false)
    },
  })
  const busy =
    save.isPending ||
    remove.isPending ||
    saveDefault.isPending ||
    syncSchedule.isPending

  const toggleWeekday = (value: number, checked: boolean) => {
    setStructure((prev) => {
      const set = new Set(prev.weekdays || [])
      if (checked) set.add(value)
      else set.delete(value)
      const weekdays = [...set].sort((a, b) => a - b)
      return { ...prev, weekdays: weekdays.length ? weekdays : [value] }
    })
  }

  return (
    <section className='space-y-3 border-t pt-3'>
      <div className='flex items-center justify-between gap-3'>
        <h3 className='flex items-center gap-1.5 text-sm font-medium'>
          <Clock3 className='size-4' /> 定时测试
        </h3>
        <div className='flex items-center gap-2'>
          {dirty && loaded.current ? (
            <span className='text-xs text-muted-foreground'>未保存</span>
          ) : null}
          <Switch
            aria-label='启用定时测试'
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={scheduleQuery.isPending || scheduleQuery.isError || busy}
          />
        </div>
      </div>

      {scheduleQuery.isPending ? (
        <p className='text-xs text-muted-foreground'>正在读取计划…</p>
      ) : scheduleQuery.isError ? (
        <div className='flex items-center gap-2 text-xs text-destructive'>
          <span role='alert'>计划读取失败：{scheduleQuery.error.message}</span>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => void scheduleQuery.refetch()}
          >
            重试
          </Button>
        </div>
      ) : (
        <>
          {saved?.parse_error ? (
            <p className='text-xs text-destructive' role='alert'>
              已存计划无法识别为结构化调度，请重新选择频率与时间后保存。
            </p>
          ) : null}
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5 sm:col-span-2'>
              <Label htmlFor={`vm-test-frequency-${vm.id}`}>频率</Label>
              <Select
                value={structure.frequency}
                onValueChange={(value) => {
                  if (value !== 'hourly' && value !== 'daily' && value !== 'weekly') return
                  setStructure((prev) => ({
                    ...prev,
                    frequency: value,
                    minute: prev.minute ?? 0,
                    time: prev.time || '09:00',
                    weekdays: prev.weekdays?.length ? prev.weekdays : [1],
                  }))
                }}
              >
                <SelectTrigger id={`vm-test-frequency-${vm.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='hourly'>每小时</SelectItem>
                  <SelectItem value='daily'>每天</SelectItem>
                  <SelectItem value='weekly'>每周</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {structure.frequency === 'hourly' ? (
              <div className='space-y-1.5'>
                <Label htmlFor={`vm-test-minute-${vm.id}`}>分钟</Label>
                <Select
                  value={String(structure.minute ?? 0)}
                  onValueChange={(value) =>
                    setStructure((prev) => ({ ...prev, minute: Number(value) }))
                  }
                >
                  <SelectTrigger id={`vm-test-minute-${vm.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className='max-h-60'>
                    {MINUTES.map((minute) => (
                      <SelectItem key={minute} value={String(minute)}>
                        {minute === 0 ? '整点 (0)' : String(minute)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className='space-y-1.5'>
                <Label htmlFor={`vm-test-time-${vm.id}`}>时刻</Label>
                <Input
                  id={`vm-test-time-${vm.id}`}
                  type='time'
                  value={structure.time || '09:00'}
                  onChange={(event) =>
                    setStructure((prev) => ({
                      ...prev,
                      time: event.target.value,
                    }))
                  }
                />
              </div>
            )}

            <div className='space-y-1.5'>
              <Label>时区</Label>
              <TimezonePicker
                value={structure.timezone}
                onChange={(timezone) =>
                  setStructure((prev) => ({ ...prev, timezone }))
                }
                className='w-full'
              />
              <p className='text-xs text-muted-foreground'>
                当前：{structure.timezone} · 真实调用会消耗额度
              </p>
            </div>

            {structure.frequency === 'weekly' ? (
              <div className='space-y-2 sm:col-span-2'>
                <Label>星期</Label>
                <div className='flex flex-wrap gap-3'>
                  {WEEKDAY_OPTIONS.map((day) => {
                    const checked = (structure.weekdays || []).includes(
                      day.value
                    )
                    return (
                      <label
                        key={day.value}
                        className='flex items-center gap-2 text-sm'
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) =>
                            toggleWeekday(day.value, next === true)
                          }
                        />
                        {day.label}
                      </label>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className='flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              onClick={() => save.mutate()}
              disabled={
                busy ||
                !selectedModel ||
                !prompt.trim() ||
                (structure.frequency === 'weekly' &&
                  !(structure.weekdays || []).length)
              }
              loading={save.isPending}
            >
              <Save /> 保存计划
            </Button>
            {saved ? (
              <Button
                size='icon'
                variant='ghost'
                className='size-8 text-muted-foreground'
                aria-label='删除定时测试'
                title='删除定时测试'
                onClick={() => remove.mutate()}
                disabled={busy}
              >
                <Trash2 />
              </Button>
            ) : null}
            <Button
              size='sm'
              variant='outline'
              disabled={busy}
              onClick={() => setSyncOpen(true)}
            >
              同步到本槽
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={busy}
              onClick={() => setSyncAllOpen(true)}
            >
              同步到全部槽
            </Button>
            {isAdmin ? (
              <Button
                size='sm'
                variant='ghost'
                disabled={busy}
                onClick={() => saveDefault.mutate()}
                loading={saveDefault.isPending}
              >
                保存为全局默认
              </Button>
            ) : null}
          </div>

          {saved ? (
            <div className='space-y-1 text-xs text-muted-foreground'>
              <p>
                当前计划：{saved.enabled ? '启用' : '暂停'} · {saved.model}
                {saved.running ? ' · 运行中' : ''}
              </p>
              <p>下次运行：{formatAt(saved.next_run_at, saved.timezone)}</p>
              <p>
                上次运行：{formatAt(saved.last_run_at, saved.timezone)}
                {saved.last_ok != null
                  ? ` · ${saved.last_ok ? '成功' : '失败'}`
                  : ''}
                {saved.last_duration_ms != null
                  ? ` · ${saved.last_duration_ms}ms`
                  : ''}
              </p>
              {saved.last_error ? (
                <p className='break-words text-destructive'>
                  {saved.last_error}
                </p>
              ) : null}
            </div>
          ) : (
            <p className='text-xs text-muted-foreground'>尚未创建计划</p>
          )}
        </>
      )}

      <AlertDialog open={syncOpen} onOpenChange={setSyncOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>同步调度时间？</AlertDialogTitle>
            <AlertDialogDescription>
              将把当前表单的调度时间（频率、时刻/分钟、星期、时区）覆盖写入本槽
              {saved ? '' : '（若无计划将创建且保持关闭）'}
              。不会修改 Prompt、模型、token/effort 或启用开关。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncSchedule.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={syncSchedule.isPending}
              onClick={(event) => {
                event.preventDefault()
                syncSchedule.mutate('ids')
              }}
            >
              覆盖写入
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={syncAllOpen} onOpenChange={setSyncAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>同步到全部槽？</AlertDialogTitle>
            <AlertDialogDescription>
              将把当前表单的调度时间覆盖写入你有权限的全部槽（租户仅自己的槽）。
              无计划的槽会创建且保持关闭；Prompt、模型、token/effort
              与启用开关不会被修改。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncSchedule.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={syncSchedule.isPending}
              onClick={(event) => {
                event.preventDefault()
                syncSchedule.mutate('all')
              }}
            >
              覆盖全部
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
