import * as state from '../mockState'
import type { MockServerSeed } from '../seed'

export function s(): MockServerSeed {
  return state.getMutableState()
}

export function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}
