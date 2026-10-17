/**
 * Operator schedule toggle outranks automatic in/out-of-pool writes.
 * routing.pool.manual_schedule_wins defaults to true.
 */

let manualScheduleWins = true

export function setManualScheduleWins(value) {
  manualScheduleWins = value !== false
  return manualScheduleWins
}

export function getManualScheduleWins() {
  return manualScheduleWins
}

export function isManualScheduleLocked(vm) {
  if (!getManualScheduleWins() || !vm) return false
  if (vm.schedule_manual === true) return true
  const reason = String(vm.schedule_disabled_reason || '')
  return reason === 'disabled' || reason === 'kernel_update'
}
