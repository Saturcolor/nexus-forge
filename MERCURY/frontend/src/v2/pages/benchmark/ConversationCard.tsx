import { useCallback, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { MessagesSquare, Trash2 } from 'lucide-react'
import * as api from '../../../api/admin'
import {
  useConvTemplates, useSetConvTemplateMutation, useDeleteConvTemplateMutation,
  useSaveBenchmarkResultMutation,
} from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import { Lbl, Val, inputSm, selectSm, textareaSm, fmt, fmtMs } from './shared'

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

export function ConversationCard({ selectedModel }: { selectedModel: string }) {
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
  const updateQuestion = (i: number, val: string) =>
    setQuestions(q => q.map((v, idx) => (idx === i ? val : v)))
  const updateRating = (i: number, val: number) =>
    setExchanges(ex => ex.map((e, idx) => (idx === i ? { ...e, rating: val } : e)))

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
      response_preview: exchanges.map((e, i) =>
        `Q${i + 1}: ${e.question.slice(0, 50)}... → ${e.rating}/10`,
      ).join(' | ').slice(0, 500),
      conv_rating: Math.round(avgRating * 10) / 10,
      notes: `Conversation ${exchanges.length} échanges. Ratings: ${exchanges.map(e => e.rating).join(', ')}`,
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
    saveTplMut.mutate({
      id,
      data: {
        name: tplName.trim() || id,
        system_prompt: systemPrompt,
        questions: questions.filter(q => q.trim()),
      },
    })
    setSelectedTpl(id)
  }

  return (
    <Card>
      <CardHeader title="Test Conversation" icon={<MessagesSquare size={13} />} />
      <CardBody className="flex flex-col gap-4">

        {/* Template selector */}
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <Lbl>Template</Lbl>
            <select
              className={selectSm + ' min-w-[180px] mt-1 block'}
              value={selectedTpl}
              onChange={e => {
                if (e.target.value) loadTemplate(e.target.value)
                else { setSelectedTpl(''); setTplName('') }
              }}
            >
              <option value="">-- Nouveau --</option>
              {Object.entries(templates).map(([id, tpl]) => (
                <option key={id} value={id}>{tpl.name || id}</option>
              ))}
            </select>
          </div>
          <div>
            <Lbl>Nom</Lbl>
            <input
              className={inputSm + ' min-w-[160px] mt-1 block'}
              value={tplName}
              onChange={e => setTplName(e.target.value)}
              placeholder="Mon template…"
            />
          </div>
          <div className="flex gap-2 mt-4">
            <Button
              variant="primary" size="sm"
              onClick={saveTemplate}
              disabled={!tplName.trim() && !systemPrompt.trim()}
            >
              {selectedTpl ? 'Mettre à jour' : 'Sauvegarder template'}
            </Button>
            {selectedTpl && (
              <Button
                size="sm"
                onClick={() => { deleteTplMut.mutate(selectedTpl); setSelectedTpl(''); setTplName('') }}
              >
                Supprimer
              </Button>
            )}
          </div>
        </div>

        {/* System prompt */}
        <div>
          <Lbl>System prompt (persona de l'agent)</Lbl>
          <textarea
            className={textareaSm + ' min-h-[80px] mt-1'}
            placeholder="Tu es un assistant technique expert en…"
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            disabled={running}
          />
        </div>

        {/* Questions list */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Lbl>Questions</Lbl>
            <Button size="sm" onClick={addQuestion} disabled={running}>+ Ajouter</Button>
          </div>
          <div className="flex flex-col gap-2">
            {questions.map((q, i) => (
              <div key={i} className="flex gap-2 items-start">
                <span className="text-[10px] text-muted-foreground mt-2 w-5 shrink-0 font-mono tabular-nums">
                  {i + 1}.
                </span>
                <textarea
                  className={textareaSm + ' flex-1 min-h-[36px] resize-y'}
                  value={q}
                  onChange={e => updateQuestion(i, e.target.value)}
                  placeholder="Ta question ici…"
                  disabled={running}
                  rows={1}
                />
                {questions.length > 1 && (
                  <button
                    type="button"
                    className="text-destructive hover:text-destructive/80 text-xs mt-1.5"
                    onClick={() => removeQuestion(i)}
                    disabled={running}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Run controls */}
        <div className="flex flex-wrap items-center gap-3">
          {!running ? (
            <Button
              variant="primary" size="md"
              disabled={!selectedModel || validQuestions.length === 0}
              onClick={handleRun}
            >
              Lancer ({validQuestions.length} question{validQuestions.length > 1 ? 's' : ''})
            </Button>
          ) : (
            <>
              <Button size="md" onClick={() => { abortRef.current = true }}>Arrêter</Button>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Spinner />
                <span className="font-medium text-foreground font-mono tabular-nums">
                  {currentIdx}/{validQuestions.length}
                </span>
                <span>En cours…</span>
              </div>
            </>
          )}
        </div>

        {/* Exchanges */}
        {exchanges.length > 0 && (
          <div className="flex flex-col gap-3">
            {exchanges.map((ex, i) => (
              <div key={i} className="border border-border/40 rounded-lg overflow-hidden">
                <div className="bg-background px-3 py-2 text-[11px]">
                  <span className="text-primary font-bold mr-2 font-mono">Q{i + 1}</span>
                  <span className="text-foreground">{ex.question}</span>
                </div>
                <div className="px-3 py-2.5">
                  <pre className="text-[11px] text-foreground font-mono whitespace-pre-wrap max-h-[200px] overflow-auto mb-3">
                    {ex.response}
                  </pre>
                  <div className="flex items-center gap-4 flex-wrap">
                    {ex.pp_tok_s != null && (
                      <span className="text-[10px] text-muted-foreground">
                        PP: <span className="text-primary font-mono tabular-nums">{fmt(ex.pp_tok_s)}</span> tok/s
                      </span>
                    )}
                    {ex.gen_tok_s != null && (
                      <span className="text-[10px] text-muted-foreground">
                        Gen: <span className="text-theme-green font-mono tabular-nums">{fmt(ex.gen_tok_s)}</span> tok/s
                      </span>
                    )}
                    {ex.wall_ms != null && (
                      <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
                        {fmtMs(ex.wall_ms)}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                      <span className="text-[10px] text-muted-foreground mr-1">Note :</span>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => (
                        <button
                          key={v}
                          type="button"
                          className={clsx(
                            'w-6 h-6 rounded text-[10px] font-bold transition-colors',
                            ex.rating === v
                              ? 'bg-theme-amber text-background'
                              : 'bg-secondary text-muted-foreground hover:bg-secondary/70',
                          )}
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

            {done && (
              <div className="flex items-center gap-4">
                <div>
                  <Lbl>Note moyenne</Lbl>
                  <div className="mt-0.5">
                    <Val tone="warning">
                      {(exchanges.reduce((s, e) => s + e.rating, 0) / exchanges.length).toFixed(1)}/10
                    </Val>
                  </div>
                </div>
                <Button
                  variant="primary" size="sm"
                  onClick={handleSaveAll}
                  disabled={savedAll || saveMut.isPending}
                >
                  {savedAll ? 'Sauvegardé !' : 'Sauvegarder au classement'}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
