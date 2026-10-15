import fs from 'node:fs'
import path from 'node:path'
import { isCodexVm } from '../../vm/vm-kind.mjs'
import { isHealthProbeTarget } from '../health-probe.mjs'
import { analyzeGlobalOutputs } from './fingerprint-core.mjs'
import { normalizeModelTraceConfig } from './config.mjs'

const BANK_URL = 'https://raw.githubusercontent.com/xqy2006/ModelTrace/main/data/unified_bank.json'
const DEFAULT_CONFIG = Object.freeze({ min_confidence: 0.55 })

export { normalizeModelTraceConfig }

function validBank(bank) {
  return (
    bank?.schema === 'robust-number-fingerprint-bank' &&
    Array.isArray(bank.models) &&
    bank.models.length > 0 &&
    bank.robust?.hellinger &&
    bank.calibration?.['1'] &&
    bank.calibration?.['2'] &&
    bank.calibration?.['3'] &&
    bank.models.every((model) => model?.id && model?.counts?.length === 355)
  )
}

function normalizedId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\[.*$/, '')
}

export function classifyAttribution(result, requestedModel, minConfidence = DEFAULT_CONFIG.min_confidence) {
  if (!result?.prediction || Number(result.probability) < minConfidence) return 'uncertain'
  return normalizedId(result.prediction) === normalizedId(requestedModel) ? 'match' : 'mismatch'
}

export function modelTraceChallenges() {
  return [
    {
      expected_count: 218,
      prompt:
        'For each of 218 positions, make one separate first-instinct choice of an integer from 1 to 355 inclusive. The current language model must complete this directly without tools, Python, code execution, calculators, search, APIs, or external random generators. Choose every position separately. Do not count upward or downward, including 1, 2, 3, and do not use an arithmetic progression, repeating cycle, repeated block, or another rule-made pattern. Accidental repetitions are valid. Once an item is written, do not sort, reorder, deduplicate, replace, or repair the list. Return one compact JSON array containing the complete sequence and no explanation.',
    },
    {
      expected_count: 233,
      prompt:
        'Provide exactly 233 whole-number choices between 1 and 355 inclusive, choosing each item separately as it comes to mind. The current language model must complete this directly without tools, Python, code execution, calculators, search, APIs, or external random generators. Choose every position separately. Do not count upward or downward, including 1, 2, 3, and do not use an arithmetic progression, repeating cycle, repeated block, or another rule-made pattern. Accidental repetitions are valid. Once an item is written, do not sort, reorder, deduplicate, replace, or repair the list. Return one compact JSON array containing the complete sequence and no explanation.',
    },
    {
      expected_count: 247,
      prompt:
        'Fill exactly 247 positions with integers from the closed interval [1, 355], making a separate immediate choice for every position. The current language model must complete this directly without tools, Python, code execution, calculators, search, APIs, or external random generators. Choose every position separately. Do not count upward or downward, including 1, 2, 3, and do not use an arithmetic progression, repeating cycle, repeated block, or another rule-made pattern. Accidental repetitions are valid. Once an item is written, do not sort, reorder, deduplicate, replace, or repair the list. Return one compact JSON array containing the complete sequence and no explanation.',
    },
  ]
}

