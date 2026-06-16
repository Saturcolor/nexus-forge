/**
 * Mock pour le pipe OmniVoice (TTS clone zero-shot exposé par le brain-daemon).
 *
 * State local au module — pas de persistance, reset au reload du dev server.
 * Permet de tester :
 *   • GET    /admin/audio/omnivoice/status         (status engine + nb profils)
 *   • POST   /admin/audio/omnivoice/load           (toggle loaded=true)
 *   • POST   /admin/audio/omnivoice/unload         (toggle loaded=false)
 *   • GET    /admin/audio/omnivoice/profiles       (liste profils)
 *   • DELETE /admin/audio/omnivoice/profiles/{id}  (suppression)
 *
 * `getOmniMockState()` est exporté pour que admin-routes.ts puisse enrichir
 * `/admin/audio/local/health` avec un sous-objet `omnivoice` + `profiles_count`
 * cohérent avec le reste.
 */
import { json } from '../http-helpers'

type OmniProfile = {
  id: string
  name: string
  ref_path: string
  ref_text: string | null
  language: string
  instruct: string | null
  description: string | null
  master: string
  tags: string[]
  created_at: number
  locked: boolean
}

type OmniState = {
  loaded: boolean
  device: string
  num_step: number
  guidance_scale: number
  sample_rate: number
  error: string | null
  profiles: OmniProfile[]
}

const state: OmniState = {
  loaded: true,
  device: 'cuda',
  num_step: 8,
  guidance_scale: 2.0,
  sample_rate: 24000,
  error: null,
  profiles: [
    {
      id: 'clone:test',
      name: 'Test',
      ref_path: '/var/lib/brain-daemon/voices/clone_test.wav',
      ref_text: 'Ceci est un échantillon de référence pour tester le clonage de voix.',
      language: 'fr',
      instruct: null,
      description: null,
      master: 'raw',
      tags: [],
      created_at: Math.floor(Date.now() / 1000) - 3600,
      locked: false,
    },
    {
      id: 'clone:user',
      name: 'User',
      ref_path: '/var/lib/brain-daemon/voices/clone_user.wav',
      ref_text: null,
      language: 'fr',
      instruct: 'warm tone, slightly slower pace',
      description: null,
      master: 'warm',
      tags: ['perso'],
      created_at: Math.floor(Date.now() / 1000) - 7200,
      locked: false,
    },
  ],
}

/** Used by /admin/audio/local/health to expose a coherent omnivoice block. */
export function getOmniMockState() {
  return {
    omnivoice: {
      loaded: state.loaded,
      device: state.device,
      num_step: state.num_step,
      guidance_scale: state.guidance_scale,
      sample_rate: state.sample_rate,
      error: state.error,
    },
    profiles_count: state.profiles.length,
  }
}

export function tryAdminOmnivoiceRoutes(
  pathname: string,
  method: string,
  body: unknown,
): Response | null {
  // ── /admin/audio/omnivoice/status ──────────────────────────────────
  if (pathname === '/admin/audio/omnivoice/status' && method === 'GET') {
    return json({
      configured: true,
      loaded: state.loaded,
      device: state.device,
      sample_rate: state.sample_rate,
      num_step: state.num_step,
      guidance_scale: state.guidance_scale,
      error: state.error,
      profiles_count: state.profiles.length,
    })
  }

  // ── /admin/audio/omnivoice/load ────────────────────────────────────
  if (pathname === '/admin/audio/omnivoice/load' && method === 'POST') {
    const b = (body as { num_step?: number; guidance_scale?: number; device?: string } | null) ?? {}
    if (typeof b.num_step === 'number') state.num_step = b.num_step
    if (typeof b.guidance_scale === 'number') state.guidance_scale = b.guidance_scale
    if (typeof b.device === 'string' && b.device !== 'auto') state.device = b.device
    state.loaded = true
    state.error = null
    return json({
      loaded: state.loaded,
      device: state.device,
      sample_rate: state.sample_rate,
      num_step: state.num_step,
      guidance_scale: state.guidance_scale,
      error: state.error,
    })
  }

  // ── /admin/audio/omnivoice/unload ──────────────────────────────────
  if (pathname === '/admin/audio/omnivoice/unload' && method === 'POST') {
    const changed = state.loaded
    state.loaded = false
    state.device = 'cpu'
    return json({
      changed,
      loaded: state.loaded,
      device: state.device,
      sample_rate: state.sample_rate,
      num_step: state.num_step,
      guidance_scale: state.guidance_scale,
      error: state.error,
    })
  }

  // ── /admin/audio/omnivoice/profiles ────────────────────────────────
  if (pathname === '/admin/audio/omnivoice/profiles' && method === 'GET') {
    return json({ profiles: state.profiles })
  }

  // ── /admin/audio/omnivoice/profiles/{id} ───────────────────────────
  const idMatch = pathname.match(/^\/admin\/audio\/omnivoice\/profiles\/(.+)$/)
  if (idMatch && method === 'DELETE') {
    const id = decodeURIComponent(idMatch[1])
    const before = state.profiles.length
    state.profiles = state.profiles.filter(p => p.id !== id)
    if (state.profiles.length === before) {
      return json({ detail: 'Profile not found' }, { status: 404 })
    }
    return json({ ok: true })
  }
  if (idMatch && method === 'PATCH') {
    const id = decodeURIComponent(idMatch[1])
    const idx = state.profiles.findIndex(p => p.id === id)
    if (idx === -1) {
      return json({ detail: 'Profile not found' }, { status: 404 })
    }
    const patch = (body as Partial<OmniProfile> | null) ?? {}
    const allowed: (keyof OmniProfile)[] = [
      'name', 'ref_text', 'language', 'instruct',
      'description', 'master', 'tags', 'locked',
    ]
    const next: OmniProfile = { ...state.profiles[idx] }
    for (const k of allowed) {
      if (k in patch) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(next as any)[k] = (patch as any)[k]
      }
    }
    state.profiles[idx] = next
    return json(next)
  }

  return null
}
