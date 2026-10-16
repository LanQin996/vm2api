/**
 * Live Docker memory raise for existing slots: `docker update` first, persist
 * machine.memory / runtime.memory only after the container limit matches.
 */
import { execFileSync } from 'node:child_process'

import { slotHost } from './slot-host.mjs'
import { containerName } from './vm-runtime.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { memoryMiB, slotMemory, validateVmConfigPatch, VM_MEMORY_OPTIONS } from './machine-spec.mjs'
import { patchVmRecord } from './vm-registry.mjs'

function defaultExec(argv, opts = {}) {
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout: opts.timeout ?? 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env || process.env,
    })
    return { ok: true, stdout: String(out || '').trim(), stderr: '' }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim(),
      code: error.status,
    }
  }
}

export function formatDockerMemoryBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return null
  const gi = 1024 ** 3
  const mi = 1024 ** 2
  if (n % gi === 0) return `${n / gi}g`
  if (n % mi === 0) return `${n / mi}m`
  return `${Math.max(1, Math.round(n / mi))}m`
}

export function sameMemoryLimit(a, b) {
  return (
    String(a || '')
      .trim()
      .toLowerCase() ===
    String(b || '')
      .trim()
      .toLowerCase()
  )
}

function dockerExec(vm, argv, execImpl, timeout) {
  const env = slotHost(vm).dockerEnv()
  return execImpl(argv, { timeout, ...(env ? { env } : {}) })
}

export function inspectDockerContainerMemory(vm, execImpl = defaultExec) {
  const name = containerName(vm?.id)
  const r = dockerExec(vm, ['docker', 'inspect', '-f', '{{.HostConfig.Memory}}', name], execImpl, 10_000)
  if (!r.ok) {
    return {
      ok: false,
      code: 'container_inspect_failed',
      message: (r.stderr || r.stdout || 'docker inspect failed').trim(),
    }
  }
  const formatted = formatDockerMemoryBytes(String(r.stdout || '').trim())
  if (!formatted) {
    return { ok: false, code: 'container_memory_unreadable', message: '无法读取容器内存上限' }
  }
  return { ok: true, memory: formatted, bytes: Number(String(r.stdout || '').trim()) }
}

export function validateDockerMemoryRaise(vm, requestedMemory, routing) {
  if (isKvmRuntime(vm)) {
    return {
      ok: false,
      code: 'kvm_memory_raise_forbidden',
      message: 'KVM 槽位不支持在线调整 Docker 内存',
    }
  }
  const checked = validateVmConfigPatch({ memory: requestedMemory })
  if (!checked.ok) {
    return { ok: false, code: 'invalid_memory', message: checked.error }
  }
  const target = String(requestedMemory).trim().toLowerCase()
  const configured = slotMemory(vm, routing)
  const configuredMiB = memoryMiB(configured)
  const targetMiB = memoryMiB(target)
  if (targetMiB <= configuredMiB) {
    return {
      ok: false,
      code: 'memory_not_increased',
      message: `新内存须高于当前配置 ${configured}（可选：${VM_MEMORY_OPTIONS.join('、')}）`,
      current: configured,
      requested: target,
    }
  }
  return { ok: true, memory: target, previous: configured }
}

export function raiseDockerSlotMemory(projectRoot, vm, requestedMemory, { routing, execImpl = defaultExec } = {}) {
  const validated = validateDockerMemoryRaise(vm, requestedMemory, routing)
  if (!validated.ok) return validated

  const mem = validated.memory
  const name = containerName(vm.id)
  const update = dockerExec(vm, ['docker', 'update', '--memory', mem, '--memory-swap', mem, name], execImpl, 15_000)
  if (!update.ok) {
    const inspected = inspectDockerContainerMemory(vm, execImpl)
    return {
      ok: false,
      code: 'docker_update_failed',
      message: (update.stderr || update.stdout || 'docker update failed').trim(),
      requested: mem,
      container_memory: inspected.ok ? inspected.memory : null,
    }
  }

  const inspected = inspectDockerContainerMemory(vm, execImpl)
  if (!inspected.ok) {
    return {
      ok: false,
      code: inspected.code,
      message: inspected.message,
      requested: mem,
    }
  }
  if (memoryMiB(inspected.memory) < memoryMiB(mem)) {
    return {
      ok: false,
      code: 'memory_diverged',
      message: `容器内存为 ${inspected.memory}，与请求的 ${mem} 不一致，未写入配置`,
      requested: mem,
      container_memory: inspected.memory,
    }
  }

  const saved = patchVmRecord(projectRoot, vm.id, (record) => {
    const next = {
      machine: { ...(record.machine || {}), memory: inspected.memory },
    }
    if (record.runtime && typeof record.runtime === 'object') {
      next.runtime = { ...record.runtime, memory: inspected.memory }
    }
    return next
  })
  if (!saved) {
    return {
      ok: false,
      code: 'vm_not_found',
      message: 'vm not found',
      requested: mem,
      container_memory: inspected.memory,
    }
  }

  return {
    ok: true,
    memory: inspected.memory,
    previous: validated.previous,
    container_memory: inspected.memory,
    vm: saved,
  }
}