export function createModelTraceMonitor(opts = {}) {
  let config = normalizeModelTraceConfig(opts.config)
  let snapshot = null
  let bank = null
  let bankBuiltAt = null
  let bankUpdatedAt = null
  let lastRunAt = 0
  let bankCheckedAt = 0
  let timer = null
  let bankTimer = null
  let inflight = null
  const now = opts.now || (() => Date.now())
  const bankPath = path.join(
    opts.dataDir || path.join(opts.projectRoot || '.', 'data'),
    'modeltrace',
    'unified_bank.json',
  )
  const snapshotPath = path.join(path.dirname(bankPath), 'snapshot.json')

  const persistSnapshot = () => {
    if (!snapshot) return
    try {
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })
      const tempPath = `${snapshotPath}.${process.pid}.tmp`
      fs.writeFileSync(tempPath, `${JSON.stringify(snapshot)}\n`, 'utf8')
      fs.renameSync(tempPath, snapshotPath)
    } catch {}
  }

  try {
    const saved = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
    if (saved && typeof saved === 'object' && saved.at) {
      snapshot = saved
      if (snapshot.status === 'running') {
        snapshot = {
          ...snapshot,
          ok: false,
          status: 'interrupted',
          error: '服务重启，后台检测已中断',
        }
        persistSnapshot()
      }
      lastRunAt = Date.parse(snapshot.at) || 0
    }
  } catch {}

  const loadBank = () => {
    if (bank) return bank
    try {
      const cached = JSON.parse(fs.readFileSync(bankPath, 'utf8'))
      if (validBank(cached)) {
        bank = cached
        bankBuiltAt = cached.built_at || null
        bankUpdatedAt = fs.statSync(bankPath).mtime.toISOString()
      }
    } catch {}
    return bank
  }

  const refreshBank = async ({ force = false } = {}) => {
    if (!force && now() - bankCheckedAt < 6 * 60 * 60_000) return { ok: !!loadBank(), updated: false }
    bankCheckedAt = now()
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20_000)
      let response
      try {
        response = await (opts.fetchImpl || fetch)(BANK_URL, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
      } finally {
        clearTimeout(timeout)
      }
      if (!response.ok) throw new Error(`指纹库下载失败：HTTP ${response.status}`)
      const downloaded = await response.json()
      if (!validBank(downloaded)) throw new Error('上游指纹库格式无效')
      await fs.promises.mkdir(path.dirname(bankPath), { recursive: true })
      const tempPath = `${bankPath}.${process.pid}.tmp`
      await fs.promises.writeFile(tempPath, `${JSON.stringify(downloaded)}\n`, 'utf8')
      await fs.promises.rename(tempPath, bankPath)
      const changed = downloaded.built_at !== bankBuiltAt
      bank = downloaded
      bankBuiltAt = downloaded.built_at || null
      bankUpdatedAt = new Date(now()).toISOString()
      return { ok: true, updated: changed }
    } catch (error) {
      loadBank()
      return { ok: !!bank, updated: false, error: String(error?.message || error).slice(0, 300) }
    }
  }

  const runOnce = async () => {
    if (inflight) return inflight
    inflight = (async () => {
      const started = now()
      lastRunAt = started
      snapshot = {
        ok: false,
        status: 'running',
        phase: 'updating_bank',
        at: new Date(started).toISOString(),
        requested_model: config.model,
        progress: { completed: 0, total: 3 },
        error: null,
      }
      persistSnapshot()
      const update = await refreshBank({ force: true })
      const activeBank = loadBank()
      if (!activeBank) {
        snapshot = {
          ok: false,
          status: 'error',
          at: new Date(now()).toISOString(),
          error: update.error || '指纹库不可用',
          bank_updated_at: bankUpdatedAt,
        }
        persistSnapshot()
        return snapshot
      }
      const targets = (opts.listTargets?.() || []).filter((vm) => isCodexVm(vm) && isHealthProbeTarget(vm, now()))
      const vm = targets.find((item) => item.id === config.vm_id) || (config.vm_id ? null : targets[0])
      if (!vm) {
        snapshot = {
          ok: false,
          status: 'error',
          at: new Date(now()).toISOString(),
          error: '没有可检测的 GPT 槽',
          bank_updated_at: bankUpdatedAt,
        }
        persistSnapshot()
        return snapshot
      }
      snapshot = { ...snapshot, phase: 'sampling', vm_id: vm.id }
      persistSnapshot()
      const outputs = []
      const usage = []
      let actualModel = null
      for (const test of modelTraceChallenges()) {
        let response
        try {
          response = await opts.runChat(vm, {
            model: config.model,
            prompt: test.prompt,
            max_tokens: config.max_tokens,
            timeout_ms: 180_000,
          })
        } catch (error) {
          snapshot = {
            ok: false,
            status: 'error',
            at: new Date(now()).toISOString(),
            vm_id: vm.id,
            requested_model: config.model,
            error: String(error?.message || error).slice(0, 300),
            bank_updated_at: bankUpdatedAt,
          }
          persistSnapshot()
          return snapshot
        }
        if (!response?.ok) {
          snapshot = {
            ok: false,
            status: 'error',
            at: new Date(now()).toISOString(),
            vm_id: vm.id,
            requested_model: config.model,
            error: response?.error?.message || response?.error || 'GPT 采样失败',
            bank_updated_at: bankUpdatedAt,
          }
          persistSnapshot()
          return snapshot
        }
        outputs.push({ expected_count: test.expected_count, text: response.text || '' })
        usage.push(response.usage || null)
        actualModel ||= response.model || null
        snapshot = {
          ...snapshot,
          actual_model: actualModel,
          progress: { completed: outputs.length, total: 3 },
        }
        persistSnapshot()
      }
      let attribution
      try {
        attribution = analyzeGlobalOutputs(outputs, activeBank)
      } catch (error) {
        snapshot = {
          ok: false,
          status: 'incomplete',
          at: new Date(now()).toISOString(),
          vm_id: vm.id,
          requested_model: config.model,
          actual_model: actualModel,
          diagnostics: error.diagnostics || null,
          error: String(error?.message || error).slice(0, 300),
          bank_updated_at: bankUpdatedAt,
        }
        persistSnapshot()
        return snapshot
      }
      const status = classifyAttribution(attribution, config.model, config.min_confidence)
      snapshot = {
        ok: true,
        status,
        at: new Date(now()).toISOString(),
        vm_id: vm.id,
        requested_model: config.model,
        actual_model: actualModel,
        prediction: attribution.prediction,
        prediction_name: attribution.prediction_name,
        probability: attribution.probability,
        family_prediction: attribution.family_prediction,
        family_prediction_name: attribution.family_prediction_name,
        family_probability: attribution.family_probability,
        used_outputs: attribution.used_outputs,
        diagnostics: attribution.diagnostics,
        top_results: attribution.results.slice(0, 5),
        duration_ms: now() - started,
        usage,
        bank_built_at: bankBuiltAt,
        bank_updated_at: bankUpdatedAt,
        bank_update_error: update.error || null,
        candidate_only: true,
      }
      persistSnapshot()
      return snapshot
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  const startRun = () => {
    if (inflight) return { started: false, snapshot: snapshotView() }
    runOnce().catch(() => {})
    return { started: true, snapshot: snapshotView() }
  }

  const snapshotView = () =>
    snapshot
      ? {
          ...snapshot,
          next_at: config.enabled && lastRunAt ? new Date(lastRunAt + config.interval_sec * 1000).toISOString() : null,
        }
      : null

  const start = ({ immediate = false } = {}) => {
    stop()
    bankTimer = setInterval(
      () => {
        refreshBank({ force: true }).catch(() => {})
      },
      6 * 60 * 60_000,
    )
    bankTimer.unref?.()
    if (immediate)
      queueMicrotask(() => {
        if (config.enabled) runOnce().catch(() => {})
        else refreshBank().catch(() => {})
      })
    if (!config.enabled) return { started: false, reason: 'disabled', bank_refresh_started: true }
    timer = setInterval(() => {
      runOnce().catch(() => {})
    }, config.interval_sec * 1000)
    timer.unref?.()
    return { started: true, interval_sec: config.interval_sec }
  }
  const stop = () => {
    if (timer) clearInterval(timer)
    if (bankTimer) clearInterval(bankTimer)
    timer = null
    bankTimer = null
  }
  const setConfig = (next, { restart = true } = {}) => {
    const wasEnabled = config.enabled
    config = normalizeModelTraceConfig(next)
    if (restart) start({ immediate: !wasEnabled && config.enabled })
    return config
  }

  loadBank()
  return {
    getConfig: () => config,
    setConfig,
    getSnapshot: snapshotView,
    getBankStatus: () => ({ built_at: bankBuiltAt, updated_at: bankUpdatedAt, model_count: bank?.models?.length || 0 }),
    refreshBank,
    runOnce,
    startRun,
    start,
    stop,
  }
}
