import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import { api } from '@/lib/api'
import {
  healthProbeQueryOptions,
  modelTraceQueryOptions,
  type ModelTracePayload,
  type HealthSnapshotView,
} from '@/features/settings/queries'

type Obj = Record<string, unknown>

type HealthPaneProps = {
  title: string
  failover: Obj
  healthProbe: Obj | undefined
  compatibility: Obj
  onFailoverChange: (next: Obj) => void
  onHealthProbeChange: (next: Obj) => void
  onCompatibilityChange: (next: Obj) => void
}

function obj(value: unknown): Obj {
  return value && typeof value === 'object' ? (value as Obj) : {}
}

function clampInt(raw: string, min: number, max: number, fallback: number) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function HealthPane(props: HealthPaneProps) {
  const {
    title,
    failover,
    healthProbe,
    compatibility,
    onFailoverChange,
    onHealthProbeChange,
    onCompatibilityChange,
  } = props
  const probe = obj(healthProbe)
  const real = obj(probe.real)
  const modelTrace = obj(probe.model_trace)
  const minTokens = obj(compatibility.min_max_tokens)
  const setProbe = (patch: Obj) => onHealthProbeChange({ ...probe, ...patch })
  const setReal = (patch: Obj) => setProbe({ real: { ...real, ...patch } })
  const setMinTokens = (patch: Obj) =>
    onCompatibilityChange({
      ...compatibility,
      min_max_tokens: { enabled: true, value: 128, ...minTokens, ...patch },
    })

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <p className='text-xs text-muted-foreground'>
            探测和测试请求在进入调度前就地应答，不占并发、会话席位和粘性。
          </p>
        </CardHeader>
        <CardContent className='divide-y'>
          <SettingRow
            label='拦截预热请求'
            desc='仅 Claude 模型的 /v1/messages。Claude Code 的 Warmup、标题生成、SUGGESTION MODE、haiku max_tokens=1 连通性检查直接返回模拟响应，不打上游。'
          >
            <Switch
              checked={probe.intercept_warmup === true}
              onCheckedChange={(checked) =>
                setProbe({ intercept_warmup: checked })
              }
              aria-label='拦截预热请求'
            />
          </SettingRow>
          <SettingRow
            label='max_tokens 下限'
            desc='Claude 出站时把过小的 max_tokens 抬到下限，避免探测请求在输出前被截断。未传 max_tokens 的请求不受影响。'
          >
            <div className='flex items-center gap-3'>
              <Input
                className='w-24'
                type='number'
                min={1}
                max={4096}
                disabled={minTokens.enabled === false}
                value={Number(minTokens.value ?? 128)}
                onChange={(event) =>
                  setMinTokens({
                    value: clampInt(event.target.value, 1, 4096, 128),
                  })
                }
                aria-label='max_tokens 下限'
              />
              <Switch
                checked={minTokens.enabled !== false}
                onCheckedChange={(checked) =>
                  setMinTokens({ enabled: checked })
                }
                aria-label='启用 max_tokens 下限'
              />
            </div>
          </SettingRow>
        </CardContent>
      </Card>
      <HealthCacheCard
        probe={probe}
        real={real}
        onProbeChange={setProbe}
        onRealChange={setReal}
      />
      <ModelTraceCard
        config={modelTrace}
        onChange={(next) => setProbe({ model_trace: { ...modelTrace, ...next } })}
      />
      <SignatureRepairCard failover={failover} onChange={onFailoverChange} />
    </>
  )
}

