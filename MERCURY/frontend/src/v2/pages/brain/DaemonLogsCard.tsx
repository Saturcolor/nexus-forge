import { useState, useEffect, useRef } from 'react'
import { ScrollText, ChevronDown, ChevronRight } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Button } from '../../ui/Button'
import { useLlamacppDaemonLogs } from '../../../api/queries'

function colorize(line: string): string {
  if (/\[ERROR\]|error|FAILED|crash/i.test(line))      return 'text-destructive'
  if (/\[WARN\]|warning/i.test(line))                   return 'text-theme-amber'
  if (/THERMAL|SIGSTOP|SIGCONT|EMERGENCY/i.test(line)) return 'text-orange-400'
  if (/\[perf\]|PERFORMANCE|ECO/i.test(line))          return 'text-primary'
  if (/load:|ready|started/i.test(line))                return 'text-theme-green'
  return 'text-muted-foreground'
}

export function DaemonLogsCard() {
  const [collapsed,   setCollapsed]   = useState(true)
  const [enabled,     setEnabled]     = useState(true)
  const { data }                      = useLlamacppDaemonLogs(enabled && !collapsed)
  const containerRef                  = useRef<HTMLDivElement>(null)
  const [autoScroll,  setAutoScroll]  = useState(true)

  const logs = data?.logs ?? []

  useEffect(() => {
    if (!collapsed && autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs.length, autoScroll, collapsed])

  const handleScroll = () => {
    if (!containerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40)
  }

  return (
    <Card className={collapsed ? '' : 'max-h-[420px]'}>
      <CardHeader
        title="Daemon Logs"
        icon={<ScrollText size={13} />}
        right={
          <div className="flex items-center gap-2">
            {!collapsed && (
              <>
                {!autoScroll && (
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => {
                      setAutoScroll(true)
                      if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight
                    }}
                  >
                    ↓ Scroll bas
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={enabled ? 'subtle' : 'primary'}
                  onClick={() => setEnabled(v => !v)}
                >
                  {enabled ? 'Pause' : 'Resume'}
                </Button>
                <span className="text-[10px] text-muted-foreground/50 font-mono">{logs.length} lignes</span>
              </>
            )}
            <button
              type="button"
              onClick={() => setCollapsed(v => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1"
            >
              {collapsed
                ? <><ChevronRight size={13} /><span className="hidden sm:inline">Voir les logs</span></>
                : <><ChevronDown  size={13} /><span className="hidden sm:inline">Replier</span></>
              }
            </button>
          </div>
        }
      />

      {!collapsed && (
        <CardBody className="!p-0 flex flex-col">
          <div
            ref={containerRef}
            onScroll={handleScroll}
            className="flex-1 min-h-0 overflow-y-auto px-4 py-2 font-mono text-[11px] leading-relaxed bg-background/50"
          >
            {logs.length === 0 && <p className="text-muted-foreground/40">Aucun log</p>}
            {logs.map((line: string, i: number) => (
              <div key={i} className={`whitespace-pre-wrap break-all ${colorize(line)}`}>{line}</div>
            ))}
          </div>
        </CardBody>
      )}
    </Card>
  )
}
