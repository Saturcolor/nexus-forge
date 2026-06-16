import React, { useCallback, useMemo, useRef, useState } from 'react'
import { ListChecks } from 'lucide-react'
import * as api from '../../../api/admin'
import type { BenchmarkPreset, BenchmarkRunResponse } from '../../../api/admin'
import { useSaveBenchmarkResultMutation } from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import { ProgressBar } from '../../ui/Progress'
import { Lbl, Val, inputSm, fmt, fmtMs } from './shared'

type SuiteRunResult = BenchmarkRunResponse & { preset_name?: string; error?: string }

export function SuiteCard({
  selectedModel, presets,
}: {
  selectedModel: string
  presets: BenchmarkPreset[]
}) {
  const saveMut = useSaveBenchmarkResultMutation()
  const [runAuto, setRunAuto] = useState(true)
  const [runTool, setRunTool] = useState(true)
  const [maxTokens, setMaxTokens] = useState(2048)
  const [running, setRunning] = useState(false)
  const [currentPreset, setCurrentPreset] = useState('')
  const [currentIdx, setCurrentIdx] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [results, setResults] = useState<SuiteRunResult[]>([])
  const [savedAll, setSavedAll] = useState(false)
  const [expandedRow, setExpandedRow] = useState<number | null>(null)
  const abortRef = useRef(false)

  const presetsToRun = useMemo(
    () => presets.filter(p =>
      (p.category === 'auto' && runAuto) || (p.category === 'tool' && runTool),
    ),
    [presets, runAuto, runTool],
  )

  const handleRun = useCallback(async () => {
    if (!selectedModel || presetsToRun.length === 0) return
    setRunning(true)
    setResults([])
    setSavedAll(false)
    setTotalCount(presetsToRun.length)
    abortRef.current = false

    for (let i = 0; i < presetsToRun.length; i++) {
      if (abortRef.current) break
      const preset = presetsToRun[i]
      setCurrentIdx(i + 1)
      setCurrentPreset(preset.name)

      try {
        const r = await api.runBenchmark({
          model_id: selectedModel,
          preset_id: preset.id,
          max_tokens: maxTokens,
          temperature: 0,
          cache_prompt: false,
        })
        setResults(prev => [...prev, { ...r, preset_name: preset.name }])
      } catch (e: any) {
        setResults(prev => [...prev, {
          preset_name: preset.name,
          preset_id: preset.id,
          preset_category: preset.category,
          error: e?.message || String(e),
          auto_score: 0,
          tool_score: 0,
          response_text: '',
          model_id: selectedModel,
          cache_prompt: false,
        } as SuiteRunResult])
      }
    }

    setRunning(false)
    setCurrentPreset('')
  }, [selectedModel, presetsToRun, maxTokens])

  const handleStop = () => { abortRef.current = true }

  const handleSaveAll = async () => {
    for (const r of results) {
      if (r.error && !r.pp_tok_s) continue
      await saveMut.mutateAsync({
        model_id: r.model_id || selectedModel,
        preset_id: r.preset_id,
        preset_category: r.preset_category || 'auto',
        prompt_tokens: r.prompt_tokens,
        generation_tokens: r.generation_tokens,
        pp_ms: r.pp_ms,
        pp_tok_s: r.pp_tok_s,
        gen_ms: r.gen_ms,
        gen_tok_s: r.gen_tok_s,
        wall_ms: r.wall_ms,
        response_preview: (r.response_text || '').slice(0, 500),
        auto_score: r.auto_score ?? null,
        tool_score: r.tool_score ?? null,
        validation_details: r.validation_details,
      } as any)
    }
    setSavedAll(true)
  }

  const autoResults = results.filter(r => r.preset_category === 'auto')
  const toolResults = results.filter(r => r.preset_category === 'tool')
  const autoPass = autoResults.filter(r => r.auto_score === 1).length
  const toolPass = toolResults.filter(r => r.tool_score === 1).length
  const done = !running && results.length > 0

  return (
    <Card>
      <CardHeader title="Suite automatique" icon={<ListChecks size={13} />} />
      <CardBody className="flex flex-col gap-4">

        {/* Controls */}
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-1.5 text-[11px] text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={runAuto}
              onChange={e => setRunAuto(e.target.checked)}
              disabled={running}
            />
            Auto (10 tests)
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={runTool}
              onChange={e => setRunTool(e.target.checked)}
              disabled={running}
            />
            Tool Calling (9 tests)
          </label>
          <div className="flex items-center gap-1.5">
            <Lbl>Max tokens</Lbl>
            <input
              type="number"
              className={inputSm + ' w-20'}
              value={maxTokens}
              onChange={e => setMaxTokens(parseInt(e.target.value) || 2048)}
              disabled={running}
            />
          </div>
          {!running ? (
            <Button
              variant="primary" size="md"
              disabled={!selectedModel || presetsToRun.length === 0}
              onClick={handleRun}
            >
              Lancer la suite ({presetsToRun.length} tests)
            </Button>
          ) : (
            <Button size="md" onClick={handleStop}>Arrêter</Button>
          )}
        </div>

        {/* Progress bar */}
        {running && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Spinner />
              <span className="font-medium text-foreground font-mono tabular-nums">
                {currentIdx}/{totalCount}
              </span>
              <span>{currentPreset}</span>
            </div>
            <ProgressBar value={(currentIdx / Math.max(totalCount, 1)) * 100} thickness="sm" />
          </div>
        )}

        {/* Live scores */}
        {results.length > 0 && (
          <div className="flex gap-6">
            {autoResults.length > 0 && (
              <div>
                <Lbl>Auto</Lbl>
                <div className="mt-0.5">
                  <Val tone="success">
                    {autoPass}/{autoResults.length}{running && !done ? '…' : ''}
                  </Val>
                </div>
              </div>
            )}
            {toolResults.length > 0 && (
              <div>
                <Lbl>Tool Calling</Lbl>
                <div className="mt-0.5">
                  <Val tone="primary">
                    {toolPass}/{toolResults.length}{running && !done ? '…' : ''}
                  </Val>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Results table */}
        {results.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="overflow-auto rounded-lg border border-border/40">
              <table className="w-full text-[11px]">
                <thead className="bg-background/50">
                  <tr className="text-muted-foreground text-left">
                    <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold">Preset</th>
                    <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold">Cat</th>
                    <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-center">Score</th>
                    <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-right">PP tok/s</th>
                    <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-right">Gen tok/s</th>
                    <th className="py-1.5 px-2 text-[10px] uppercase tracking-widest font-semibold text-right">Wall</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => {
                    const passed = (r.auto_score === 1 || r.tool_score === 1)
                    const failed = (r.auto_score === 0 || r.tool_score === 0)
                    const isExpanded = expandedRow === i
                    const hasDetail = r.response_text || r.validation_details || r.error
                    return (
                      <React.Fragment key={i}>
                        <tr
                          className={`border-t border-border/40 hover:bg-secondary/30 ${hasDetail ? 'cursor-pointer' : ''}`}
                          onClick={() => hasDetail && setExpandedRow(isExpanded ? null : i)}
                        >
                          <td className="py-1.5 px-2 text-foreground">{r.preset_name || r.preset_id}</td>
                          <td className="py-1.5 px-2 text-muted-foreground">{r.preset_category}</td>
                          <td className="py-1.5 px-2 text-center">
                            {passed && <span className="text-theme-green font-bold">PASS</span>}
                            {failed && !r.error && <span className="text-destructive font-bold">FAIL</span>}
                            {r.error && <span className="text-destructive">ERR</span>}
                            {hasDetail && <span className="text-muted-foreground/60 ml-1 text-[10px]">{isExpanded ? '▲' : '▼'}</span>}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono tabular-nums text-primary">{fmt(r.pp_tok_s)}</td>
                          <td className="py-1.5 px-2 text-right font-mono tabular-nums text-theme-green">{fmt(r.gen_tok_s)}</td>
                          <td className="py-1.5 px-2 text-right font-mono tabular-nums text-muted-foreground">{fmtMs(r.wall_ms)}</td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={6} className="px-3 py-2 bg-background">
                              {r.validation_details && (
                                <div className="text-[10px] text-muted-foreground mb-1.5 font-mono">{r.validation_details}</div>
                              )}
                              {r.error && (
                                <div className="text-[10px] text-destructive mb-1.5">{r.error}</div>
                              )}
                              {r.response_text ? (
                                <pre className="text-[11px] text-muted-foreground font-mono whitespace-pre-wrap max-h-[200px] overflow-auto">{r.response_text}</pre>
                              ) : (
                                <span className="text-[10px] text-muted-foreground/60 italic">
                                  Réponse vide (le modèle a utilisé tous ses tokens en raisonnement interne)
                                </span>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {done && (
              <div>
                <Button
                  variant="primary" size="sm"
                  onClick={handleSaveAll}
                  disabled={savedAll || saveMut.isPending}
                >
                  {savedAll ? 'Tout sauvegardé !' : 'Tout sauvegarder'}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
