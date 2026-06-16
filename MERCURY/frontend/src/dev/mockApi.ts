import { scenarios, resetScenarios } from './mockScenarios'
import * as state from './mockState'
import { routeMockRequest } from './mockRouter'
import { createWebSocketPatcher } from './handlers/realtime'

const ADMIN_KEY = 'mercury_admin_token'

let origFetch: typeof fetch
let origWebSocket: typeof WebSocket
let installed = false

export type MercuryMockGlobal = {
  scenarios: typeof scenarios
  resetState: () => void
  getState: typeof state.getState
}

declare global {
  interface Window {
    __mercuryMock?: MercuryMockGlobal
  }
}

function buildRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  if (input instanceof Request) {
    if (init) return new Request(input, init)
    return input
  }
  return new Request(input, init)
}

export function installMock(): void {
  if (installed) return
  installed = true

  try {
    localStorage.setItem(ADMIN_KEY, 'mock')
  } catch {
    /* ignore */
  }

  origFetch = globalThis.fetch.bind(globalThis)
  origWebSocket = globalThis.WebSocket

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = buildRequest(input, init)
    try {
      const mockRes = await routeMockRequest(req)
      if (mockRes) return mockRes
    } catch {
      /* fall through */
    }
    return origFetch(input as RequestInfo, init)
  }

  globalThis.WebSocket = createWebSocketPatcher(origWebSocket)

  window.__mercuryMock = {
    scenarios,
    resetState: () => {
      state.resetState()
      resetScenarios()
    },
    getState: state.getState,
  }
}

export function uninstallMock(): void {
  if (!installed) return
  installed = false
  globalThis.fetch = origFetch
  globalThis.WebSocket = origWebSocket
  delete window.__mercuryMock
}
