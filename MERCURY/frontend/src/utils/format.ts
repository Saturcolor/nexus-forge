/**
 * Formate un timestamp ISO (ex. 2026-03-03T08:55:12.098039Z) en date/heure lisible (FR).
 */
export function formatLogDateTime(iso: string | undefined | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    return iso
  }
}

/**
 * Affiche le statut pour les logs : code HTTP (200, 400, 500…). "ok" → "200".
 */
export function formatLogStatus(status: string | undefined | null): string {
  if (status == null || status === '') return '—'
  const s = String(status).trim().toLowerCase()
  if (s === 'ok') return '200'
  if (/^\d{3}$/.test(s)) return s
  return String(status).trim()
}

/** Classes Tailwind pour le badge de statut logs : vert 2xx/ok, rouge 4xx/5xx, neutre sinon. */
export function logStatusBadgeClass(status: string | undefined | null): string {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'ok' || /^2\d{2}$/.test(s)) return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
  if (/^[45]\d{2}$/.test(s)) return 'bg-red-500/20 text-red-400 border-red-500/30'
  if (s === 'error') return 'bg-red-500/20 text-red-400 border-red-500/30'
  return 'bg-neutral-600/30 text-neutral-400 border-neutral-500/30'
}

/**
 * Formate une durée en ms de façon lisible (ex. 2221.69 → "2,22 s", 500 → "500 ms").
 */
export function formatDurationMs(ms: number | undefined | null): string {
  if (ms == null || Number.isNaN(ms)) return '—'
  if (ms >= 1000) {
    const s = ms / 1000
    return `${s.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} s`
  }
  return `${Math.round(ms)} ms`
}

type UsageLike = {
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  ttft_seconds?: number
  tokens_per_second?: number
} | null | undefined

/**
 * Formate un nombre de tokens (ex. 27227 → "27k", 67 → "67").
 */
export function formatTokenCount(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/**
 * Résumé usage pour une requête : "in / out" ou "in / out · tok/s" ou "in / out (reasoning) · TTFT".
 * Si usage.tokens_per_second est absent mais qu'on a output_tokens et durationMs, on calcule tok/s.
 */
export function formatUsageSummary(usage: UsageLike, durationMs?: number | null): string {
  if (!usage) return '—'
  const in_ = usage.input_tokens
  const out = usage.output_tokens
  const reas = usage.reasoning_tokens
  let tps = usage.tokens_per_second
  if ((tps == null || tps <= 0) && out != null && out > 0 && durationMs != null && durationMs > 0) {
    tps = out / (durationMs / 1000)
  }
  const ttft = usage.ttft_seconds
  const parts: string[] = []
  if (in_ != null && out != null) {
    parts.push(`${formatTokenCount(in_)} in / ${formatTokenCount(out)} out`)
    if (reas != null && reas > 0) parts[0] = `${formatTokenCount(in_)} in / ${formatTokenCount(out)} out (${formatTokenCount(reas)} reasoning)`
  } else if (in_ != null) parts.push(`${formatTokenCount(in_)} in`)
  else if (out != null) parts.push(`${formatTokenCount(out)} out`)
  if (tps != null && tps > 0) parts.push(`${tps.toFixed(1)} tok/s`)
  if (ttft != null && ttft > 0) parts.push(`TTFT ${ttft.toFixed(2)} s`)
  return parts.length ? parts.join(' · ') : '—'
}
