import { useState } from 'react'
import { ScrollText, Filter, RefreshCw, X } from 'lucide-react'
import { useLogs, useDates } from '../../api/queries'
import {
  formatLogDateTime,
  formatLogStatus,
  formatDurationMs,
  formatUsageSummary,
} from '../../utils/format'
import { Card, CardHeader, CardBody } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'

const PAGE_SIZE = 50
const ERROR_PREVIEW_LEN = 60

const inputCls =
  'w-full px-2.5 py-1.5 bg-background border border-border/60 rounded-md text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40'

const selectCls =
  'w-full px-2.5 py-1.5 bg-background border border-border/60 rounded-md text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40 cursor-pointer'

const fieldLabelCls = 'text-[10px] uppercase tracking-widest text-muted-foreground'

/** Normalise le champ error (string ou objet sérialisé côté backend) en chaîne pour affichage. */
function errorToString(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err, null, 2)
  } catch {
    return String(err)
  }
}

function statusTone(status: string | undefined | null): 'success' | 'destructive' | 'muted' {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'ok' || /^2\d{2}$/.test(s)) return 'success'
  if (/^[45]\d{2}$/.test(s) || s === 'error') return 'destructive'
  return 'muted'
}

export function LogsPage() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const { data: allLogs = [], error, isLoading, refetch, isFetching } = useLogs(selectedDate)
  const { data: dates = [] } = useDates()

  const logsErr = error instanceof Error ? error.message : String(error || '')

  const [page, setPage] = useState(0)
  const [filterText, setFilterText] = useState('')
  const [errorDetailModal, setErrorDetailModal] = useState<string | null>(null)

  const filtered = filterText
    ? allLogs.filter(e =>
        (e.user_id ?? '').toLowerCase().includes(filterText.toLowerCase()) ||
        e.model.toLowerCase().includes(filterText.toLowerCase()) ||
        e.backend.toLowerCase().includes(filterText.toLowerCase()) ||
        e.status.toLowerCase().includes(filterText.toLowerCase()) ||
        e.request_id.toLowerCase().includes(filterText.toLowerCase()) ||
        errorToString(e.error).toLowerCase().includes(filterText.toLowerCase())
      )
    : allLogs

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const paginated = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  return (
    <div className="flex flex-col gap-5">
      {/* ── Filtres ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Filtres"
          icon={<Filter size={13} />}
          subtitle="Choisissez une date (ou « Aujourd'hui » pour le temps réel), filtrez par utilisateur, modèle, backend, statut ou ID."
          right={
            filtered.length > 0 ? (
              <span className="text-[10px] text-muted-foreground/60 font-mono tabular-nums">
                {filtered.length}{filtered.length !== allLogs.length ? ` / ${allLogs.length}` : ''}
              </span>
            ) : undefined
          }
        />
        <CardBody className="!py-3">
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3">
            <div className="flex flex-col gap-1 min-w-[180px]">
              <label htmlFor="logs-date" className={fieldLabelCls}>Date</label>
              <select
                id="logs-date"
                value={selectedDate ?? ''}
                onChange={e => { setSelectedDate(e.target.value || null); setPage(0) }}
                className={selectCls}
              >
                <option value="">Aujourd'hui (temps réel)</option>
                {dates.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
              <label htmlFor="logs-filter" className={fieldLabelCls}>Filtrer</label>
              <input
                id="logs-filter"
                type="text"
                placeholder="Utilisateur, modèle, backend, statut, ID…"
                value={filterText}
                onChange={e => { setFilterText(e.target.value); setPage(0) }}
                className={inputCls}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw size={11} className={isFetching ? 'animate-spin' : ''} />
                Rafraîchir
              </Button>
            </div>
          </div>
          {error && (
            <p className="mt-3 text-[11px] text-destructive m-0">{logsErr}</p>
          )}
        </CardBody>
      </Card>

      {/* ── Chargement ──────────────────────────────────────────────── */}
      {isLoading && (
        <div className="flex justify-center py-10 text-muted-foreground">
          <Spinner size={20} />
        </div>
      )}

      {/* ── Vide ────────────────────────────────────────────────────── */}
      {!isLoading && filtered.length === 0 && !error && (
        <Card>
          <CardBody>
            <p className="text-muted-foreground/60 text-xs m-0">Aucune requête pour cette date.</p>
          </CardBody>
        </Card>
      )}

      {/* ── Tableau ─────────────────────────────────────────────────── */}
      {!isLoading && paginated.length > 0 && (
        <Card>
          <CardHeader
            title="Requêtes"
            icon={<ScrollText size={13} />}
            right={
              <span className="text-[10px] text-muted-foreground/60 font-mono tabular-nums">
                {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}
              </span>
            }
          />
          <CardBody className="!px-0 !py-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left border-collapse">
                <thead>
                  <tr className="bg-background/40">
                    <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground border-b border-border/60">Date / heure</th>
                    <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground border-b border-border/60">Utilisateur</th>
                    <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground border-b border-border/60 hidden md:table-cell">ID</th>
                    <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground border-b border-border/60">Modèle</th>
                    <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground border-b border-border/60">Backend</th>
                    <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground border-b border-border/60">Statut</th>
                    <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground border-b border-border/60">Durée</th>
                    <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground border-b border-border/60 hidden md:table-cell">Tokens</th>
                    <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground border-b border-border/60">Erreur</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((entry, i) => {
                    const errorStr = errorToString(entry.error)
                    const hasError = errorStr.length > 0
                    const errorPreview = errorStr.length > ERROR_PREVIEW_LEN
                      ? errorStr.slice(0, ERROR_PREVIEW_LEN) + '…'
                      : (errorStr || '—')
                    const tone = statusTone(entry.status)
                    return (
                      <tr
                        key={`${entry.request_id}-${i}`}
                        className="hover:bg-secondary/30 transition-colors"
                      >
                        <td className="px-3 py-2 border-b border-border/40 text-[11px] text-foreground/90 font-mono tabular-nums whitespace-nowrap">
                          {formatLogDateTime(entry.timestamp ?? entry.date ?? undefined)}
                        </td>
                        <td className="px-3 py-2 border-b border-border/40 text-[11px] text-foreground">
                          {entry.user_id ?? '—'}
                        </td>
                        <td className="px-3 py-2 border-b border-border/40 text-[10px] text-muted-foreground font-mono hidden md:table-cell">
                          {entry.request_id}
                        </td>
                        <td className="px-3 py-2 border-b border-border/40 text-[11px] text-foreground">
                          {entry.model}
                        </td>
                        <td className="px-3 py-2 border-b border-border/40 text-[11px] text-muted-foreground">
                          {entry.backend === '-' ? '—' : entry.backend}
                        </td>
                        <td className="px-3 py-2 border-b border-border/40">
                          <Badge tone={tone}>{formatLogStatus(entry.status)}</Badge>
                        </td>
                        <td className="px-3 py-2 border-b border-border/40 text-[11px] text-foreground/90 font-mono tabular-nums">
                          {entry.duration_ms != null ? formatDurationMs(entry.duration_ms) : '—'}
                        </td>
                        <td className="px-3 py-2 border-b border-border/40 text-[10px] text-muted-foreground font-mono tabular-nums hidden md:table-cell">
                          {formatUsageSummary(entry.usage, entry.duration_ms)}
                        </td>
                        <td className="px-3 py-2 border-b border-border/40 text-[11px] max-w-xs">
                          <span
                            className={`block truncate ${hasError ? 'text-destructive' : 'text-muted-foreground'}`}
                            title={hasError ? errorStr : undefined}
                          >
                            {errorPreview}
                          </span>
                          {hasError && (
                            <button
                              type="button"
                              className="mt-0.5 text-[10px] font-medium text-primary hover:brightness-125 transition"
                              onClick={() => setErrorDetailModal(errorStr)}
                            >
                              Détail
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-t border-border/60">
                <Button
                  variant="subtle"
                  size="sm"
                  disabled={safePage === 0}
                  onClick={() => setPage(p => p - 1)}
                >
                  ← Précédent
                </Button>
                <span className="text-[11px] text-muted-foreground font-mono tabular-nums">
                  Page {safePage + 1} / {totalPages}
                </span>
                <Button
                  variant="subtle"
                  size="sm"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage(p => p + 1)}
                >
                  Suivant →
                </Button>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* ── Popup détail erreur ─────────────────────────────────────── */}
      {errorDetailModal != null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          role="dialog"
          aria-modal="true"
          aria-labelledby="error-detail-title"
          onClick={() => setErrorDetailModal(null)}
        >
          <div
            className="bg-card border border-border/60 rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border/60">
              <h2
                id="error-detail-title"
                className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest m-0"
              >
                Détail de l'erreur
              </h2>
              <button
                type="button"
                className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
                onClick={() => setErrorDetailModal(null)}
                aria-label="Fermer"
              >
                <X size={13} />
              </button>
            </div>
            <pre className="flex-1 min-h-0 p-4 overflow-auto text-[11px] text-foreground whitespace-pre-wrap break-words font-mono bg-background m-0 rounded-b-xl">
              {errorDetailModal}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

export default LogsPage
