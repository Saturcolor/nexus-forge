/**
 * Toggles scénarios — console : window.__mercuryMock.scenarios.slotActive = true
 */
export type MercuryMockScenarios = {
  slotActive: boolean
  slotOwner: string
  ollamaDown: boolean
  healthzDegraded: boolean
  embeddingsFailAll: boolean
  anthropicStreamError: boolean
  requireApiKey: boolean
  lmStudioResponses400: boolean
}

export const scenarios: MercuryMockScenarios = {
  slotActive: false,
  slotOwner: 'alice',
  ollamaDown: false,
  healthzDegraded: false,
  embeddingsFailAll: false,
  anthropicStreamError: false,
  requireApiKey: false,
  lmStudioResponses400: false,
}

export function resetScenarios(): void {
  scenarios.slotActive = false
  scenarios.slotOwner = 'alice'
  scenarios.ollamaDown = false
  scenarios.healthzDegraded = false
  scenarios.embeddingsFailAll = false
  scenarios.anthropicStreamError = false
  scenarios.requireApiKey = false
  scenarios.lmStudioResponses400 = false
}
