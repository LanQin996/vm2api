/**
 * `POST /api/panel/vms/:id/test-chat` 的返回契约。
 *
 * 注意两层 `ok`：外层 envelope 的 `ok` 恒为 true（`panel.ok()` 包的），
 * 业务成败在剥壳后的这个 `ok` 里。`lib/api.ts` 的 unwrapEnvelope 只看外层，
 * 所以调用方必须自己判 `data.ok`，不能指望 mutation 的 onError。
 *
 * 网关共 8 个 return 分支：3 个早退分支连 `vm_id` 都没有，5 个有部分字段，
 * 只有主分支字段齐全 —— 故除 `ok`/`log`/`duration_ms` 外全部可选。
 */

export type TestChatLogLevel = 'info' | 'error' | 'ok' | 'content'

export type TestChatLogLine = {
  at: string
  level: TestChatLogLevel
  message: string
}

export type TestChatUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  [key: string]: unknown
}

export type TestChatError = {
  code?: string
  message?: string
  type?: string
  param?: string
  request_id?: string
  retry_after?: number
  status?: number
  upstream_message?: string
  [key: string]: unknown
}

export type TestChatResult = {
  /** 这三个字段所有分支都有。 */
  ok: boolean
  log: TestChatLogLine[]
  duration_ms: number
  /** 以下仅主分支（以及部分早退分支）才有。 */
  vm_id?: string
  vm_name?: string | null
  account_uuid?: string | null
  model?: string
  prompt?: string
  max_tokens?: number
  /** 上游 HTTP 状态；网络错或超时为 0。 */
  status?: number
  stop_reason?: string | null
  usage?: TestChatUsage | null
  /** 模型回复正文，最多 4000 字符。 */
  text?: string | null
  body?: Record<string, unknown> | null
  error?: TestChatError | null
  via?: string
  credential_mode?: string
  inference_engine?: string | null
  dataplane?: string | null
  official_cc_inference?: string | null
  debug?: Record<string, unknown>
}

/** 把 log 按语义归成阶段，网关本身没给阶段标识，这是纯前端分组。 */
export type TestChatStage = {
  key: string
  label: string
  lines: TestChatLogLine[]
  /** 该阶段是否出现了 error 行。 */
  failed: boolean
}

const STAGE_RULES: [string, string, RegExp][] = [
  ['start', '槽位', /^(开始测试|状态 |推理 )/],
  ['cred', '凭证', /^(凭证 |无 OAuth)/],
  ['proxy', '代理', /^(代理 |未绑定 SOCKS5)/],
  ['model', '模型', /^(模型|prompt=)/],
  ['send', '发起请求', /^(入站 |loopback |\/v1 loopback)/],
  ['result', '结果', /^(成功 |失败 |命中槽 |usage |request_id=)/],
]

/**
 * 按消息前缀把日志分组成阶段。`level: 'content'` 那行是模型回复正文
 * 而非日志，单独摘出去，不进任何阶段。
 */
export function groupTestChatStages(log: TestChatLogLine[]): TestChatStage[] {
  const out: TestChatStage[] = []
  for (const line of log) {
    if (line.level === 'content') continue
    const rule = STAGE_RULES.find(([, , re]) => re.test(line.message))
    const key = rule ? rule[0] : 'other'
    const label = rule ? rule[1] : '其它'
    let stage = out.find((s) => s.key === key)
    if (!stage) {
      stage = { key, label, lines: [], failed: false }
      out.push(stage)
    }
    stage.lines.push(line)
    if (line.level === 'error') stage.failed = true
  }
  return out
}

/**
 * 相邻两行的时间差。阶段 1~8 都是本地同步逻辑、几乎全挤在同一毫秒，
 * 真正有耗时的只有「发起 → 结果」那一段，所以只在差值有意义时才显示。
 */
export function lineElapsedMs(
  log: TestChatLogLine[],
  index: number
): number | null {
  if (index <= 0) return null
  const prev = Date.parse(log[index - 1]?.at || '')
  const cur = Date.parse(log[index]?.at || '')
  if (!Number.isFinite(prev) || !Number.isFinite(cur)) return null
  const d = cur - prev
  return d > 0 ? d : null
}
