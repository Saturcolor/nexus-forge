import React, { useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { Trophy } from 'lucide-react'
import type { BenchmarkResult, ManualRating, ModelMetadata } from '../../../api/admin'
import {
  useBenchmarkResults,
  useDeleteBenchmarkResultMutation,
  useUpdateBenchmarkResultMutation,
} from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Button } from '../../ui/Button'
import { Badge } from '../../ui/Badge'
import { Lbl, fmt, fmtMs, RatingGrid, DIFFICULTY_WEIGHTS } from './shared'

type SortKey = 'model' | 'pp_tok_s' | 'gen_tok_s' | 'auto' | 'tool' | 'manual' | 'conv' | 'score' | 'date'
type ArchFilter = 'all' | 'dense' | 'moe'

export function RankingsCard({ modelsMeta }: { modelsMeta: Record<string, ModelMetadata> }) {
  const { data: resultsData } = useBenchmarkResults()
  const deleteMut = useDeleteBenchmarkResultMutation()
  const updateMut = useUpdateBenchmarkResultMutation()
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortAsc, setSortAsc] = useState(false)
  const [archFilter, setArchFilter] = useState<ArchFilter>('all')
  const [selectedModelFilter, setSelectedModelFilter] = useState<string | null>(null)
  const [expandedResult, setExpandedResult] = useState<string | null>(null)
  const [editingRating, setEditingRating] = useState<string | null>(null)
  const [editRating, setEditRating] = useState<ManualRating>({ pertinence: 3, precision: 3, clarte: 3 })

  const allResults = resultsData?.results ?? []

  const results = useMemo(() => {
    if (archFilter === 'all') return allResults
    return allResults.filter(r => {
      const meta = modelsMeta[r.model_id]
      return meta?.architecture === archFilter
    })
  }, [allResults, archFilter, modelsMeta])

  const aggregates = useMemo(() => {
    const byModel: Record<string, {
      runs: number
      pp_vals: number[]; gen_vals: number[]
      auto_results: Array<{ score: number; weight: number }>
      tool_results: Array<{ score: number; weight: number }>
      manual_avgs: number[]; conv_ratings: number[]; tc15_scores: number[]; bf15_scores: number[]
    }> = {}

    for (const r of results) {
      const m = r.model_id
      if (!byModel[m]) byModel[m] = {
        runs: 0, pp_vals: [], gen_vals: [],
        auto_results: [], tool_results: [],
        manual_avgs: [], conv_ratings: [], tc15_scores: [], bf15_scores: [],
      }
      const agg = byModel[m]
      agg.runs++
      if (r.pp_tok_s != null) agg.pp_vals.push(r.pp_tok_s)
      if (r.gen_tok_s != null) agg.gen_vals.push(r.gen_tok_s)
      if (r.auto_score != null) agg.auto_results.push({ score: r.auto_score, weight: DIFFICULTY_WEIGHTS[r.preset_id || ''] || 1 })
      if (r.tool_score != null) agg.tool_results.push({ score: r.tool_score, weight: DIFFICULTY_WEIGHTS[r.preset_id || ''] || 1 })
      if (r.manual_rating) {
        const mr = r.manual_rating
        agg.manual_avgs.push((mr.pertinence + mr.precision + mr.clarte) / 3)
      }
      if (r.conv_rating != null) agg.conv_ratings.push(r.conv_rating)
      if ((r as any).toolcall15_score != null) agg.tc15_scores.push((r as any).toolcall15_score)
      if ((r as any).bugfind15_score != null) agg.bf15_scores.push((r as any).bugfind15_score)
    }

    const out: Record<string, {
      runs: number
      avg_pp: number | null; avg_gen: number | null; min_gen: number | null; max_gen: number | null
      auto_pct: string | null; auto_weighted: number | null
      tool_pct: string | null; tool_weighted: number | null
      avg_manual: number | null; avg_conv: number | null
      avg_tc15: number | null; avg_bf15: number | null; score: number | null
    }> = {}

    for (const [model, agg] of Object.entries(byModel)) {
      const avg_pp = agg.pp_vals.length ? agg.pp_vals.reduce((a, b) => a + b, 0) / agg.pp_vals.length : null
      const avg_gen = agg.gen_vals.length ? agg.gen_vals.reduce((a, b) => a + b, 0) / agg.gen_vals.length : null
      const min_gen = agg.gen_vals.length ? Math.min(...agg.gen_vals) : null
      const max_gen = agg.gen_vals.length ? Math.max(...agg.gen_vals) : null
      const avg_manual = agg.manual_avgs.length ? agg.manual_avgs.reduce((a, b) => a + b, 0) / agg.manual_avgs.length : null
      const avg_conv = agg.conv_ratings.length ? agg.conv_ratings.reduce((a, b) => a + b, 0) / agg.conv_ratings.length : null
      const avg_tc15 = agg.tc15_scores.length ? agg.tc15_scores.reduce((a, b) => a + b, 0) / agg.tc15_scores.length : null
      const avg_bf15 = agg.bf15_scores.length ? agg.bf15_scores.reduce((a, b) => a + b, 0) / agg.bf15_scores.length : null

      const autoWeighted = agg.auto_results.length > 0
        ? agg.auto_results.reduce((s, r) => s + r.score * r.weight, 0) / agg.auto_results.reduce((s, r) => s + r.weight, 0)
        : null
      const toolWeighted = agg.tool_results.length > 0
        ? agg.tool_results.reduce((s, r) => s + r.score * r.weight, 0) / agg.tool_results.reduce((s, r) => s + r.weight, 0)
        : null

      const auto_pass = agg.auto_results.filter(r => r.score === 1).length
      const tool_pass = agg.tool_results.filter(r => r.score === 1).length

      const autoPerfect = agg.auto_results.length > 0 && agg.auto_results.every(r => r.score === 1)
      const toolPerfect = agg.tool_results.length > 0 && agg.tool_results.every(r => r.score === 1)

      const ppNorm = avg_pp != null ? Math.min(1, avg_pp / 500) : 0
      const genNorm = avg_gen != null ? Math.min(1, avg_gen / 30) : 0
      const autoNorm = autoWeighted ?? 0
      const toolNorm = toolWeighted ?? 0
      const manualNorm = avg_manual != null ? avg_manual / 5 : 0
      const convNorm = avg_conv != null ? avg_conv / 10 : 0
      const tc15Norm = avg_tc15 != null ? avg_tc15 / 100 : 0
      const bf15Norm = avg_bf15 != null ? avg_bf15 / 100 : 0

      const autoFinal = Math.min(1, autoNorm + (autoPerfect ? 0.15 : 0))
      const toolFinal = Math.min(1, toolNorm + (toolPerfect ? 0.15 : 0))

      const hasAnyData = avg_pp != null || avg_gen != null || autoWeighted != null || toolWeighted != null
        || avg_manual != null || avg_conv != null || avg_tc15 != null || avg_bf15 != null
      const score = hasAnyData
        ? (0.07 * ppNorm + 0.13 * genNorm + 0.15 * autoFinal + 0.13 * toolFinal
           + 0.13 * tc15Norm + 0.13 * bf15Norm + 0.13 * manualNorm + 0.13 * convNorm) * 100
        : null

      out[model] = {
        runs: agg.runs,
        avg_pp, avg_gen, min_gen, max_gen,
        auto_pct: agg.auto_results.length > 0 ? `${auto_pass}/${agg.auto_results.length}${autoPerfect ? ' ★' : ''}` : null,
        auto_weighted: autoWeighted != null ? Math.round(autoWeighted * 1000) / 10 : null,
        tool_pct: agg.tool_results.length > 0 ? `${tool_pass}/${agg.tool_results.length}${toolPerfect ? ' ★' : ''}` : null,
        tool_weighted: toolWeighted != null ? Math.round(toolWeighted * 1000) / 10 : null,
        avg_manual, avg_conv, avg_tc15, avg_bf15, score,
      }
    }
    return out
  }, [results])

  const sortedResults = useMemo(() => {
    const filtered = selectedModelFilter ? results.filter(r => r.model_id === selectedModelFilter) : results
    const copy = [...filtered]
    const dir = sortAsc ? 1 : -1
    copy.sort((a, b) => {
      const manualAvg = (r: BenchmarkResult) =>
        r.manual_rating ? (r.manual_rating.pertinence + r.manual_rating.precision + r.manual_rating.clarte) / 3 : 0
      switch (sortKey) {
        case 'model':     return dir * a.model_id.localeCompare(b.model_id)
        case 'pp_tok_s':  return dir * ((a.pp_tok_s ?? 0) - (b.pp_tok_s ?? 0))
        case 'gen_tok_s': return dir * ((a.gen_tok_s ?? 0) - (b.gen_tok_s ?? 0))
        case 'auto':      return dir * ((a.auto_score ?? -1) - (b.auto_score ?? -1))
        case 'tool':      return dir * ((a.tool_score ?? -1) - (b.tool_score ?? -1))
        case 'manual':    return dir * (manualAvg(a) - manualAvg(b))
        case 'conv':      return dir * ((a.conv_rating ?? 0) - (b.conv_rating ?? 0))
        case 'date':      return dir * ((a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
        default:          return 0
      }
    })
    return copy
  }, [results, sortKey, sortAsc, selectedModelFilter])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(false) }
  }

  const SortTh = ({ k, children, align }: { k: SortKey; children: React.ReactNode; align?: string }) => (
    <th
      className={clsx(
        'py-1.5 px-2 cursor-pointer hover:text-foreground transition-colors text-[10px] uppercase tracking-widest font-semibold',
        align ?? 'text-left',
        sortKey === k ? 'text-primary' : 'text-muted-foreground',
      )}
      onClick={() => handleSort(k)}
    >
      {children} {sortKey === k && (sortAsc ? '▲' : '▼')}
    </th>
  )

  return (
    <Card>
      <CardHeader
        title="Classement"
        icon={<Trophy size={13} />}
        right={
          <div className="flex gap-1">
            {(['all', 'dense', 'moe'] as ArchFilter[]).map(f => (
              <button
                key={f}
                type="button"
                className={clsx(
                  'px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-widest transition-colors border',
                  archFilter === f
                    ? f === 'dense'
                      ? 'bg-primary/10 text-primary border-primary/30'
                      : f === 'moe'
                        ? 'bg-theme-purple/10 text-theme-purple border-theme-purple/30'
                        : 'bg-secondary text-foreground border-border/60'
                    : 'bg-background text-muted-foreground border-border/40 hover:text-foreground',
                )}
                onClick={() => setArchFilter(f)}
              >
                {f === 'all' ? 'Tous' : f}
              </button>
            ))}
          </div>
        }
      />
      <CardBody className="flex flex-col gap-4">

        {results.length === 0 ? (
          <p className="text-[11px] text-muted-foreground m-0">
            {archFilter !== 'all'
              ? `Aucun résultat ${archFilter} sauvegardé.`
              : 'Aucun résultat sauvegardé. Lance un benchmark et sauvegarde le résultat.'}
          </p>
        ) : (
          <>
            {/* Aggregates by model */}
            {Object.keys(aggregates).length > 0 && (
              <div>
                <Lbl>Agrégats par modèle</Lbl>
                <div className="mt-2 overflow-auto rounded-lg border border-border/40">
                  <table className="w-full text-[11px]">
                    <thead className="bg-background/50">
                      <tr className="text-muted-foreground text-left">
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold">Modèle</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold">Arch</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-right">Runs</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-right">PP moy</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-right">Gen moy</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-right">Gen range</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-center">Auto</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-center">Tool</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-center">Manuel</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-center">Conv</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-center">TC15</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-center">BF15</th>
                        <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-right">Score</th>
                        <th className="py-1.5 px-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(aggregates)
                        .sort(([, a], [, b]) => (b.score ?? 0) - (a.score ?? 0))
                        .map(([model, agg]) => {
                          const meta = modelsMeta[model]
                          const isSelected = selectedModelFilter === model
                          return (
                            <tr
                              key={model}
                              className={clsx(
                                'border-t border-border/40 cursor-pointer transition-colors',
                                isSelected
                                  ? 'bg-primary/5 border-l-2 border-l-primary'
                                  : 'hover:bg-secondary/30',
                              )}
                              onClick={() => setSelectedModelFilter(isSelected ? null : model)}
                            >
                              <td className="py-1.5 px-2 text-foreground font-medium">
                                {meta?.display_name || model}
                                {isSelected && <span className="text-primary text-[10px] ml-1">▼</span>}
                              </td>
                              <td className="py-1.5 px-2">
                                {meta && (
                                  <Badge tone={meta.architecture === 'moe' ? 'purple' : 'primary'}>
                                    {meta.architecture} {meta.params_b}B {meta.quant}
                                  </Badge>
                                )}
                              </td>
                              <td className="py-1.5 px-2 text-right font-mono tabular-nums text-muted-foreground">{agg.runs}</td>
                              <td className="py-1.5 px-2 text-right font-mono tabular-nums text-primary">{fmt(agg.avg_pp)}</td>
                              <td className="py-1.5 px-2 text-right font-mono tabular-nums text-theme-green">{fmt(agg.avg_gen)}</td>
                              <td className="py-1.5 px-2 text-right font-mono tabular-nums text-muted-foreground">
                                {agg.min_gen != null ? `${fmt(agg.min_gen)}-${fmt(agg.max_gen)}` : '—'}
                              </td>
                              <td className="py-1.5 px-2 text-center font-mono tabular-nums">{agg.auto_pct ?? '—'}</td>
                              <td className="py-1.5 px-2 text-center font-mono tabular-nums">{agg.tool_pct ?? '—'}</td>
                              <td className="py-1.5 px-2 text-center font-mono tabular-nums text-theme-amber">
                                {agg.avg_manual != null ? `${agg.avg_manual.toFixed(1)}/5` : '—'}
                              </td>
                              <td className="py-1.5 px-2 text-center font-mono tabular-nums text-theme-amber">
                                {agg.avg_conv != null ? `${agg.avg_conv.toFixed(1)}/10` : '—'}
                              </td>
                              <td className="py-1.5 px-2 text-center font-mono tabular-nums text-primary">
                                {agg.avg_tc15 != null ? `${agg.avg_tc15.toFixed(0)}%` : '—'}
                              </td>
                              <td className="py-1.5 px-2 text-center font-mono tabular-nums text-theme-purple">
                                {agg.avg_bf15 != null ? `${agg.avg_bf15.toFixed(0)}%` : '—'}
                              </td>
                              <td className="py-1.5 px-2 text-right font-mono tabular-nums font-bold text-foreground">
                                {agg.score != null ? agg.score.toFixed(1) : '—'}
                              </td>
                              <td className="py-1.5 px-2 text-right">
                                <button
                                  type="button"
                                  className="px-1.5 py-0.5 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 text-[10px] font-medium transition-colors"
                                  title={`Supprimer tous les résultats de ${meta?.display_name || model}`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (confirm(`Supprimer les ${agg.runs} résultats de ${meta?.display_name || model} ?`)) {
                                      results.filter(r => r.model_id === model).forEach(r => deleteMut.mutate(r.id))
                                      setSelectedModelFilter(null)
                                    }
                                  }}
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Full results table */}
            <div className="flex items-center gap-2">
              <Lbl>
                {selectedModelFilter
                  ? `Résultats : ${modelsMeta[selectedModelFilter]?.display_name || selectedModelFilter}`
                  : 'Tous les résultats'}
              </Lbl>
              {selectedModelFilter && (
                <button
                  type="button"
                  className="text-[10px] text-primary hover:underline"
                  onClick={() => setSelectedModelFilter(null)}
                >
                  (voir tout)
                </button>
              )}
            </div>
            <div className="overflow-auto max-h-[400px] rounded-lg border border-border/40">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-card">
                  <tr>
                    <SortTh k="model">Modèle</SortTh>
                    <SortTh k="date">Preset</SortTh>
                    <SortTh k="pp_tok_s" align="text-right">PP tok/s</SortTh>
                    <SortTh k="gen_tok_s" align="text-right">Gen tok/s</SortTh>
                    <SortTh k="auto" align="text-center">Auto</SortTh>
                    <SortTh k="tool" align="text-center">Tool</SortTh>
                    <SortTh k="manual" align="text-center">Manuel</SortTh>
                    <SortTh k="conv" align="text-center">Conv</SortTh>
                    <SortTh k="date" align="text-right">Date</SortTh>
                    <th className="py-1.5 px-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedResults.map(r => {
                    const manualAvg = r.manual_rating
                      ? ((r.manual_rating.pertinence + r.manual_rating.precision + r.manual_rating.clarte) / 3).toFixed(1)
                      : null
                    const hasExchanges = r.exchanges && r.exchanges.length > 0
                    const isExpanded = expandedResult === r.id
                    return (
                      <React.Fragment key={r.id}>
                        <tr
                          className={clsx(
                            'border-t border-border/40',
                            hasExchanges && 'cursor-pointer',
                            isExpanded ? 'bg-secondary/30' : 'hover:bg-secondary/30',
                          )}
                          onClick={() => hasExchanges && setExpandedResult(isExpanded ? null : r.id)}
                        >
                          <td className="py-1.5 px-2 text-foreground max-w-[140px] truncate">{r.model_id}</td>
                          <td className="py-1.5 px-2 text-muted-foreground">
                            {r.preset_id || r.preset_category}
                            {hasExchanges && (
                              <span className="text-muted-foreground/60 ml-1 text-[10px]">{isExpanded ? '▲' : '▼'}</span>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono tabular-nums text-primary">{fmt(r.pp_tok_s)}</td>
                          <td className="py-1.5 px-2 text-right font-mono tabular-nums text-theme-green">{fmt(r.gen_tok_s)}</td>
                          <td className="py-1.5 px-2 text-center font-mono">
                            {r.auto_score != null && (
                              <span className={r.auto_score === 1 ? 'text-theme-green' : 'text-destructive'}>
                                {r.auto_score === 1 ? 'P' : 'F'}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-center font-mono">
                            {r.tool_score != null && (
                              <span className={r.tool_score === 1 ? 'text-theme-green' : 'text-destructive'}>
                                {r.tool_score === 1 ? 'P' : 'F'}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-center text-theme-amber font-mono tabular-nums">
                            {manualAvg ? `${manualAvg}/5` : ''}
                            {r.preset_category === 'manual' && !r.manual_rating && (
                              <button
                                type="button"
                                className="text-primary hover:underline ml-1"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setEditingRating(r.id)
                                  setEditRating({ pertinence: 3, precision: 3, clarte: 3 })
                                }}
                              >
                                noter
                              </button>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-center text-theme-amber font-mono tabular-nums">
                            {r.conv_rating != null ? `${r.conv_rating}/10` : ''}
                          </td>
                          <td className="py-1.5 px-2 text-right text-muted-foreground font-mono tabular-nums">
                            {r.timestamp ? new Date(r.timestamp).toLocaleDateString('fr-FR') : ''}
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            <button
                              type="button"
                              className="px-1.5 py-0.5 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 text-[10px] font-medium transition-colors"
                              onClick={(e) => { e.stopPropagation(); deleteMut.mutate(r.id) }}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                        {isExpanded && r.exchanges && (
                          <tr>
                            <td colSpan={10} className="p-0">
                              <div className="bg-background border-l-2 border-l-theme-amber/40 px-3 py-3 flex flex-col gap-3">
                                {r.exchanges.map((ex, i) => (
                                  <div key={i} className="border border-border/40 rounded-lg overflow-hidden">
                                    <div className="bg-card px-3 py-1.5 text-[11px] flex items-center justify-between">
                                      <span>
                                        <span className="text-primary font-bold mr-2 font-mono">Q{i + 1}</span>
                                        <span className="text-foreground">{ex.question}</span>
                                      </span>
                                      <span
                                        className={clsx(
                                          'font-bold text-sm font-mono tabular-nums',
                                          ex.rating >= 8
                                            ? 'text-theme-green'
                                            : ex.rating >= 5
                                              ? 'text-theme-amber'
                                              : 'text-destructive',
                                        )}
                                      >
                                        {ex.rating}/10
                                      </span>
                                    </div>
                                    <pre className="px-3 py-2 text-[11px] text-muted-foreground font-mono whitespace-pre-wrap max-h-[150px] overflow-auto">
                                      {ex.response}
                                    </pre>
                                    {(ex.pp_tok_s || ex.gen_tok_s || ex.wall_ms) && (
                                      <div className="px-3 py-1 text-[10px] text-muted-foreground/70 flex gap-3 border-t border-border/40 font-mono tabular-nums">
                                        {ex.pp_tok_s != null && <span>PP: {fmt(ex.pp_tok_s)} tok/s</span>}
                                        {ex.gen_tok_s != null && <span>Gen: {fmt(ex.gen_tok_s)} tok/s</span>}
                                        {ex.wall_ms != null && <span>{fmtMs(ex.wall_ms)}</span>}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Inline rating editor */}
            {editingRating && (
              <div className="p-3 bg-background border border-border/60 rounded-lg">
                <RatingGrid rating={editRating} onChange={setEditRating} />
                <div className="flex gap-2 mt-3">
                  <Button
                    variant="primary" size="sm"
                    onClick={() => {
                      updateMut.mutate({ id: editingRating, updates: { manual_rating: editRating } })
                      setEditingRating(null)
                    }}
                  >
                    Enregistrer
                  </Button>
                  <Button size="sm" onClick={() => setEditingRating(null)}>Annuler</Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
