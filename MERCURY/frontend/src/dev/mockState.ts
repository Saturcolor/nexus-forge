import type { ActiveSlot, ModelSchedule } from '../api/admin'
import { createSeed, type MockServerSeed } from './seed'
import { scenarios } from './mockScenarios'

let state: MockServerSeed = structuredClone(createSeed())

export function getState(): MockServerSeed {
  return state
}

export function resetState(): void {
  state = structuredClone(createSeed())
}

/** GET /admin/schedules — ends_at recalculé à chaque appel. */
export function buildSchedulesResponse(): { schedules: ModelSchedule[]; active_slot: ActiveSlot | null } {
  const schedules = state.schedules
  let slotId: string | null = state.activeSlotScheduleId
  if (scenarios.slotActive) {
    slotId = slotId ?? schedules.find(s => s.exclusive)?.id ?? null
  }
  if (!slotId) return { schedules, active_slot: null }
  const sch = schedules.find(s => s.id === slotId)
  if (!sch) return { schedules, active_slot: null }
  const endsAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const active_slot: ActiveSlot = {
    schedule_id: sch.id,
    schedule_name: sch.name,
    started_at: startedAt,
    ends_at: endsAt,
    exclusive: sch.exclusive,
    allowed_consumers: sch.allowed_consumers,
    snapshot: { loaded_models: [{ backend: 'llamacpp', model_id: 'Qwen/Qwen2.5-7B-Instruct-GGUF' }] },
  }
  return { schedules, active_slot }
}

export function replaceState(next: MockServerSeed): void {
  state = next
}

export function patchState(partial: Partial<MockServerSeed>): void {
  state = { ...state, ...partial }
}

/** Accès mutation directe (handlers). */
export function getMutableState(): MockServerSeed {
  return state
}
