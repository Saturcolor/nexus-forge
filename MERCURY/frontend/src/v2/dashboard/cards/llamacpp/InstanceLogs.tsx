import { useEffect, useRef } from 'react'
import { useLlamacppInstanceLogs } from '../../../../api/queries'
import { StatusDot } from '../../../ui/Badge'
import { clsx } from 'clsx'

function detectLoadPhase(line: string): string {
  if (line.includes('server is listening')) return 'Prêt'
  if (line.includes('model loaded')) return 'Modèle prêt'
  if (line.includes('warming up')) return 'Préchauffage…'
  // Progression du prefill — rétrocompat deux formats llama.cpp :
  //   ancien (<2026)   : "srv  update_slots: ... prompt processing progress, ... progress = 0.XX"
  //   nouveau (≥2026)  : "slot print_timing: ... | prompt processing, n_tokens = N, progress = 0.XX, t = ..."
  // Le `.*` greedy avale le mot "progress" de l'ancien format pour atteindre `progress = NUM`.
  // À tester AVANT le fallback "slot print_timing:" — sinon en ≥2026 chaque ligne de
  // progression serait étiquetée "Génération terminée".
  const progressMatch = line.match(/prompt processing.*progress\s*=\s*([\d.]+)/)
  if (progressMatch) {
    const pct = Math.round(parseFloat(progressMatch[1]) * 100)
    return `Traitement prompt ${pct}%`
  }
  // "Génération terminée" — `prompt eval time` et `slot release:` sont émis par les deux
  // versions. `slot print_timing:` (sans progress, donc non capté ci-dessus) reste un
  // fallback safe : en ancien format c'était LE marqueur de fin, en nouveau format c'est
  // uniquement la ligne d'en-tête du bloc final.
  if (
    line.includes('slot      release:') ||
    line.includes('prompt eval time') ||
    line.includes('slot print_timing:')
  ) return 'Génération terminée'
  if (line.includes('load_tensors: offloaded')) return 'GPU chargé'
  if (line.includes('load_tensors: offloading')) return 'Chargement GPU…'
  if (line.includes('buffer size') && (line.includes('Vulkan') || line.includes('CUDA') || line.includes('Metal'))) return 'VRAM alloué'
  if (line.includes('llama_kv_cache:') || line.includes('llama_context:')) return 'Init contexte…'
  if (line.includes('load_tensors:')) return 'Chargement tenseurs…'
  if (line.includes('print_info: model type')) return 'Lecture modèle…'
  return ''
}

/** SSE log feed for a single llamacpp instance — used in the drawer's "Logs" tab. */
export function InstanceLogs({ modelId, active }: { modelId: string; active: boolean }) {
  const { lines, connected, error } = useLlamacppInstanceLogs(modelId, active)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastLine = lines[lines.length - 1] ?? ''
  const phase = detectLoadPhase(lastLine)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusDot tone={connected ? 'warning' : 'muted'} pulse={connected} />
          <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
            Logs instance
          </span>
          {phase && <span className="text-[11px] text-theme-amber font-mono">· {phase}</span>}
        </div>
        <span className="text-[10px] text-muted-foreground/60 font-mono">
          {lines.length} lignes
        </span>
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div
        ref={scrollRef}
        className="max-h-[400px] overflow-y-auto font-mono text-[10px] text-muted-foreground bg-background border border-border/60 rounded-md p-2 space-y-0.5"
      >
        {lines.length === 0 ? (
          <p className="text-muted-foreground/50">En attente de logs…</p>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={clsx(
                'whitespace-pre-wrap break-all leading-relaxed',
                line.toLowerCase().includes('error') && 'text-destructive/90',
                line.includes('VRAM') && 'text-primary/90',
              )}
            >
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
