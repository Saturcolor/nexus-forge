import React, { useState, useMemo, useRef, useCallback } from 'react'
import {
  useBenchmarkPresets, useBenchmarkResults, useBenchmarkModels,
  useRunBenchmarkMutation,
  useSaveBenchmarkResultMutation, useUpdateBenchmarkResultMutation,
  useDeleteBenchmarkResultMutation, useSetBenchmarkModelMutation,
  useLlamacppProbe, useConvTemplates, useSetConvTemplateMutation, useDeleteConvTemplateMutation,
} from '../api/queries'
import * as api from '../api/admin'
import type { BenchmarkRunResponse, BenchmarkResult, ManualRating, ModelMetadata, BenchmarkPreset } from '../api/admin'
import Spinner from './Spinner'
import { ToolCall15Panel, BugFind15Panel } from './ExtBenchPanel'
import LiveChatCard from './LiveChatCard'

// ── Shared styles ────────────────────────────────────────────────────────────

const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
export const btnBlue = `${btn} bg-blue-600 hover:bg-blue-500 text-white`
export const btnGray = `${btn} bg-neutral-700 hover:bg-neutral-600 text-neutral-200`
export const btnGreen = `${btn} bg-emerald-600 hover:bg-emerald-500 text-white`
export const inputSm = 'px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500'
export const selectSm = 'px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer'
export const card = 'bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-5'
export const sectionTitle = 'text-sm font-semibold text-white mb-3'

export function Lbl({ children }: { children: React.ReactNode }) {
  return <span className="text-neutral-500 uppercase tracking-wider font-medium text-[10px]">{children}</span>
}
export function Val({ children, color }: { children: React.ReactNode; color?: string }) {
  return <span className={`font-mono text-sm font-bold ${color ?? 'text-white'}`}>{children}</span>
}

