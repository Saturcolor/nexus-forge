import React, { useState, useRef, useCallback, useEffect } from 'react'
import {
  useConvTemplates, useSetConvTemplateMutation, useSaveBenchmarkResultMutation,
} from '../api/queries'
import { getAdminToken } from '../api/admin'
import { parseErrorResponse } from '../api/errors'
import Spinner from './Spinner'
import {
  card, sectionTitle, btnBlue, btnGray, btnGreen,
  inputSm, selectSm, Lbl, Val, fmt, fmtMs,
} from './BenchmarkPanel'

// ── Types ────────────────────────────────────────────────────────────────────

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

type ChatToolCall = {
  id?: string
  index?: number
  type?: string
  function?: { name?: string; arguments?: string }
}

type LiveExchange = {
  question: string
  response: string
  thinking?: string
  tool_calls?: ChatToolCall[]
  rating: number
  pp_tok_s?: number
  gen_tok_s?: number
  wall_ms?: number
  prompt_tokens?: number
  generation_tokens?: number
  aborted?: boolean
}

type DeltaKind = 'content' | 'reasoning'

type SSECallbacks = {
  onDelta: (text: string, kind: DeltaKind) => void
  onToolCallDelta: (deltas: ChatToolCall[]) => void
  onUsage: (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => void
  onTimings: (timings: any) => void
}

// Splits raw streaming text on inline <think>...</think> tags.
// Handles unclosed trailing <think> (mid-stream).
function splitInlineThinking(raw: string): { thinking: string; response: string } {
  let thinking = ''
  let response = ''
  const re = /<think>([\s\S]*?)<\/think>/g
  let lastEnd = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    response += raw.slice(lastEnd, m.index)
    thinking += (thinking ? '\n' : '') + m[1]
    lastEnd = m.index + m[0].length
  }
  const tail = raw.slice(lastEnd)
  const openInTail = tail.lastIndexOf('<think>')
  if (openInTail !== -1) {
    response += tail.slice(0, openInTail)
    thinking += (thinking ? '\n' : '') + tail.slice(openInTail + '<think>'.length)
  } else {
    response += tail
  }
  return { thinking, response }
}

// ── SSE parser ───────────────────────────────────────────────────────────────