function ModelTraceCard({ config, onChange }: { config: Obj; onChange: (patch: Obj) => void }) {
  const queryClient = useQueryClient()
  const status = useQuery(modelTraceQueryOptions())
  const run = useMutation({
    mutationFn: () => api<ModelTracePayload>('/api/panel/model-trace', { method: 'POST', body: '{}' }),
    onSuccess: (data) => queryClient.setQueryData(['panel', 'model-trace'], data),
  })
  const snapshot = status.data?.snapshot
  const statusText = snapshot?.status === 'match'
    ? '与请求模型相符'
    : snapshot?.status === 'mismatch'
      ? '归因不一致'
      : snapshot?.status === 'uncertain'
        ? '无法确认'
        : snapshot?.status === 'incomplete'
          ? '采样不足'
          : snapshot?.status === 'running'
            ? '后台检测中'
            : snapshot?.status === 'interrupted'
              ? '检测已中断'
          : snapshot?.error
            ? '检测失败'
            : '暂无结果'
  const variant = snapshot?.status === 'mismatch' ? 'destructive' : snapshot?.status === 'match' ? 'default' : 'secondary'
  return (
    <Card>
      <CardHeader>
        <CardTitle>GPT 模型归因检测</CardTitle>
        <p className='text-xs text-muted-foreground'>基于 ModelTrace 数字指纹库采样归因，结果仅提示候选模型，不会自动停用槽位。</p>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow label='自动检测' desc='每个周期对选定 GPT 槽发送 3 次较长采样请求，默认关闭。'>
          <Switch checked={config.enabled === true} onCheckedChange={(enabled) => onChange({ enabled })} aria-label='启用 GPT 模型归因检测' />
        </SettingRow>
        <SettingRow label='检测间隔' desc='秒，3600–604800'>
          <Input className='w-28' type='number' min={3600} max={604800} value={Number(config.interval_sec ?? 86400)} onChange={(event) => onChange({ interval_sec: clampInt(event.target.value, 3600, 604800, 86400) })} aria-label='模型归因检测间隔' />
        </SettingRow>
        <SettingRow label='GPT 槽 ID' desc='留空自动选择一个可检测槽'>
          <Input className='w-56' value={String(config.vm_id ?? '')} onChange={(event) => onChange({ vm_id: event.target.value })} aria-label='模型归因 GPT 槽 ID' />
        </SettingRow>
        <SettingRow label='请求模型'>
          <Input className='w-56' value={String(config.model ?? 'gpt-5.4')} onChange={(event) => onChange({ model: event.target.value })} aria-label='模型归因请求模型' />
        </SettingRow>
        <SettingRow label='最低置信度' desc='低于此值显示“无法确认”，0.3–0.95'>
          <Input className='w-28' type='number' min={0.3} max={0.95} step={0.05} value={Number(config.min_confidence ?? 0.55)} onChange={(event) => onChange({ min_confidence: Math.min(0.95, Math.max(0.3, Number(event.target.value) || 0.55)) })} aria-label='模型归因最低置信度' />
        </SettingRow>
        <SettingRow label='最近结果'>
          <div className='flex max-w-full flex-col items-end gap-1 text-xs'>
            <div className='flex flex-wrap items-center justify-end gap-2'>
              <span className='text-muted-foreground'>{snapshot?.vm_id || '—'} · {snapshot?.requested_model || '—'}</span>
              <Badge variant={variant} title={snapshot?.error || undefined}>{statusText}</Badge>
            </div>
            {snapshot?.prediction && <span>候选：{snapshot.prediction_name || snapshot.prediction} · {Math.round((snapshot.probability || 0) * 100)}%</span>}
            {snapshot?.status === 'running' && <span>进度：{snapshot.progress?.completed || 0}/{snapshot.progress?.total || 3} · {snapshot.phase === 'updating_bank' ? '更新指纹库' : '采样中'}</span>}
            {snapshot?.status === 'interrupted' && <span className='text-muted-foreground'>{snapshot.error}</span>}
            {snapshot?.at && <span className='text-muted-foreground'>{new Date(snapshot.at).toLocaleString()}</span>}
            <span className='text-muted-foreground'>指纹库 {status.data?.bank?.model_count || 0} 个模型 · 更新 {status.data?.bank?.built_at || '尚未拉取'}</span>
            {status.data?.bank?.updated_at && <span className='text-muted-foreground'>本地同步 {new Date(status.data.bank.updated_at).toLocaleString()}</span>}
          </div>
        </SettingRow>
        <div className='flex justify-end pt-3'>
          <Button type='button' size='sm' variant='outline' disabled={run.isPending || snapshot?.status === 'running'} onClick={() => run.mutate()}>
            {run.isPending ? '正在启动…' : snapshot?.status === 'running' ? '后台检测中' : '立即检测'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function HealthCacheCard({
  probe,
  real,
  onProbeChange,
  onRealChange,
}: {
  probe: Obj
  real: Obj
  onProbeChange: (patch: Obj) => void
  onRealChange: (patch: Obj) => void
}) {
  const status = useQuery(healthProbeQueryOptions())
  const snaps = status.data?.snapshots
  return (
    <Card>
      <CardHeader>
        <CardTitle>健康缓存</CardTitle>
        <p className='text-xs text-muted-foreground'>
          定时用真实槽位跑一次对话并缓存结果。new-api 渠道测试、sub2api
          账号测试这类 hi / ping 请求直接回放缓存，覆盖
          Messages、Chat、Responses 的流式和非流式。
        </p>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow label='启用' desc='关闭时探测请求照常进入调度'>
          <Switch
            checked={probe.enabled === true}
            onCheckedChange={(checked) => onProbeChange({ enabled: checked })}
            aria-label='启用健康缓存'
          />
        </SettingRow>
        <SettingRow label='探测间隔' desc='秒，30–86400'>
          <Input
            className='w-28'
            type='number'
            min={30}
            max={86400}
            value={Number(probe.interval_sec ?? 600)}
            onChange={(event) =>
              onProbeChange({
                interval_sec: clampInt(event.target.value, 30, 86400, 600),
              })
            }
            aria-label='探测间隔'
          />
        </SettingRow>
        <SettingRow
          label='全号轮询'
          desc='每个间隔对所有可调度槽各探一次（受并发上限、工作时段、冷却与凭证排除约束）。列表中首个成功的结果仍写入健康缓存；关闭时探测到第一个可用槽即停止。'
        >
          <Switch
            checked={probe.probe_all_slots === true}
            onCheckedChange={(checked) =>
              onProbeChange({ probe_all_slots: checked })
            }
            aria-label='全号轮询'
          />
        </SettingRow>
        <SettingRow label='缓存有效期' desc='秒，过期后探测请求照常进入调度'>
          <Input
            className='w-28'
            type='number'
            min={30}
            max={172800}
            value={Number(probe.cache_ttl_sec ?? 900)}
            onChange={(event) =>
              onProbeChange({
                cache_ttl_sec: clampInt(event.target.value, 30, 172800, 900),
              })
            }
            aria-label='缓存有效期'
          />
        </SettingRow>
        <SettingRow label='Claude 探测模型' desc='在 Claude 槽上跑真实探测'>
          <Input
            className='w-56'
            value={String(real.model ?? 'claude-haiku-4-5')}
            onChange={(event) => onRealChange({ model: event.target.value })}
            aria-label='Claude 探测模型'
          />
        </SettingRow>
        <SettingRow
          label='GPT 探测模型'
          desc='在 GPT 槽上跑真实探测。留空则 GPT 模型的探测请求不走缓存。'
        >
          <Input
            className='w-56'
            placeholder='gpt-5.4'
            value={String(real.openai_model ?? '')}
            onChange={(event) =>
              onRealChange({ openai_model: event.target.value })
            }
            aria-label='GPT 探测模型'
          />
        </SettingRow>
        <SettingRow label='最近快照'>
          <div className='flex flex-col items-end gap-1 text-xs'>
            <SnapshotLine label='Claude' snap={snaps?.anthropic} />
            <SnapshotLine label='GPT' snap={snaps?.openai} />
          </div>
        </SettingRow>
      </CardContent>
    </Card>
  )
}

function SnapshotLine({
  label,
  snap,
}: {
  label: string
  snap: HealthSnapshotView | undefined
}) {
  if (!snap?.at) {
    return <span className='text-muted-foreground'>{label}：暂无</span>
  }
  const tone = snap.ok ? 'default' : snap.error ? 'destructive' : 'secondary'
  const text = snap.ok ? '可用' : snap.error ? '失败' : '已过期'
  return (
    <span className='flex items-center gap-2'>
      <span className='text-muted-foreground'>
        {label} · {snap.vm_id || '—'} · {snap.model || '—'}
      </span>
      <Badge variant={tone} title={snap.error || undefined}>
        {text}
      </Badge>
    </span>
  )
}

function SignatureRepairCard({
  failover,
  onChange,
}: {
  failover: Obj
  onChange: (next: Obj) => void
}) {
  // 默认值在 gateway HEAD 与工作区之间相反（!== false vs === true），
  // 所以不硬编码默认态，严格按 GET /routing 的实际值回显。
  const enabled = failover.signature_repair === true
  return (
    <Card>
      <CardHeader>
        <CardTitle>签名修复</CardTitle>
      </CardHeader>
      <CardContent className='flex items-start justify-between gap-4'>
        <div className='space-y-1 text-sm text-muted-foreground'>
          <p>
            上游因思考签名返回 400 时，剥掉思考历史后重试一次，客户端最终看到
            200。
          </p>
          <p>
            关闭则把 400 原样透传 ——
            探测伪造签名时需要这个真实结果。其它修复（搜索 / 预填 / 工具配对 /
            schema / 自适应）不受此开关影响。
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            onChange({ ...failover, signature_repair: checked })
          }
          aria-label='签名修复'
        />
      </CardContent>
    </Card>
  )
}