export function fmt(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return n.toFixed(decimals)
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

const CATEGORY_LABELS: Record<string, string> = {
  pp: 'Prompt Processing',
  auto: 'Auto',
  tool: 'Tool Calling',
  manual: 'Manuel',
  custom: 'Custom',
}

const CATEGORY_ORDER = ['pp', 'auto', 'tool', 'manual']

// ── Model Config Card ────────────────────────────────────────────────────────

function ModelConfigCard({
  selectedModel, setSelectedModel, loadedModels, modelsMeta,
}: {
  selectedModel: string
  setSelectedModel: (m: string) => void
  loadedModels: Array<{ model_id: string; ready?: boolean }>
  modelsMeta: Record<string, ModelMetadata>
}) {
  const setModelMut = useSetBenchmarkModelMutation()
  const meta = modelsMeta[selectedModel]
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<ModelMetadata>({
    display_name: '', architecture: 'dense', params_b: 0, quant: '', active_params_b: null, notes: '',
  })

  const startEdit = () => {
    if (meta) {
      setForm({ ...meta })
    } else {
      setForm({ display_name: selectedModel, architecture: 'dense', params_b: 0, quant: '', active_params_b: null, notes: '' })
    }
    setEditing(true)
  }

  const save = () => {
    setModelMut.mutate({ modelId: selectedModel, data: form })
    setEditing(false)
  }

  return (
    <div className={card}>
      <h2 className={sectionTitle}>Modele</h2>
      <div className="flex items-center gap-3 flex-wrap">
        <select className={selectSm + ' min-w-[200px]'} value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
          <option value="">-- Selectionner --</option>
          {loadedModels.filter(i => i.ready).map(i => (
            <option key={i.model_id} value={i.model_id}>{i.model_id}</option>
          ))}
        </select>

        {selectedModel && meta && !editing && (
          <div className="flex items-center gap-3 text-xs text-neutral-300">
            <span className="font-medium">{meta.display_name}</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${meta.architecture === 'moe' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'}`}>
              {meta.architecture}
            </span>
            <span>{meta.params_b}B{meta.active_params_b ? ` (${meta.active_params_b}B actifs)` : ''}</span>
            <span className="font-mono text-neutral-400">{meta.quant}</span>
            <button className={btnGray} onClick={startEdit}>Modifier</button>
          </div>
        )}

        {selectedModel && !meta && !editing && (
          <button className={btnBlue} onClick={startEdit}>Configurer les metadonnees</button>
        )}
      </div>

      {editing && (
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <Lbl>Nom d'affichage</Lbl>
            <input className={inputSm + ' w-full mt-1'} value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} />
          </div>
          <div>
            <Lbl>Architecture</Lbl>
            <select className={selectSm + ' w-full mt-1'} value={form.architecture} onChange={e => setForm(f => ({ ...f, architecture: e.target.value as 'dense' | 'moe' }))}>
              <option value="dense">Dense</option>
              <option value="moe">MoE</option>
            </select>
          </div>
          <div>
            <Lbl>Params (B)</Lbl>
            <input type="number" step="0.1" className={inputSm + ' w-full mt-1'} value={form.params_b || ''} onChange={e => setForm(f => ({ ...f, params_b: parseFloat(e.target.value) || 0 }))} />
          </div>
          <div>
            <Lbl>Quantization</Lbl>
            <input className={inputSm + ' w-full mt-1'} value={form.quant} onChange={e => setForm(f => ({ ...f, quant: e.target.value }))} placeholder="Q5_K_M" />
          </div>
          {form.architecture === 'moe' && (
            <div>
              <Lbl>Params actifs (B)</Lbl>
              <input type="number" step="0.1" className={inputSm + ' w-full mt-1'} value={form.active_params_b ?? ''} onChange={e => setForm(f => ({ ...f, active_params_b: parseFloat(e.target.value) || null }))} />
            </div>
          )}
          <div className="col-span-full flex gap-2">
            <button className={btnGreen} onClick={save}>Enregistrer</button>
            <button className={btnGray} onClick={() => setEditing(false)}>Annuler</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Metrics Display ──────────────────────────────────────────────────────────

function MetricsRow({ run }: { run: BenchmarkRunResponse }) {
  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-3 text-center">
      <div><Lbl>PP tok/s</Lbl><br /><Val color="text-blue-400">{fmt(run.pp_tok_s)}</Val></div>
      <div><Lbl>Gen tok/s</Lbl><br /><Val color="text-emerald-400">{fmt(run.gen_tok_s)}</Val></div>
      <div><Lbl>PP time</Lbl><br /><Val>{fmtMs(run.pp_ms)}</Val></div>
      <div><Lbl>Gen time</Lbl><br /><Val>{fmtMs(run.gen_ms)}</Val></div>
      <div><Lbl>Wall time</Lbl><br /><Val>{fmtMs(run.wall_ms)}</Val></div>
      <div><Lbl>Tokens</Lbl><br /><Val>{run.prompt_tokens ?? '?'} / {run.generation_tokens ?? '?'}</Val></div>
    </div>
  )
}

// ── Rating Grid ──────────────────────────────────────────────────────────────

function RatingGrid({ rating, onChange }: { rating: ManualRating; onChange: (r: ManualRating) => void }) {
  const axes: Array<{ key: keyof ManualRating; label: string }> = [
    { key: 'pertinence', label: 'Pertinence' },
    { key: 'precision', label: 'Precision' },
    { key: 'clarte', label: 'Clarte' },
  ]
  return (
    <div className="flex gap-4 flex-wrap">
      {axes.map(({ key, label }) => (
        <div key={key}>
          <Lbl>{label}</Lbl>
          <div className="flex gap-1 mt-1">
            {[1, 2, 3, 4, 5].map(v => (
              <button
                key={v}
                className={`w-7 h-7 rounded text-xs font-bold transition-colors cursor-pointer ${rating[key] === v ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
                onClick={() => onChange({ ...rating, [key]: v })}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div>
        <Lbl>Moyenne</Lbl>
        <div className="mt-1">
          <Val color="text-yellow-400">{((rating.pertinence + rating.precision + rating.clarte) / 3).toFixed(1)}/5</Val>
        </div>
      </div>
    </div>
  )
}

// ── Single Run Card ──────────────────────────────────────────────────────────

function RunCard({
  selectedModel, presets,
}: {
  selectedModel: string
  presets: BenchmarkPreset[]
}) {
  const runMut = useRunBenchmarkMutation()
  const saveMut = useSaveBenchmarkResultMutation()

  const [presetId, setPresetId] = useState<string>('')
  const [customPrompt, setCustomPrompt] = useState('')
  const [maxTokens, setMaxTokens] = useState(512)
  const [temperature, setTemperature] = useState(0)
  const [cachePrompt, setCachePrompt] = useState(false)
  const [lastRun, setLastRun] = useState<BenchmarkRunResponse | null>(null)
  const [rating, setRating] = useState<ManualRating>({ pertinence: 3, precision: 3, clarte: 3 })
  const [saved, setSaved] = useState(false)

  const grouped = useMemo(() => {
    const g: Record<string, BenchmarkPreset[]> = {}
    for (const p of presets) {
      ;(g[p.category] ??= []).push(p)
    }
    return g
  }, [presets])

  const selectedPreset = presets.find(p => p.id === presetId)

  const handleRun = () => {
    if (!selectedModel) return
    setSaved(false)
    setLastRun(null)

    const params: Record<string, unknown> = {
      model_id: selectedModel,
      max_tokens: maxTokens,
      temperature,
      cache_prompt: cachePrompt,
    }

    if (presetId === '__custom') {
      params.messages = [{ role: 'user', content: customPrompt }]
    } else if (presetId) {
      params.preset_id = presetId
    } else {
      return
    }

    runMut.mutate(params as any, {
      onSuccess: (data) => setLastRun(data),
    })
  }

  const handleSave = () => {
    if (!lastRun) return
    const isManual = lastRun.preset_category === 'manual' || presetId === '__custom'
    saveMut.mutate({
      model_id: lastRun.model_id,
      preset_id: lastRun.preset_id || undefined,
      preset_category: lastRun.preset_category || (presetId === '__custom' ? 'custom' : 'unknown'),
      prompt_tokens: lastRun.prompt_tokens,
      generation_tokens: lastRun.generation_tokens,
      pp_ms: lastRun.pp_ms,
      pp_tok_s: lastRun.pp_tok_s,
      gen_ms: lastRun.gen_ms,
      gen_tok_s: lastRun.gen_tok_s,
      wall_ms: lastRun.wall_ms,
      response_preview: (lastRun.response_text || '').slice(0, 500),
      auto_score: lastRun.auto_score ?? null,
      tool_score: lastRun.tool_score ?? null,
      manual_rating: isManual ? rating : null,
      validation_details: lastRun.validation_details,
    } as any, { onSuccess: () => setSaved(true) })
  }

  return (
    <div className={card}>
      <h2 className={sectionTitle}>Run individuel</h2>

      <div className="flex items-end gap-3 flex-wrap mb-4">
        <div>
          <Lbl>Preset</Lbl>
          <select className={selectSm + ' min-w-[220px] mt-1 block'} value={presetId} onChange={e => { setPresetId(e.target.value); setLastRun(null); setSaved(false) }}>
            <option value="">-- Choisir --</option>
            {CATEGORY_ORDER.map(cat => grouped[cat] && (
              <optgroup key={cat} label={CATEGORY_LABELS[cat]}>
                {grouped[cat].map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.difficulty ? ` (${p.difficulty})` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
            <optgroup label="Custom">
              <option value="__custom">Prompt personnalise</option>
            </optgroup>
          </select>
        </div>

        <div>
          <Lbl>Max tokens</Lbl>
          <input type="number" className={inputSm + ' w-20 mt-1 block'} value={maxTokens} onChange={e => setMaxTokens(parseInt(e.target.value) || 512)} />
        </div>
        <div>
          <Lbl>Temperature</Lbl>
          <input type="number" step="0.1" min="0" max="2" className={inputSm + ' w-16 mt-1 block'} value={temperature} onChange={e => setTemperature(parseFloat(e.target.value) || 0)} />
        </div>
        <div className="flex items-center gap-1.5 pb-0.5">
          <input type="checkbox" id="bench-cache" checked={cachePrompt} onChange={e => setCachePrompt(e.target.checked)} className="cursor-pointer" />
          <label htmlFor="bench-cache" className="text-xs text-neutral-400 cursor-pointer">cache_prompt</label>
        </div>

        <button className={btnBlue} disabled={!selectedModel || !presetId || runMut.isPending} onClick={handleRun}>
          {runMut.isPending ? 'En cours...' : 'Run'}
        </button>
      </div>

      {presetId === '__custom' && (
        <textarea
          className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-xs text-white font-mono mb-4 focus:outline-none focus:ring-1 focus:ring-blue-500 min-h-[80px]"
          placeholder="Ton prompt ici..."
          value={customPrompt}
          onChange={e => setCustomPrompt(e.target.value)}
        />
      )}

      {selectedPreset && presetId !== '__custom' && (
        <p className="text-xs text-neutral-500 mb-4">{selectedPreset.description}</p>
      )}

      {runMut.isPending && (
        <div className="flex items-center gap-2 text-xs text-neutral-400 py-4">
          <Spinner /> Execution en cours (non-streaming, peut prendre du temps pour les gros contextes)...
        </div>
      )}

      {lastRun && !lastRun.error && (
        <div className="space-y-4">
          {/* Metrics */}
          <MetricsRow run={lastRun} />

          {/* Auto/Tool score */}
          {lastRun.auto_score != null && (
            <div className="flex items-center gap-2">
              <span className={`px-2 py-1 rounded text-xs font-bold ${lastRun.auto_score === 1 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                {lastRun.auto_score === 1 ? 'PASS' : 'FAIL'}
              </span>
              {lastRun.validation_details && <span className="text-xs text-neutral-500">{lastRun.validation_details}</span>}
            </div>
          )}
          {lastRun.tool_score != null && (
            <div className="flex items-center gap-2">
              <span className={`px-2 py-1 rounded text-xs font-bold ${lastRun.tool_score === 1 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                Tool: {lastRun.tool_score === 1 ? 'PASS' : 'FAIL'}
              </span>
              {lastRun.validation_details && <span className="text-xs text-neutral-500">{lastRun.validation_details}</span>}
            </div>
          )}

          {/* Response text */}
          {lastRun.response_text && (
            <div>
              <Lbl>Reponse</Lbl>
              <pre className="mt-1 bg-neutral-950 border border-neutral-800 rounded-lg p-3 text-xs text-neutral-300 font-mono whitespace-pre-wrap max-h-[300px] overflow-auto">
                {lastRun.response_text}
              </pre>
            </div>
          )}

          {/* Manual rating */}
          {(lastRun.preset_category === 'manual' || lastRun.preset_category === 'custom') && (
            <div>
              <Lbl>Notation</Lbl>
              <div className="mt-2">
                <RatingGrid rating={rating} onChange={setRating} />
              </div>
            </div>
          )}

          {/* Save button */}
          <div className="flex items-center gap-2">
            <button className={btnGreen} onClick={handleSave} disabled={saved || saveMut.isPending}>
              {saved ? 'Sauvegarde !' : saveMut.isPending ? 'Sauvegarde...' : 'Sauvegarder le resultat'}
            </button>
            {saved && <span className="text-xs text-emerald-400">Resultat ajoute au classement</span>}
          </div>
        </div>
      )}

      {lastRun?.error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-400">{lastRun.error}</div>
      )}
    </div>
  )
}

// ── Suite Card ────────────────────────────────────────────────────────────────

type SuiteRunResult = BenchmarkRunResponse & { preset_name?: string; error?: string }

function SuiteCard({ selectedModel, presets }: { selectedModel: string; presets: BenchmarkPreset[] }) {
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
  const abortRef = useRef(false)

  const presetsToRun = useMemo(() => {
    return presets.filter(p =>
      (p.category === 'auto' && runAuto) || (p.category === 'tool' && runTool)
    )
  }, [presets, runAuto, runTool])

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

  // Live scores
  const autoResults = results.filter(r => r.preset_category === 'auto')
  const toolResults = results.filter(r => r.preset_category === 'tool')
  const autoPass = autoResults.filter(r => r.auto_score === 1).length
  const toolPass = toolResults.filter(r => r.tool_score === 1).length
  const done = !running && results.length > 0
  const [expandedRow, setExpandedRow] = useState<number | null>(null)

  return (
    <div className={card}>
      <h2 className={sectionTitle}>Suite automatique</h2>

      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <label className="flex items-center gap-1.5 text-xs text-neutral-300 cursor-pointer">
          <input type="checkbox" checked={runAuto} onChange={e => setRunAuto(e.target.checked)} disabled={running} />
          Auto (10 tests)
        </label>
        <label className="flex items-center gap-1.5 text-xs text-neutral-300 cursor-pointer">
          <input type="checkbox" checked={runTool} onChange={e => setRunTool(e.target.checked)} disabled={running} />
          Tool Calling (9 tests)
        </label>
        <div className="flex items-center gap-1.5">
          <Lbl>Max tokens</Lbl>
          <input type="number" className={inputSm + ' w-20'} value={maxTokens} onChange={e => setMaxTokens(parseInt(e.target.value) || 2048)} disabled={running} />
        </div>
        {!running ? (
          <button className={btnBlue} disabled={!selectedModel || presetsToRun.length === 0} onClick={handleRun}>
            Lancer la suite ({presetsToRun.length} tests)
          </button>
        ) : (
          <button className={btnGray} onClick={handleStop}>Arreter</button>
        )}
      </div>

      {/* Progress bar */}
      {running && (
        <div className="mb-4">
          <div className="flex items-center gap-2 text-xs text-neutral-400 mb-1.5">
            <Spinner />
            <span className="font-medium text-white">{currentIdx}/{totalCount}</span>
            <span>{currentPreset}</span>
          </div>
          <div className="w-full bg-neutral-800 rounded-full h-1.5">
            <div
              className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${(currentIdx / totalCount) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Live scores */}
      {results.length > 0 && (
        <div className="flex gap-4 mb-3">
          {autoResults.length > 0 && (
            <div className="text-center">
              <Lbl>Auto</Lbl><br />
              <Val color="text-emerald-400">{autoPass}/{autoResults.length}{running && !done ? `...` : ''}</Val>
            </div>
          )}
          {toolResults.length > 0 && (
            <div className="text-center">
              <Lbl>Tool Calling</Lbl><br />
              <Val color="text-blue-400">{toolPass}/{toolResults.length}{running && !done ? `...` : ''}</Val>
            </div>
          )}
        </div>
      )}

      {/* Results table — fills in real-time */}
      {results.length > 0 && (
        <div className="space-y-3">
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-neutral-500 text-left">
                  <th className="py-1 px-2">Preset</th>
                  <th className="py-1 px-2">Cat</th>
                  <th className="py-1 px-2 text-center">Score</th>
                  <th className="py-1 px-2 text-right">PP tok/s</th>
                  <th className="py-1 px-2 text-right">Gen tok/s</th>
                  <th className="py-1 px-2 text-right">Wall</th>
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
                      <tr className={`border-t border-neutral-800 hover:bg-neutral-800/50 ${hasDetail ? 'cursor-pointer' : ''}`} onClick={() => hasDetail && setExpandedRow(isExpanded ? null : i)}>
                        <td className="py-1.5 px-2 text-neutral-300">{r.preset_name || r.preset_id}</td>
                        <td className="py-1.5 px-2 text-neutral-500">{r.preset_category}</td>
                        <td className="py-1.5 px-2 text-center">
                          {passed && <span className="text-emerald-400 font-bold">PASS</span>}
                          {failed && !r.error && <span className="text-red-400 font-bold">FAIL</span>}
                          {r.error && <span className="text-red-400">ERR</span>}
                          {hasDetail && <span className="text-neutral-600 ml-1 text-[10px]">{isExpanded ? '▲' : '▼'}</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-blue-400">{fmt(r.pp_tok_s)}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-emerald-400">{fmt(r.gen_tok_s)}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-neutral-400">{fmtMs(r.wall_ms)}</td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={6} className="px-3 py-2 bg-neutral-950">
                            {r.validation_details && (
                              <div className="text-[10px] text-neutral-500 mb-1.5 font-mono">{r.validation_details}</div>
                            )}
                            {r.error && (
                              <div className="text-[10px] text-red-400 mb-1.5">{r.error}</div>
                            )}
                            {r.response_text ? (
                              <pre className="text-[11px] text-neutral-400 font-mono whitespace-pre-wrap max-h-[200px] overflow-auto">{r.response_text}</pre>
                            ) : (
                              <span className="text-[10px] text-neutral-600 italic">Reponse vide (le modele a utilise tous ses tokens en raisonnement interne)</span>
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
            <div className="flex items-center gap-2">
              <button className={btnGreen} onClick={handleSaveAll} disabled={savedAll || saveMut.isPending}>
                {savedAll ? 'Tout sauvegarde !' : 'Tout sauvegarder'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Conversation Test Card ───────────────────────────────────────────────────

type ConvExchange = {
  question: string
  response: string
  rating: number
  pp_tok_s?: number
  gen_tok_s?: number
  wall_ms?: number
  prompt_tokens?: number
  generation_tokens?: number
}

function ConversationCard({ selectedModel }: { selectedModel: string }) {
  const saveMut = useSaveBenchmarkResultMutation()
  const { data: tplData } = useConvTemplates()
  const saveTplMut = useSetConvTemplateMutation()
  const deleteTplMut = useDeleteConvTemplateMutation()
  const templates = tplData?.templates ?? {}

  const [selectedTpl, setSelectedTpl] = useState('')
  const [tplName, setTplName] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [questions, setQuestions] = useState<string[]>([''])
  const [running, setRunning] = useState(false)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [exchanges, setExchanges] = useState<ConvExchange[]>([])
  const [savedAll, setSavedAll] = useState(false)
  const abortRef = useRef(false)

  const addQuestion = () => setQuestions(q => [...q, ''])
  const removeQuestion = (i: number) => setQuestions(q => q.filter((_, idx) => idx !== i))
  const updateQuestion = (i: number, val: string) => setQuestions(q => q.map((v, idx) => idx === i ? val : v))
  const updateRating = (i: number, val: number) => setExchanges(ex => ex.map((e, idx) => idx === i ? { ...e, rating: val } : e))

  const validQuestions = questions.filter(q => q.trim())

  const handleRun = useCallback(async () => {
    if (!selectedModel || validQuestions.length === 0) return
    setRunning(true)
    setExchanges([])
    setSavedAll(false)
    abortRef.current = false

    const conversationMessages: Array<{ role: string; content: string }> = []
    if (systemPrompt.trim()) {
      conversationMessages.push({ role: 'system', content: systemPrompt.trim() })
    }

    for (let i = 0; i < validQuestions.length; i++) {
      if (abortRef.current) break
      const question = validQuestions[i]
      setCurrentIdx(i + 1)

      conversationMessages.push({ role: 'user', content: question })

      try {
        const r = await api.runBenchmark({
          model_id: selectedModel,
          messages: [...conversationMessages],
          max_tokens: 2048,
          temperature: 0.7,
          cache_prompt: true,
          include_tools: true,
        } as any)

        const responseText = r.response_text || ''
        // For conversation context, use the plain text part (after tool calls)
        const plainText = responseText.replace(/🔧 .*\n?/g, '').trim()
        conversationMessages.push({ role: 'assistant', content: plainText || responseText })

        setExchanges(prev => [...prev, {
          question,
          response: responseText,
          rating: 5,
          pp_tok_s: r.pp_tok_s,
          gen_tok_s: r.gen_tok_s,
          wall_ms: r.wall_ms,
          prompt_tokens: r.prompt_tokens,
          generation_tokens: r.generation_tokens,
        }])
      } catch (e: any) {
        setExchanges(prev => [...prev, {
          question,
          response: `Erreur: ${e?.message || e}`,
          rating: 0,
        }])
        break
      }
    }

    setRunning(false)
  }, [selectedModel, systemPrompt, validQuestions])

  const handleSaveAll = async () => {
    const avgRating = exchanges.length > 0
      ? exchanges.reduce((sum, e) => sum + e.rating, 0) / exchanges.length
      : 0
    const ppVals = exchanges.filter(e => e.pp_tok_s)
    const genVals = exchanges.filter(e => e.gen_tok_s)
    const avgPp = ppVals.length ? ppVals.reduce((s, e) => s + (e.pp_tok_s || 0), 0) / ppVals.length : undefined
    const avgGen = genVals.length ? genVals.reduce((s, e) => s + (e.gen_tok_s || 0), 0) / genVals.length : undefined
    const totalWall = exchanges.reduce((s, e) => s + (e.wall_ms || 0), 0)

    await saveMut.mutateAsync({
      model_id: selectedModel,
      preset_id: selectedTpl || 'conversation_test',
      preset_category: 'conversation',
      pp_tok_s: avgPp != null ? Math.round(avgPp * 10) / 10 : undefined,
      gen_tok_s: avgGen != null ? Math.round(avgGen * 10) / 10 : undefined,
      wall_ms: Math.round(totalWall),
      prompt_tokens: exchanges.reduce((s, e) => s + (e.prompt_tokens || 0), 0),
      generation_tokens: exchanges.reduce((s, e) => s + (e.generation_tokens || 0), 0),
      response_preview: exchanges.map((e, i) => `Q${i + 1}: ${e.question.slice(0, 50)}... → ${e.rating}/10`).join(' | ').slice(0, 500),
      conv_rating: Math.round(avgRating * 10) / 10,
      notes: `Conversation ${exchanges.length} echanges. Ratings: ${exchanges.map(e => e.rating).join(', ')}`,
      exchanges: exchanges.map(e => ({
        question: e.question,
        response: e.response,
        rating: e.rating,
        pp_tok_s: e.pp_tok_s,
        gen_tok_s: e.gen_tok_s,
        wall_ms: e.wall_ms,
      })),
    } as any)
    setSavedAll(true)
  }

  const done = !running && exchanges.length > 0

  const loadTemplate = (id: string) => {
    const tpl = templates[id]
    if (!tpl) return
    setSelectedTpl(id)
    setTplName(tpl.name || id)
    setSystemPrompt(tpl.system_prompt || '')
    setQuestions(tpl.questions?.length ? [...tpl.questions] : [''])
    setExchanges([])
    setSavedAll(false)
  }

  const saveTemplate = () => {
    const id = tplName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || `tpl-${Date.now()}`
    saveTplMut.mutate({ id, data: { name: tplName.trim() || id, system_prompt: systemPrompt, questions: questions.filter(q => q.trim()) } })
    setSelectedTpl(id)
  }

  return (
    <div className={card}>
      <h2 className={sectionTitle}>Test Conversation</h2>

      {/* Template selector */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div>
          <Lbl>Template</Lbl>
          <select className={selectSm + ' min-w-[180px] mt-1 block'} value={selectedTpl} onChange={e => { if (e.target.value) loadTemplate(e.target.value); else { setSelectedTpl(''); setTplName('') } }}>
            <option value="">-- Nouveau --</option>
            {Object.entries(templates).map(([id, tpl]) => (
              <option key={id} value={id}>{tpl.name || id}</option>
            ))}
          </select>
        </div>
        <div>
          <Lbl>Nom</Lbl>
          <input className={inputSm + ' min-w-[150px] mt-1 block'} value={tplName} onChange={e => setTplName(e.target.value)} placeholder="Mon template..." />
        </div>
        <div className="flex gap-2 mt-4">
          <button className={btnBlue} onClick={saveTemplate} disabled={!tplName.trim() && !systemPrompt.trim()}>
            {selectedTpl ? 'Mettre a jour' : 'Sauvegarder template'}
          </button>
          {selectedTpl && (
            <button className={btnGray} onClick={() => { deleteTplMut.mutate(selectedTpl); setSelectedTpl(''); setTplName('') }}>
              Supprimer
            </button>
          )}
        </div>
      </div>

      {/* System prompt */}
      <div className="mb-4">
        <Lbl>System prompt (persona de l'agent)</Lbl>
        <textarea
          className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-xs text-white font-mono mt-1 focus:outline-none focus:ring-1 focus:ring-blue-500 min-h-[80px]"
          placeholder="Tu es un assistant technique expert en..."
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          disabled={running}
        />
      </div>

      {/* Questions list */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Lbl>Questions</Lbl>
          <button className={btnGray + ' !text-[10px] !px-2 !py-0.5'} onClick={addQuestion} disabled={running}>+ Ajouter</button>
        </div>
        <div className="space-y-2">
          {questions.map((q, i) => (
            <div key={i} className="flex gap-2 items-start">
              <span className="text-[10px] text-neutral-500 mt-2 w-5 shrink-0">{i + 1}.</span>
              <textarea
                className="flex-1 bg-neutral-950 border border-neutral-700 rounded-lg p-2 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 min-h-[36px] resize-y"
                value={q}
                onChange={e => updateQuestion(i, e.target.value)}
                placeholder="Ta question ici..."
                disabled={running}
                rows={1}
              />
              {questions.length > 1 && (
                <button className="text-red-400 hover:text-red-300 text-xs mt-1.5" onClick={() => removeQuestion(i)} disabled={running}>x</button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Run controls */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {!running ? (
          <button className={btnBlue} disabled={!selectedModel || validQuestions.length === 0} onClick={handleRun}>
            Lancer ({validQuestions.length} question{validQuestions.length > 1 ? 's' : ''})
          </button>
        ) : (
          <>
            <button className={btnGray} onClick={() => { abortRef.current = true }}>Arreter</button>
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <Spinner />
              <span className="font-medium text-white">{currentIdx}/{validQuestions.length}</span>
              <span>En cours...</span>
            </div>
          </>
        )}
      </div>

      {/* Exchanges — real-time display */}
      {exchanges.length > 0 && (
        <div className="space-y-4">
          {exchanges.map((ex, i) => (
            <div key={i} className="border border-neutral-800 rounded-lg overflow-hidden">
              {/* Question */}
              <div className="bg-neutral-800/50 px-4 py-2 text-xs">
                <span className="text-blue-400 font-bold mr-2">Q{i + 1}</span>
                <span className="text-neutral-300">{ex.question}</span>
              </div>

              {/* Response */}
              <div className="px-4 py-3">
                <pre className="text-xs text-neutral-300 font-mono whitespace-pre-wrap max-h-[200px] overflow-auto mb-3">
                  {ex.response}
                </pre>

                {/* Metrics + Rating row */}
                <div className="flex items-center gap-4 flex-wrap">
                  {ex.pp_tok_s != null && (
                    <span className="text-[10px] text-neutral-500">PP: <span className="text-blue-400 font-mono">{fmt(ex.pp_tok_s)}</span> tok/s</span>
                  )}
                  {ex.gen_tok_s != null && (
                    <span className="text-[10px] text-neutral-500">Gen: <span className="text-emerald-400 font-mono">{fmt(ex.gen_tok_s)}</span> tok/s</span>
                  )}
                  {ex.wall_ms != null && (
                    <span className="text-[10px] text-neutral-500">{fmtMs(ex.wall_ms)}</span>
                  )}

                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-[10px] text-neutral-500">Note:</span>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => (
                      <button
                        key={v}
                        className={`w-6 h-6 rounded text-[10px] font-bold transition-colors cursor-pointer ${ex.rating === v ? 'bg-yellow-500 text-black' : 'bg-neutral-800 text-neutral-500 hover:bg-neutral-700'}`}
                        onClick={() => updateRating(i, v)}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}

          {/* Average + Save */}
          {done && (
            <div className="flex items-center gap-4">
              <div>
                <Lbl>Note moyenne</Lbl>
                <Val color="text-yellow-400">{(exchanges.reduce((s, e) => s + e.rating, 0) / exchanges.length).toFixed(1)}/10</Val>
              </div>
              <button className={btnGreen} onClick={handleSaveAll} disabled={savedAll || saveMut.isPending}>
                {savedAll ? 'Sauvegarde !' : 'Sauvegarder au classement'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Rankings Card ────────────────────────────────────────────────────────────

type SortKey = 'model' | 'pp_tok_s' | 'gen_tok_s' | 'auto' | 'tool' | 'manual' | 'conv' | 'score' | 'date'

type ArchFilter = 'all' | 'dense' | 'moe'

function RankingsCard({ modelsMeta }: { modelsMeta: Record<string, ModelMetadata> }) {
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

  // Filter results by architecture
  const results = useMemo(() => {
    if (archFilter === 'all') return allResults
    return allResults.filter(r => {
      const meta = modelsMeta[r.model_id]
      return meta?.architecture === archFilter
    })
  }, [allResults, archFilter, modelsMeta])

  // Compute model aggregates
  const aggregates = useMemo(() => {
    const byModel: Record<string, {
      runs: number; pp_vals: number[]; gen_vals: number[]
      auto_results: Array<{score: number; weight: number}>
      tool_results: Array<{score: number; weight: number}>
      manual_avgs: number[]; conv_ratings: number[]; tc15_scores: number[]; bf15_scores: number[]
    }> = {}

    // Difficulty weights: simple=1, medium=2, complexe=3
    const DIFFICULTY_WEIGHTS: Record<string, number> = {
      math_arithmetic: 1, math_word_problem: 2,
      logic_deduction: 1, logic_sequence: 2,
      code_function: 1, code_debug: 2,
      extraction_facts: 1, extraction_structured: 2,
      instruction_format: 1, instruction_constraints: 3,
      tool_read_simple: 1, tool_bash_simple: 1, tool_list_dir: 1,
      tool_edit_medium: 2, tool_memory_medium: 2, tool_search_medium: 2,
      tool_multi_complex: 3, tool_edit_complex: 3, tool_no_narration: 3,
    }

    for (const r of results) {
      const m = r.model_id
      if (!byModel[m]) byModel[m] = { runs: 0, pp_vals: [], gen_vals: [], auto_results: [], tool_results: [], manual_avgs: [], conv_ratings: [], tc15_scores: [], bf15_scores: [] }
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
      runs: number; avg_pp: number | null; avg_gen: number | null; min_gen: number | null; max_gen: number | null
      auto_pct: string | null; auto_weighted: number | null; tool_pct: string | null; tool_weighted: number | null
      avg_manual: number | null; avg_conv: number | null; avg_tc15: number | null; avg_bf15: number | null; score: number | null
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

      // Weighted scoring: score * weight / total_weight
      const autoWeighted = agg.auto_results.length > 0
        ? agg.auto_results.reduce((s, r) => s + r.score * r.weight, 0) / agg.auto_results.reduce((s, r) => s + r.weight, 0)
        : null
      const toolWeighted = agg.tool_results.length > 0
        ? agg.tool_results.reduce((s, r) => s + r.score * r.weight, 0) / agg.tool_results.reduce((s, r) => s + r.weight, 0)
        : null

      // Simple counts for display
      const auto_pass = agg.auto_results.filter(r => r.score === 1).length
      const tool_pass = agg.tool_results.filter(r => r.score === 1).length

      // Perfect score bonus: +15% if all pass
      const autoPerfect = agg.auto_results.length > 0 && agg.auto_results.every(r => r.score === 1)
      const toolPerfect = agg.tool_results.length > 0 && agg.tool_results.every(r => r.score === 1)

      // Composite score — absolute thresholds instead of relative normalization
      // PP: 500 tok/s = 100% (fast enough), linear below
      // Gen: 30 tok/s = 100% (real-time), linear below
      const ppNorm = avg_pp != null ? Math.min(1, avg_pp / 500) : 0
      const genNorm = avg_gen != null ? Math.min(1, avg_gen / 30) : 0
      const autoNorm = autoWeighted ?? 0
      const toolNorm = toolWeighted ?? 0
      const manualNorm = avg_manual != null ? avg_manual / 5 : 0
      const convNorm = avg_conv != null ? avg_conv / 10 : 0
      const tc15Norm = avg_tc15 != null ? avg_tc15 / 100 : 0
      const bf15Norm = avg_bf15 != null ? avg_bf15 / 100 : 0

      // Apply perfect bonuses
      const autoFinal = Math.min(1, autoNorm + (autoPerfect ? 0.15 : 0))
      const toolFinal = Math.min(1, toolNorm + (toolPerfect ? 0.15 : 0))

      // Score composite: PP 7%, Gen 13%, Auto 15%, Tool 13%, TC15 13%, BF15 13%, Manual 13%, Conv 13%
      const hasAnyData = avg_pp != null || avg_gen != null || autoWeighted != null || toolWeighted != null || avg_manual != null || avg_conv != null || avg_tc15 != null || avg_bf15 != null
      const score = hasAnyData ? (0.07 * ppNorm + 0.13 * genNorm + 0.15 * autoFinal + 0.13 * toolFinal + 0.13 * tc15Norm + 0.13 * bf15Norm + 0.13 * manualNorm + 0.13 * convNorm) * 100 : null

      out[model] = {
        runs: agg.runs,
        avg_pp,
        avg_gen,
        min_gen,
        max_gen,
        auto_pct: agg.auto_results.length > 0 ? `${auto_pass}/${agg.auto_results.length}${autoPerfect ? ' ★' : ''}` : null,
        auto_weighted: autoWeighted != null ? Math.round(autoWeighted * 1000) / 10 : null,
        tool_pct: agg.tool_results.length > 0 ? `${tool_pass}/${agg.tool_results.length}${toolPerfect ? ' ★' : ''}` : null,
        tool_weighted: toolWeighted != null ? Math.round(toolWeighted * 1000) / 10 : null,
        avg_manual,
        avg_conv,
        avg_tc15,
        avg_bf15,
        score,
      }
    }
    return out
  }, [results])

  // Sort results
  const sortedResults = useMemo(() => {
    const filtered = selectedModelFilter ? results.filter(r => r.model_id === selectedModelFilter) : results
    const copy = [...filtered]
    const dir = sortAsc ? 1 : -1
    copy.sort((a, b) => {
      const manualAvg = (r: BenchmarkResult) => r.manual_rating ? (r.manual_rating.pertinence + r.manual_rating.precision + r.manual_rating.clarte) / 3 : 0
      switch (sortKey) {
        case 'model': return dir * (a.model_id.localeCompare(b.model_id))
        case 'pp_tok_s': return dir * ((a.pp_tok_s ?? 0) - (b.pp_tok_s ?? 0))
        case 'gen_tok_s': return dir * ((a.gen_tok_s ?? 0) - (b.gen_tok_s ?? 0))
        case 'auto': return dir * ((a.auto_score ?? -1) - (b.auto_score ?? -1))
        case 'tool': return dir * ((a.tool_score ?? -1) - (b.tool_score ?? -1))
        case 'manual': return dir * (manualAvg(a) - manualAvg(b))
        case 'conv': return dir * ((a.conv_rating ?? 0) - (b.conv_rating ?? 0))
        case 'date': return dir * ((a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
        default: return 0
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
      className={`py-1.5 px-2 cursor-pointer hover:text-white transition-colors ${align ?? 'text-left'} ${sortKey === k ? 'text-blue-400' : ''}`}
      onClick={() => handleSort(k)}
    >
      {children} {sortKey === k && (sortAsc ? '\u25B2' : '\u25BC')}
    </th>
  )

  return (
    <div className={card}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-white m-0">Classement</h2>
        <div className="flex gap-1">
          {(['all', 'dense', 'moe'] as ArchFilter[]).map(f => (
            <button
              key={f}
              className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer ${archFilter === f
                ? f === 'dense' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : f === 'moe' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                  : 'bg-neutral-700 text-white border border-neutral-600'
                : 'bg-neutral-800 text-neutral-500 border border-neutral-700 hover:text-neutral-300'}`}
              onClick={() => setArchFilter(f)}
            >
              {f === 'all' ? 'Tous' : f}
            </button>
          ))}
        </div>
      </div>

      {results.length === 0 ? (
        <p className="text-xs text-neutral-500">{archFilter !== 'all' ? `Aucun resultat ${archFilter} sauvegarde.` : 'Aucun resultat sauvegarde. Lance un benchmark et sauvegarde le resultat.'}</p>
      ) : (
        <>
          {/* Aggregates by model */}
          {Object.keys(aggregates).length > 0 && (
            <div className="mb-4">
              <Lbl>Agregats par modele</Lbl>
              <div className="mt-2 overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-neutral-500 text-left">
                      <th className="py-1 px-2">Modele</th>
                      <th className="py-1 px-2">Arch</th>
                      <th className="py-1 px-2 text-right">Runs</th>
                      <th className="py-1 px-2 text-right">PP moy</th>
                      <th className="py-1 px-2 text-right">Gen moy</th>
                      <th className="py-1 px-2 text-right">Gen range</th>
                      <th className="py-1 px-2 text-center">Auto</th>
                      <th className="py-1 px-2 text-center">Tool</th>
                      <th className="py-1 px-2 text-center">Manuel</th>
                      <th className="py-1 px-2 text-center">Conv</th>
                      <th className="py-1 px-2 text-center">TC15</th>
                      <th className="py-1 px-2 text-center">BF15</th>
                      <th className="py-1 px-2 text-right">Score</th>
                      <th className="py-1 px-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(aggregates)
                      .sort(([, a], [, b]) => (b.score ?? 0) - (a.score ?? 0))
                      .map(([model, agg]) => {
                        const meta = modelsMeta[model]
                        const isSelected = selectedModelFilter === model
                        return (
                          <tr key={model}
                            className={`border-t border-neutral-800 cursor-pointer transition-colors ${isSelected ? 'bg-blue-500/10 border-l-2 border-l-blue-500' : 'hover:bg-neutral-800/50'}`}
                            onClick={() => setSelectedModelFilter(isSelected ? null : model)}
                          >
                            <td className="py-1.5 px-2 text-white font-medium">
                              {meta?.display_name || model}
                              {isSelected && <span className="text-blue-400 text-[10px] ml-1">▼</span>}
                            </td>
                            <td className="py-1.5 px-2">
                              {meta && (
                                <span className={`px-1 py-0.5 rounded text-[9px] font-bold uppercase ${meta.architecture === 'moe' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                  {meta.architecture} {meta.params_b}B {meta.quant}
                                </span>
                              )}
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono text-neutral-400">{agg.runs}</td>
                            <td className="py-1.5 px-2 text-right font-mono text-blue-400">{fmt(agg.avg_pp)}</td>
                            <td className="py-1.5 px-2 text-right font-mono text-emerald-400">{fmt(agg.avg_gen)}</td>
                            <td className="py-1.5 px-2 text-right font-mono text-neutral-400">{agg.min_gen != null ? `${fmt(agg.min_gen)}-${fmt(agg.max_gen)}` : '—'}</td>
                            <td className="py-1.5 px-2 text-center font-mono">{agg.auto_pct ?? '—'}</td>
                            <td className="py-1.5 px-2 text-center font-mono">{agg.tool_pct ?? '—'}</td>
                            <td className="py-1.5 px-2 text-center font-mono text-yellow-400">{agg.avg_manual != null ? `${agg.avg_manual.toFixed(1)}/5` : '—'}</td>
                            <td className="py-1.5 px-2 text-center font-mono text-orange-400">{agg.avg_conv != null ? `${agg.avg_conv.toFixed(1)}/10` : '—'}</td>
                            <td className="py-1.5 px-2 text-center font-mono text-cyan-400">{agg.avg_tc15 != null ? `${agg.avg_tc15.toFixed(0)}%` : '—'}</td>
                            <td className="py-1.5 px-2 text-center font-mono text-pink-400">{agg.avg_bf15 != null ? `${agg.avg_bf15.toFixed(0)}%` : '—'}</td>
                            <td className="py-1.5 px-2 text-right font-mono font-bold text-white">{agg.score != null ? `${agg.score.toFixed(1)}` : '—'}</td>
                            <td className="py-1.5 px-2 text-right">
                              <button
                                className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300 text-[10px] font-medium transition-colors cursor-pointer"
                                title={`Supprimer tous les resultats de ${meta?.display_name || model}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (confirm(`Supprimer les ${agg.runs} resultats de ${meta?.display_name || model} ?`)) {
                                    results.filter(r => r.model_id === model).forEach(r => deleteMut.mutate(r.id))
                                    setSelectedModelFilter(null)
                                  }
                                }}
                              >✕</button>
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
            <Lbl>{selectedModelFilter ? `Resultats: ${modelsMeta[selectedModelFilter]?.display_name || selectedModelFilter}` : 'Tous les resultats'}</Lbl>
            {selectedModelFilter && (
              <button className="text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer" onClick={() => setSelectedModelFilter(null)}>
                (voir tout)
              </button>
            )}
          </div>
          <div className="mt-2 overflow-auto max-h-[400px]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-neutral-900">
                <tr className="text-neutral-500">
                  <SortTh k="model">Modele</SortTh>
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
                  const manualAvg = r.manual_rating ? ((r.manual_rating.pertinence + r.manual_rating.precision + r.manual_rating.clarte) / 3).toFixed(1) : null
                  const hasExchanges = r.exchanges && r.exchanges.length > 0
                  const isExpanded = expandedResult === r.id
                  return (
                    <React.Fragment key={r.id}>
                      <tr
                        className={`border-t border-neutral-800 ${hasExchanges ? 'cursor-pointer' : ''} ${isExpanded ? 'bg-neutral-800/50' : 'hover:bg-neutral-800/50'}`}
                        onClick={() => hasExchanges && setExpandedResult(isExpanded ? null : r.id)}
                      >
                        <td className="py-1.5 px-2 text-neutral-300 max-w-[140px] truncate">{r.model_id}</td>
                        <td className="py-1.5 px-2 text-neutral-500">
                          {r.preset_id || r.preset_category}
                          {hasExchanges && <span className="text-neutral-600 ml-1 text-[10px]">{isExpanded ? '▲' : '▼'}</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-blue-400">{fmt(r.pp_tok_s)}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-emerald-400">{fmt(r.gen_tok_s)}</td>
                        <td className="py-1.5 px-2 text-center">
                          {r.auto_score != null && (
                            <span className={r.auto_score === 1 ? 'text-emerald-400' : 'text-red-400'}>{r.auto_score === 1 ? 'P' : 'F'}</span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          {r.tool_score != null && (
                            <span className={r.tool_score === 1 ? 'text-emerald-400' : 'text-red-400'}>{r.tool_score === 1 ? 'P' : 'F'}</span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-center text-yellow-400">
                          {manualAvg ? `${manualAvg}/5` : ''}
                          {r.preset_category === 'manual' && !r.manual_rating && (
                            <button className="text-blue-400 hover:underline ml-1" onClick={(e) => { e.stopPropagation(); setEditingRating(r.id); setEditRating({ pertinence: 3, precision: 3, clarte: 3 }) }}>noter</button>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-center text-orange-400">
                          {r.conv_rating != null ? `${r.conv_rating}/10` : ''}
                        </td>
                        <td className="py-1.5 px-2 text-right text-neutral-500">{r.timestamp ? new Date(r.timestamp).toLocaleDateString('fr-FR') : ''}</td>
                        <td className="py-1.5 px-2 text-right">
                          <button className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300 text-[10px] font-medium transition-colors cursor-pointer" onClick={(e) => { e.stopPropagation(); deleteMut.mutate(r.id) }}>✕</button>
                        </td>
                      </tr>
                      {isExpanded && r.exchanges && (
                        <tr>
                          <td colSpan={10} className="p-0">
                            <div className="bg-neutral-950 border-l-2 border-l-orange-500/30 px-4 py-3 space-y-3">
                              {r.exchanges.map((ex, i) => (
                                <div key={i} className="border border-neutral-800 rounded-lg overflow-hidden">
                                  <div className="bg-neutral-800/50 px-3 py-1.5 text-xs flex items-center justify-between">
                                    <span><span className="text-blue-400 font-bold mr-2">Q{i + 1}</span><span className="text-neutral-300">{ex.question}</span></span>
                                    <span className={`font-bold text-sm ${ex.rating >= 8 ? 'text-emerald-400' : ex.rating >= 5 ? 'text-yellow-400' : 'text-red-400'}`}>{ex.rating}/10</span>
                                  </div>
                                  <pre className="px-3 py-2 text-[11px] text-neutral-400 font-mono whitespace-pre-wrap max-h-[150px] overflow-auto">{ex.response}</pre>
                                  {(ex.pp_tok_s || ex.gen_tok_s || ex.wall_ms) && (
                                    <div className="px-3 py-1 text-[10px] text-neutral-600 flex gap-3 border-t border-neutral-800">
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
            <div className="mt-3 p-3 bg-neutral-800 rounded-lg">
              <RatingGrid rating={editRating} onChange={setEditRating} />
              <div className="flex gap-2 mt-2">
                <button className={btnGreen} onClick={() => {
                  updateMut.mutate({ id: editingRating, updates: { manual_rating: editRating } })
                  setEditingRating(null)
                }}>Enregistrer</button>
                <button className={btnGray} onClick={() => setEditingRating(null)}>Annuler</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Main Panel ───────────────────────────────────────────────────────────────

export default function BenchmarkPanel() {
  const { data: probeData } = useLlamacppProbe(true)
  const { data: presetsData } = useBenchmarkPresets()
  const { data: modelsData } = useBenchmarkModels()
  const [selectedModel, setSelectedModel] = useState('')

  const loadedModels = probeData?.instances ?? []
  const presets = presetsData?.presets ?? []
  const modelsMeta = modelsData?.models ?? {}

  return (
    <div className="flex flex-col gap-5">
      <ModelConfigCard
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        loadedModels={loadedModels}
        modelsMeta={modelsMeta}
      />

      {selectedModel && (
        <>
          <RunCard selectedModel={selectedModel} presets={presets} />
          <SuiteCard selectedModel={selectedModel} presets={presets} />
          <ConversationCard selectedModel={selectedModel} />
          <LiveChatCard selectedModel={selectedModel} />
        </>
      )}

      <RankingsCard modelsMeta={modelsMeta} />

      {/* External benchmarks */}
      <ToolCall15Panel />
      <BugFind15Panel />
    </div>
  )
}