async function streamChatCompletion(
  body: any,
  signal: AbortSignal,
  cb: SSECallbacks,
): Promise<void> {
  const token = getAdminToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  // Hit admin endpoint that streams directly from llama.cpp (bypasses /v1 user auth)
  const res = await fetch('/admin/benchmark/chat-stream', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    throw await parseErrorResponse(res)
  }
  if (!res.body) throw new Error('No response body for stream')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Split SSE events by double-newline
    let sepIdx: number
    while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sepIdx)
      buffer = buffer.slice(sepIdx + 2)

      // Each event may have multiple `data: ...` lines
      const lines = rawEvent.split('\n').filter(l => l.startsWith('data:'))
      for (const line of lines) {
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') return
        try {
          const obj = JSON.parse(data)
          if (obj?.error) {
            throw new Error(obj.error?.message || JSON.stringify(obj.error))
          }
          const deltaObj = obj?.choices?.[0]?.delta
          const contentDelta = deltaObj?.content
          if (typeof contentDelta === 'string' && contentDelta.length > 0) {
            cb.onDelta(contentDelta, 'content')
          }
          // Some llama.cpp builds / models expose thinking via reasoning_content (DeepSeek style)
          const reasoningDelta = deltaObj?.reasoning_content ?? deltaObj?.thinking
          if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
            cb.onDelta(reasoningDelta, 'reasoning')
          }
          // Tool calls deltas (OpenAI streaming format) — chunked by index
          const tcDeltas = deltaObj?.tool_calls
          if (Array.isArray(tcDeltas) && tcDeltas.length > 0) {
            cb.onToolCallDelta(tcDeltas as ChatToolCall[])
          }
          if (obj?.usage) cb.onUsage(obj.usage)
          if (obj?.timings) cb.onTimings(obj.timings)
        } catch (e: any) {
          if (e?.message && !e.message.startsWith('Unexpected')) throw e
          // JSON parse failure on partial: ignore
        }
      }
    }
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function LiveChatCard({ selectedModel }: { selectedModel: string }) {
  const { data: tplData } = useConvTemplates()
  const saveMut = useSaveBenchmarkResultMutation()
  const saveTplMut = useSetConvTemplateMutation()
  const templates = tplData?.templates ?? {}

  const [selectedTpl, setSelectedTpl] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [exchanges, setExchanges] = useState<LiveExchange[]>([])
  const [currentInput, setCurrentInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [streamingToolCalls, setStreamingToolCalls] = useState<ChatToolCall[]>([])
  const [savedAll, setSavedAll] = useState(false)
  const [tplName, setTplName] = useState('')
  const [tplSaved, setTplSaved] = useState(false)
  const [foldedThinking, setFoldedThinking] = useState<Record<number, boolean>>({})
  // Tools input — JSON array of OpenAI-style tool definitions
  const [toolsJson, setToolsJson] = useState('')
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const [toolsError, setToolsError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [exchanges, streamingText, streamingThinking])

  const toggleFold = (i: number) => setFoldedThinking(prev => ({ ...prev, [i]: !prev[i] }))

  const loadTemplateSystemPrompt = (id: string) => {
    setSelectedTpl(id)
    if (!id) return
    const tpl = templates[id]
    if (tpl) {
      setSystemPrompt(tpl.system_prompt || '')
      // If the template has a tools array, pre-fill the textarea so the user can edit/use it.
      // We keep the tools panel collapsed by default — user expands it if curious.
      if (Array.isArray(tpl.tools) && tpl.tools.length > 0) {
        setToolsJson(JSON.stringify(tpl.tools, null, 2))
        setToolsError(null)
      } else {
        setToolsJson('')
        setToolsError(null)
      }
    }
  }

  const handleSend = useCallback(async () => {
    const text = currentInput.trim()
    if (!text || !selectedModel || streaming) return

    // Parse + validate tools JSON if present
    let parsedTools: any[] | undefined
    if (toolsJson.trim()) {
      try {
        const parsed = JSON.parse(toolsJson)
        if (!Array.isArray(parsed)) {
          setToolsError('tools doit etre un tableau JSON')
          return
        }
        parsedTools = parsed
        setToolsError(null)
      } catch (e: any) {
        setToolsError(`JSON invalide: ${e?.message || e}`)
        return
      }
    }

    setSavedAll(false)
    setTplSaved(false)
    setCurrentInput('')

    // Build conversation messages
    const convoMessages: ChatMessage[] = []
    if (systemPrompt.trim()) convoMessages.push({ role: 'system', content: systemPrompt.trim() })
    convoMessages.push(...messages)
    convoMessages.push({ role: 'user', content: text })

    // Push user message to UI
    setMessages(prev => [...prev, { role: 'user', content: text }])

    setStreaming(true)
    setStreamingText('')
    setStreamingThinking('')
    setStreamingToolCalls([])
    abortRef.current = new AbortController()

    // Two raw buffers: explicit reasoning_content (from delta.reasoning_content) and content stream.
    // Inline <think>...</think> inside content is split out at finalize time and during render.
    let rawContent = ''
    let rawReasoning = ''
    // Tool calls accumulated by index (OpenAI streams them piecewise: name first, then arguments chunked)
    const toolCallsAcc: ChatToolCall[] = []
    type UsageInfo = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    const captured: { usage: UsageInfo | null; timings: any } = { usage: null, timings: null }
    const t0 = performance.now()
    let aborted = false

    try {
      await streamChatCompletion(
        {
          // admin endpoint expects model_id (not model)
          model_id: selectedModel,
          messages: convoMessages,
          temperature: 0.7,
          max_tokens: 2048,
          ...(parsedTools && parsedTools.length > 0 ? { tools: parsedTools, tool_choice: 'auto' } : {}),
        },
        abortRef.current.signal,
        {
          onDelta: (d, kind) => {
            if (kind === 'reasoning') {
              rawReasoning += d
              setStreamingThinking(prev => prev + d)
            } else {
              rawContent += d
              // Live-split inline <think> for display
              const split = splitInlineThinking(rawContent)
              setStreamingText(split.response)
              // Merge inline thinking with explicit reasoning for display
              const merged = [rawReasoning, split.thinking].filter(Boolean).join('\n\n')
              setStreamingThinking(merged)
            }
          },
          onToolCallDelta: (deltas) => {
            // OpenAI streams tool_calls piecewise. Each delta has an `index` field; for each
            // index, name/id usually arrive on the first chunk and arguments are chunked.
            for (const d of deltas) {
              const idx = typeof d.index === 'number' ? d.index : 0
              const cur = toolCallsAcc[idx] || { index: idx, type: 'function', function: { name: '', arguments: '' } }
              if (d.id) cur.id = d.id
              if (d.type) cur.type = d.type
              if (d.function) {
                cur.function = cur.function || { name: '', arguments: '' }
                if (d.function.name) cur.function.name = (cur.function.name || '') + d.function.name
                if (d.function.arguments) cur.function.arguments = (cur.function.arguments || '') + d.function.arguments
              }
              toolCallsAcc[idx] = cur
            }
            // Snapshot for live display
            setStreamingToolCalls([...toolCallsAcc])
          },
          onUsage: (u) => { captured.usage = u },
          onTimings: (t) => { captured.timings = t },
        },
      )
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        aborted = true
      } else {
        const errMsg = `Erreur: ${e?.message || e}`
        rawContent = rawContent || errMsg
        setStreamingText(errMsg)
      }
    }

    const wall_ms = Math.round(performance.now() - t0)

    const usage = captured.usage
    const timings = captured.timings
    // llama.cpp may include `timings.predicted_per_second` and `prompt_per_second`
    let pp_tok_s: number | undefined
    let gen_tok_s: number | undefined
    if (timings) {
      pp_tok_s = timings.prompt_per_second ?? timings.pp_per_second
      gen_tok_s = timings.predicted_per_second ?? timings.gen_per_second
    }
    // Fallback: derive gen_tok_s from usage + wall (approx, includes prompt processing time)
    if (gen_tok_s == null && usage?.completion_tokens && wall_ms > 0) {
      gen_tok_s = (usage.completion_tokens / wall_ms) * 1000
    }

    // Final split: separate inline <think>...</think> from the response text
    const split = splitInlineThinking(rawContent)
    const finalThinking = [rawReasoning, split.thinking].filter(s => s && s.trim()).join('\n\n').trim()
    const finalResponse = (split.response || rawContent || (aborted ? '[interrompu]' : '')).trim()

    const finalToolCalls = toolCallsAcc.filter(Boolean)
    const newExchange: LiveExchange = {
      question: text,
      response: finalResponse,
      thinking: finalThinking || undefined,
      tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
      rating: 5,
      pp_tok_s,
      gen_tok_s,
      wall_ms,
      prompt_tokens: usage?.prompt_tokens,
      generation_tokens: usage?.completion_tokens,
      aborted,
    }

    setExchanges(prev => [...prev, newExchange])
    // Conversation history uses only the final response (no thinking, no tool_calls reinjected
    // — we don't have a runtime to provide tool results). Live Chat is a benchmarking tool, not
    // an agent runtime. If the model wants to call tools, it shows in the bubble; conversation
    // continues with the user's next message.
    setMessages(prev => [...prev, { role: 'assistant', content: finalResponse }])
    setStreamingText('')
    setStreamingThinking('')
    setStreamingToolCalls([])
    setStreaming(false)
    abortRef.current = null
  }, [currentInput, selectedModel, streaming, systemPrompt, messages, toolsJson])

  const handleStop = () => {
    if (abortRef.current) abortRef.current.abort()
  }

  const updateRating = (i: number, val: number) => {
    setExchanges(ex => ex.map((e, idx) => idx === i ? { ...e, rating: val } : e))
    setSavedAll(false)
  }

  const handleReset = () => {
    if (exchanges.length > 0 && !savedAll) {
      if (!confirm('Session non sauvegardee. Reset quand meme ?')) return
    }
    if (abortRef.current) abortRef.current.abort()
    setMessages([])
    setExchanges([])
    setStreamingText('')
    setStreamingThinking('')
    setStreamingToolCalls([])
    setFoldedThinking({})
    setSavedAll(false)
    setTplSaved(false)
  }

  const handleSaveAll = async () => {
    if (exchanges.length === 0) return
    const avgRating = exchanges.reduce((s, e) => s + e.rating, 0) / exchanges.length
    const ppVals = exchanges.filter(e => e.pp_tok_s != null) as Array<LiveExchange & { pp_tok_s: number }>
    const genVals = exchanges.filter(e => e.gen_tok_s != null) as Array<LiveExchange & { gen_tok_s: number }>
    const avgPp = ppVals.length ? ppVals.reduce((s, e) => s + e.pp_tok_s, 0) / ppVals.length : undefined
    const avgGen = genVals.length ? genVals.reduce((s, e) => s + e.gen_tok_s, 0) / genVals.length : undefined
    const totalWall = exchanges.reduce((s, e) => s + (e.wall_ms || 0), 0)

    await saveMut.mutateAsync({
      model_id: selectedModel,
      preset_id: 'live_chat',
      preset_category: 'conversation',
      pp_tok_s: avgPp != null ? Math.round(avgPp * 10) / 10 : undefined,
      gen_tok_s: avgGen != null ? Math.round(avgGen * 10) / 10 : undefined,
      wall_ms: Math.round(totalWall),
      prompt_tokens: exchanges.reduce((s, e) => s + (e.prompt_tokens || 0), 0),
      generation_tokens: exchanges.reduce((s, e) => s + (e.generation_tokens || 0), 0),
      response_preview: exchanges.map((e, i) => `Q${i + 1}: ${e.question.slice(0, 50)}... -> ${e.rating}/10`).join(' | ').slice(0, 500),
      conv_rating: Math.round(avgRating * 10) / 10,
      notes: `Chat live ${exchanges.length} echanges. Ratings: ${exchanges.map(e => e.rating).join(', ')}`,
      exchanges: exchanges.map(e => ({
        question: e.question,
        response: e.response,
        thinking: e.thinking,
        tool_calls: e.tool_calls,
        rating: e.rating,
        pp_tok_s: e.pp_tok_s,
        gen_tok_s: e.gen_tok_s,
        wall_ms: e.wall_ms,
      })),
    } as any)
    setSavedAll(true)
  }

  const handleSaveAsTemplate = () => {
    if (exchanges.length === 0) return
    const name = tplName.trim() || `Live ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `tpl-${Date.now()}`
    // Parse tools JSON if present and valid — saved as array. Skipped if invalid or empty.
    let parsedTools: unknown[] | undefined
    if (toolsJson.trim()) {
      try {
        const parsed = JSON.parse(toolsJson)
        if (Array.isArray(parsed)) parsedTools = parsed
      } catch { /* ignore; just won't include tools in the saved template */ }
    }
    saveTplMut.mutate({
      id,
      data: {
        name,
        system_prompt: systemPrompt,
        questions: exchanges.map(e => e.question),
        ...(parsedTools && parsedTools.length > 0 ? { tools: parsedTools } : {}),
      },
    })
    setTplSaved(true)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  const avgRating = exchanges.length > 0
    ? exchanges.reduce((s, e) => s + e.rating, 0) / exchanges.length
    : 0

  return (
    <div className={card}>
      <div className="flex items-center justify-between mb-3">
        <h2 className={sectionTitle + ' !mb-0'}>Chat Live</h2>
        <div className="flex items-center gap-2">
          {exchanges.length > 0 && (
            <button className={btnGray + ' !text-[10px] !px-2 !py-1'} onClick={handleReset} disabled={streaming}>
              Reset session
            </button>
          )}
        </div>
      </div>

      {/* Template + system prompt */}
      <div className="flex items-end gap-3 mb-3 flex-wrap">
        <div>
          <Lbl>Template (system prompt)</Lbl>
          <select
            className={selectSm + ' min-w-[180px] mt-1 block'}
            value={selectedTpl}
            onChange={e => loadTemplateSystemPrompt(e.target.value)}
            disabled={streaming}
          >
            <option value="">-- Custom --</option>
            {Object.entries(templates).map(([id, tpl]) => (
              <option key={id} value={id}>{tpl.name || id}</option>
            ))}
          </select>
        </div>
        <span className="text-[10px] text-neutral-500 mb-1.5">
          Charge uniquement le system prompt, ignore les questions
        </span>
      </div>

      <div className="mb-4">
        <Lbl>System prompt</Lbl>
        <textarea
          className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-xs text-white font-mono mt-1 focus:outline-none focus:ring-1 focus:ring-blue-500 min-h-[60px]"
          placeholder="Tu es un assistant..."
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          disabled={streaming || messages.length > 0}
        />
        {messages.length > 0 && (
          <span className="text-[10px] text-neutral-500">System prompt verrouille pour cette session (Reset pour le modifier)</span>
        )}
      </div>

      {/* Tools (OpenAI-style array) — optional, for testing tool-calling capacity */}
      <div className="mb-4">
        <button
          type="button"
          onClick={() => setToolsExpanded(v => !v)}
          className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300 cursor-pointer"
        >
          <span>{toolsExpanded ? '▼' : '▶'}</span>
          <span>Tools</span>
          {(() => {
            // Live count without throwing on invalid JSON
            const txt = toolsJson.trim()
            if (!txt) return <span className="text-neutral-600 normal-case tracking-normal">(aucun)</span>
            try {
              const parsed = JSON.parse(txt)
              if (Array.isArray(parsed)) {
                return <span className="text-emerald-400 normal-case tracking-normal">({parsed.length} fns)</span>
              }
              return <span className="text-amber-400 normal-case tracking-normal">(pas un tableau)</span>
            } catch {
              return <span className="text-amber-400 normal-case tracking-normal">(JSON invalide)</span>
            }
          })()}
        </button>
        {toolsExpanded && (
          <div className="mt-2">
            <textarea
              className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-[11px] text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 min-h-[120px] resize-y"
              placeholder={`[
  {
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather for a city",
      "parameters": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  }
]`}
              value={toolsJson}
              onChange={e => { setToolsJson(e.target.value); setToolsError(null) }}
              disabled={streaming}
              spellCheck={false}
            />
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[10px] text-neutral-500">
                Format OpenAI tools array. Envoye au modele en plus du body. Les tool_calls generes s'affichent dans le chat (pas d'execution — c'est un test de capacite).
              </span>
            </div>
            {toolsError && (
              <div className="text-[11px] text-red-400 mt-1">{toolsError}</div>
            )}
          </div>
        )}
      </div>

      {/* Chat history */}
      <div
        ref={scrollRef}
        className="bg-neutral-950 border border-neutral-800 rounded-lg p-3 mb-3 max-h-[500px] min-h-[200px] overflow-y-auto space-y-3"
      >
        {messages.length === 0 && !streaming && (
          <div className="text-center text-neutral-600 text-xs py-8">
            Envoie un message pour demarrer la conversation.
          </div>
        )}

        {exchanges.map((ex, i) => (
          <div key={i} className="space-y-2">
            {/* User bubble */}
            <div className="flex justify-end">
              <div className="bg-blue-600/20 border border-blue-600/40 rounded-lg px-3 py-2 max-w-[85%] text-xs text-white whitespace-pre-wrap">
                {ex.question}
              </div>
            </div>
            {/* Thinking block (foldable) */}
            {ex.thinking && (
              <div className="flex justify-start">
                <div className="border-l-2 border-purple-700/60 bg-purple-950/20 rounded-r px-3 py-2 max-w-[85%] w-full">
                  <button
                    className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-purple-400 hover:text-purple-300 mb-1 cursor-pointer"
                    onClick={() => toggleFold(i)}
                  >
                    <span>{foldedThinking[i] ? '▶' : '▼'}</span>
                    <span>Thinking</span>
                    <span className="text-neutral-600 normal-case tracking-normal">({ex.thinking.length} chars)</span>
                  </button>
                  {!foldedThinking[i] && (
                    <pre className="text-[11px] text-purple-200/70 font-mono whitespace-pre-wrap italic max-h-[300px] overflow-y-auto">
                      {ex.thinking}
                    </pre>
                  )}
                </div>
              </div>
            )}
            {/* Assistant bubble — text response (may be empty if model only emitted tool_calls) */}
            {(ex.response || ex.aborted) && (
              <div className="flex justify-start">
                <div className="bg-neutral-800/60 border border-neutral-700 rounded-lg px-3 py-2 max-w-[85%] text-xs text-neutral-100 font-mono whitespace-pre-wrap">
                  {ex.response}
                  {ex.aborted && <span className="text-amber-400 text-[10px] ml-2">[interrompu]</span>}
                </div>
              </div>
            )}
            {/* Tool calls bubble(s) — display only, no execution */}
            {ex.tool_calls && ex.tool_calls.length > 0 && (
              <div className="flex justify-start">
                <div className="border-l-2 border-amber-600/60 bg-amber-950/20 rounded-r px-3 py-2 max-w-[85%] w-full space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-amber-400 flex items-center gap-1">
                    <span>Tool call{ex.tool_calls.length > 1 ? 's' : ''}</span>
                    <span className="text-neutral-600 normal-case tracking-normal">({ex.tool_calls.length})</span>
                  </div>
                  {ex.tool_calls.map((tc, j) => (
                    <div key={j} className="text-[11px] font-mono">
                      <div className="text-amber-300">
                        <span className="text-neutral-500">{j + 1}.</span> {tc.function?.name || '<no name>'}
                        {tc.id && <span className="text-neutral-600 ml-2">id={tc.id}</span>}
                      </div>
                      <pre className="text-amber-100/70 whitespace-pre-wrap mt-0.5 pl-3 max-h-[200px] overflow-y-auto">
                        {(() => {
                          const args = tc.function?.arguments || ''
                          if (!args) return '<no args>'
                          try {
                            return JSON.stringify(JSON.parse(args), null, 2)
                          } catch {
                            return args  // raw if not valid JSON yet (mid-stream or buggy model output)
                          }
                        })()}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Metrics row */}
            <div className="flex items-center gap-3 flex-wrap pl-2 pt-1">
              {ex.pp_tok_s != null && (
                <span className="text-[10px] text-neutral-500">PP: <span className="text-blue-400 font-mono">{fmt(ex.pp_tok_s)}</span> tok/s</span>
              )}
              {ex.gen_tok_s != null && (
                <span className="text-[10px] text-neutral-500">Gen: <span className="text-emerald-400 font-mono">{fmt(ex.gen_tok_s)}</span> tok/s</span>
              )}
              {ex.wall_ms != null && (
                <span className="text-[10px] text-neutral-500">{fmtMs(ex.wall_ms)}</span>
              )}
              {ex.generation_tokens != null && (
                <span className="text-[10px] text-neutral-500">{ex.generation_tokens} tok</span>
              )}
            </div>
            {/* Rating row (own line for breathing room) */}
            <div className="flex items-center gap-1 pl-2 flex-wrap">
              <span className="text-[10px] text-neutral-500 mr-1">Note:</span>
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
        ))}

        {/* Streaming bubble (in-progress) */}
        {streaming && (
          <div className="space-y-2">
            {/* Live thinking block */}
            {streamingThinking && (
              <div className="flex justify-start">
                <div className="border-l-2 border-purple-700/60 bg-purple-950/20 rounded-r px-3 py-2 max-w-[85%] w-full">
                  <div className="text-[10px] uppercase tracking-wider text-purple-400 mb-1 flex items-center gap-1">
                    <Spinner />
                    <span>Thinking...</span>
                  </div>
                  <pre className="text-[11px] text-purple-200/70 font-mono whitespace-pre-wrap italic max-h-[200px] overflow-y-auto">
                    {streamingThinking}
                    <span className="inline-block w-2 h-3 bg-purple-400 ml-0.5 animate-pulse" />
                  </pre>
                </div>
              </div>
            )}
            {/* Live tool_calls block */}
            {streamingToolCalls.length > 0 && (
              <div className="flex justify-start">
                <div className="border-l-2 border-amber-600/60 bg-amber-950/20 rounded-r px-3 py-2 max-w-[85%] w-full space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-amber-400 flex items-center gap-1">
                    <Spinner />
                    <span>Tool call{streamingToolCalls.length > 1 ? 's' : ''}...</span>
                    <span className="text-neutral-600 normal-case tracking-normal">({streamingToolCalls.length})</span>
                  </div>
                  {streamingToolCalls.map((tc, j) => (
                    <div key={j} className="text-[11px] font-mono">
                      <div className="text-amber-300">
                        <span className="text-neutral-500">{j + 1}.</span> {tc.function?.name || '…'}
                      </div>
                      <pre className="text-amber-100/70 whitespace-pre-wrap mt-0.5 pl-3 max-h-[160px] overflow-y-auto">
                        {tc.function?.arguments || '…'}
                        <span className="inline-block w-2 h-3 bg-amber-400 ml-0.5 animate-pulse" />
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Live response block */}
            <div className="flex justify-start">
              <div className="bg-neutral-800/40 border border-neutral-700 rounded-lg px-3 py-2 max-w-[85%] text-xs text-neutral-200 font-mono whitespace-pre-wrap">
                {streamingText || (!streamingThinking && !streamingToolCalls.length && <Spinner />)}
                {streamingText && <span className="inline-block w-2 h-3 bg-emerald-400 ml-0.5 animate-pulse" />}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input + send */}
      <div className="flex gap-2 items-end">
        <textarea
          className="flex-1 bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 min-h-[60px] resize-y"
          placeholder="Ton message... (Ctrl/Cmd+Enter pour envoyer)"
          value={currentInput}
          onChange={e => setCurrentInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={streaming}
          rows={2}
        />
        {streaming ? (
          <button className={btnGray} onClick={handleStop}>Stop</button>
        ) : (
          <button className={btnBlue} onClick={handleSend} disabled={!currentInput.trim() || !selectedModel}>
            Envoyer
          </button>
        )}
      </div>
      {!selectedModel && (
        <div className="text-[10px] text-amber-500 mt-2">Selectionne un modele en haut pour demarrer.</div>
      )}

      {/* Footer: average + save + template conversion (two stacked rows) */}
      {exchanges.length > 0 && !streaming && (
        <div className="mt-4 pt-3 border-t border-neutral-800 space-y-3">
          {/* Row 1: average + save to rankings */}
          <div className="flex items-center gap-4 flex-wrap">
            <div>
              <Lbl>Note moyenne</Lbl>
              <Val color="text-yellow-400">{avgRating.toFixed(1)}/10</Val>
            </div>
            <span className="text-[10px] text-neutral-500">{exchanges.length} echange{exchanges.length > 1 ? 's' : ''}</span>
            <button className={btnGreen} onClick={handleSaveAll} disabled={savedAll || saveMut.isPending}>
              {savedAll ? 'Sauvegarde !' : 'Sauvegarder au classement'}
            </button>
          </div>

          {/* Row 2: template conversion */}
          <div className="flex items-center gap-2 flex-wrap">
            <Lbl>Template</Lbl>
            <input
              className={inputSm + ' min-w-[200px]'}
              placeholder="Nom du template..."
              value={tplName}
              onChange={e => setTplName(e.target.value)}
              disabled={tplSaved || saveTplMut.isPending}
            />
            <button
              className={btnGray}
              onClick={handleSaveAsTemplate}
              disabled={tplSaved || saveTplMut.isPending}
              title="Convertit la conversation en template (system prompt + liste des messages user) reutilisable dans Test Conversation"
            >
              {tplSaved ? 'Template sauve !' : 'Convertir en template'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
