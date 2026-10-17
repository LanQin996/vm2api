# Optional Docker slot CPU limits

Docker slots have historically used `machine.memory` but **not** `machine.vcpus`.
`vcpus` remains a KVM guest setting; existing Docker slots do not acquire a cap
when upgrading.

The panel creation API (`POST /api/panel/vms/create`) now accepts an optional
per-slot `machine.docker_cpus` number, for example alongside the other required
creation options:

```json
{
  "runtime_type": "docker",
  "machine": { "memory": "1g", "docker_cpus": 0.5 },
  "start": false
}
```

- Omitted or `0`: no CPU quota (backward-compatible default).
- `0.01` through `16`: a CPU-time hard ceiling, including fractional CPUs.
  For example `0.5` means up to half of one host CPU's time, not a dedicated CPU.
- Strings, null, non-finite numbers and out-of-range values are rejected with
  `invalid_machine`; `docker_cpus` is rejected for KVM creation.
- The quota is saved in the slot's `machine` record. Local Docker creation uses
  `--cpus`; cluster Docker creation uses the equivalent Engine `NanoCpus` field.
  Claude and GPT Docker slots share the same policy.
- This is an API-only, per-slot creation option. The current creation form and
  global defaults have no CPU-quota control. No implicit fallback to global
  `vcpus`, migration or fleet-wide quota update is performed.

## When it takes effect

Only **container creation/recreation** applies resource arguments. A normal
start of an existing stopped container, a kernel restart, or a control-plane
restart retains that container's existing limits. This change does not add a
live-update endpoint, automatically recreate existing slots, or modify storage,
identity, KVM runner resources or memory/swap policy.

CPU quota is not CPU affinity or a reservation. Very small limits can increase
CLI startup and response latency. The daemon must support CPU quotas; Docker
creation errors are returned rather than retrying without the requested cap.

## Checks

`node --test test/unit/docker-slot-cpu.test.mjs` covers strict validation,
legacy defaults, local/cluster argument parity, Claude/GPT and KVM exclusion.
An operator can inspect `HostConfig.NanoCpus` and, on cgroup v2, `cpu.max` inside
a separately authorized disposable container. Do not load-test serving slots.
