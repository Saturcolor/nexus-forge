import { scenarios } from '../mockScenarios'
import { json } from '../http-helpers'

export function tryHealthz(pathname: string, method: string): Response | null {
  if (pathname !== '/healthz' || method !== 'GET') return null
  if (scenarios.healthzDegraded) {
    return new Response(
      JSON.stringify({
        error: {
          message: 'Scheduler degraded',
          type: 'healthz_degraded',
          scheduler_last_tick_age_s: 150,
        },
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }
  return json({
    status: 'ok',
    scheduler_last_tick_age_s: 2,
  })
}
