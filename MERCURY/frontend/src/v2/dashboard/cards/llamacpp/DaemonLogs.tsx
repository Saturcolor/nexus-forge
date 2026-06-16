import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useLlamacppDaemonLogs } from '../../../../api/queries'
import { StatusDot } from '../../../ui/Badge'
import { clsx } from 'clsx'

/** Collapsible SSE feed for the llamacpp daemon (mgmt/logs). */
export function DaemonLogs({
  open,
  onToggle,
}: {
  open: boolean
  onToggle: () => void
}) {
  const { data, error } = useLlamacppDaemonLogs(open)
  const lines: string[] = data?.logs ?? []
  const errMsg = error instanceof Error ? error.message : data?.error ?? null
  const connected = open && !errMsg
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length, open])

  return (
    <div className="border border-border/40 rounded-lg overflow-hidden bg-background/40">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/30 transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <StatusDot tone={connected ? 'warning' : 'muted'} pulse={open && connected} />
        <span className="text-[10px] uppercase tracking-widest font-semibold text-foreground">
          Logs daemon
        </span>
        <span className="text-[10px] text-muted-foreground/60 ml-auto font-mono">
          {open ? `${lines.length} lignes` : 'fermé'}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/40">
          {errMsg && <p className="px-3 py-2 text-[11px] text-destructive">{errMsg}</p>}
          <div
            ref={scrollRef}
            className="max-h-[260px] overflow-y-auto font-mono text-[10px] text-muted-foreground p-3 space-y-0.5"
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
      )}
    </div>
  )
}
