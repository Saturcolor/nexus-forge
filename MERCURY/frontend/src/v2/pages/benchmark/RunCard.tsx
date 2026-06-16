import { useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import type { BenchmarkPreset, BenchmarkRunResponse, ManualRating } from '../../../api/admin'
import {
  useRunBenchmarkMutation, useSaveBenchmarkResultMutation,
} from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Button } from '../../ui/Button'
import { Badge } from '../../ui/Badge'
import { Spinner } from '../../ui/Spinner'
import {
  Lbl, inputSm, selectSm, textareaSm,
  CATEGORY_LABELS, CATEGORY_ORDER,
  MetricsRow, RatingGrid,
} from './shared'

export function RunCard({
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
    for (const p of presets) (g[p.category] ??= []).push(p)
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
    <Card>
      <CardHeader title="Run individuel" icon={<Play size={13} />} />
      <CardBody className="flex flex-col gap-4">

        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <Lbl>Preset</Lbl>
            <select
              className={selectSm + ' min-w-[240px] mt-1 block'}
              value={presetId}
              onChange={e => { setPresetId(e.target.value); setLastRun(null); setSaved(false) }}
            >
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
                <option value="__custom">Prompt personnalisé</option>
              </optgroup>
            </select>
          </div>

          <div>
            <Lbl>Max tokens</Lbl>
            <input
              type="number"
              className={inputSm + ' w-20 mt-1 block'}
              value={maxTokens}
              onChange={e => setMaxTokens(parseInt(e.target.value) || 512)}
            />
          </div>
          <div>
            <Lbl>Température</Lbl>
            <input
              type="number" step="0.1" min="0" max="2"
              className={inputSm + ' w-16 mt-1 block'}
              value={temperature}
              onChange={e => setTemperature(parseFloat(e.target.value) || 0)}
            />
          </div>
          <label className="flex items-center gap-1.5 pb-1 cursor-pointer">
            <input
              type="checkbox"
              checked={cachePrompt}
              onChange={e => setCachePrompt(e.target.checked)}
              className="cursor-pointer"
            />
            <span className="text-[11px] text-muted-foreground">cache_prompt</span>
          </label>

          <Button
            variant="primary"
            size="md"
            disabled={!selectedModel || !presetId || runMut.isPending}
            onClick={handleRun}
          >
            {runMut.isPending ? 'En cours…' : 'Lancer'}
          </Button>
        </div>

        {presetId === '__custom' && (
          <textarea
            className={textareaSm + ' min-h-[80px]'}
            placeholder="Ton prompt ici…"
            value={customPrompt}
            onChange={e => setCustomPrompt(e.target.value)}
          />
        )}

        {selectedPreset && presetId !== '__custom' && (
          <p className="text-[11px] text-muted-foreground/70 m-0">{selectedPreset.description}</p>
        )}

        {runMut.isPending && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Spinner /> Exécution en cours (non-streaming, peut prendre du temps pour les gros contextes)…
          </div>
        )}

        {lastRun && !lastRun.error && (
          <div className="flex flex-col gap-4">
            <MetricsRow run={lastRun} />

            {lastRun.auto_score != null && (
              <div className="flex items-center gap-2">
                <Badge tone={lastRun.auto_score === 1 ? 'success' : 'destructive'}>
                  {lastRun.auto_score === 1 ? 'PASS' : 'FAIL'}
                </Badge>
                {lastRun.validation_details && (
                  <span className="text-[11px] text-muted-foreground/70">{lastRun.validation_details}</span>
                )}
              </div>
            )}
            {lastRun.tool_score != null && (
              <div className="flex items-center gap-2">
                <Badge tone={lastRun.tool_score === 1 ? 'success' : 'destructive'}>
                  Tool: {lastRun.tool_score === 1 ? 'PASS' : 'FAIL'}
                </Badge>
                {lastRun.validation_details && (
                  <span className="text-[11px] text-muted-foreground/70">{lastRun.validation_details}</span>
                )}
              </div>
            )}

            {lastRun.response_text && (
              <div>
                <Lbl>Réponse</Lbl>
                <pre className="mt-1 bg-background border border-border/60 rounded-lg p-3 text-[11px] text-foreground font-mono whitespace-pre-wrap max-h-[300px] overflow-auto">
                  {lastRun.response_text}
                </pre>
              </div>
            )}

            {(lastRun.preset_category === 'manual' || lastRun.preset_category === 'custom') && (
              <div>
                <Lbl>Notation</Lbl>
                <div className="mt-2">
                  <RatingGrid rating={rating} onChange={setRating} />
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={saved || saveMut.isPending}
              >
                {saved ? 'Sauvegardé !' : saveMut.isPending ? 'Sauvegarde…' : 'Sauvegarder le résultat'}
              </Button>
              {saved && (
                <span className="text-[11px] text-theme-green">Résultat ajouté au classement</span>
              )}
            </div>
          </div>
        )}

        {lastRun?.error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 text-[11px] text-destructive">
            {lastRun.error}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
