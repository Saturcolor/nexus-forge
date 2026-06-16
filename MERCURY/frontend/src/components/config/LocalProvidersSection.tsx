import { useState } from 'react'
import { inputClass, labelClass, fieldClass, sectionClass, legendClass, type SectionProps } from './shared'
import Checkbox from './Checkbox'
import OrderableList from './OrderableList'
import ProbeUrlField from '../ProbeUrlField'

const DEFAULT_PROVIDER_ORDER = ['llamacpp', 'vllm', 'lucebox', 'ollama', 'lm_studio', 'mlx']
const PROVIDER_LABELS: Record<string, string> = { llamacpp: 'LlamaCPP', vllm: 'vLLM', lucebox: 'Lucebox', ollama: 'Ollama', lm_studio: 'LM Studio', mlx: 'MLX' }

export default function LocalProvidersSection({ config, updateField, markDirty }: SectionProps) {
  const [lmStudioAdvancedOpen, setLmStudioAdvancedOpen] = useState(false)

  return (
    <section className={sectionClass}>
      <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">Providers Locaux</h3>

      <div className="grid grid-cols-1 gap-5">
        {/* Ollama */}
        <div className="bg-neutral-950/60 border border-neutral-800 rounded-lg p-4 flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-neutral-200">Ollama</h4>
          <Checkbox id="cfg-ollama-enabled" checked={config.ollama_enabled !== false} onChange={e => updateField('ollama_enabled', e.target.checked)} label="Active" tooltip="Utiliser Ollama comme backend local pour les modeles." />
          <Checkbox id="cfg-ollama-proxy-only" checked={config.ollama_proxy_only === true} onChange={e => updateField('ollama_proxy_only', e.target.checked)} label="Proxy transparent" tooltip="Forward les requetes telles quelles vers /v1/chat/completions d'Ollama (pas de traduction de format)." />
          <Checkbox id="cfg-ollama-auto-pull" checked={config.ollama_auto_pull !== false} onChange={e => updateField('ollama_auto_pull', e.target.checked)} label="Auto-pull" tooltip="Pull automatiquement les modeles non presents lors d'une requete (load-on-demand)." />
          <div className={fieldClass}>
            <label htmlFor="cfg-ollama-url" className={labelClass}>URL</label>
            <input id="cfg-ollama-url" value={config.ollama_url ?? ''} onChange={e => updateField('ollama_url', e.target.value)} placeholder="http://localhost:11434" className={inputClass} title="Adresse de l'API Ollama (par defaut : localhost:11434)" />
          </div>
          <ProbeUrlField
            id="cfg-ollama-probe"
            value={config.ollama_probe_url ?? ''}
            onChange={v => updateField('ollama_probe_url', v)}
            description="URL de la probe telle que joignable depuis ce serveur (ex. http://brain:4567). Pas localhost si la probe tourne sur une autre machine."
          />
          <div className={fieldClass}>
            <label htmlFor="cfg-ollama-logs-dir" className={labelClass}>Repertoire logs Ollama</label>
            <input id="cfg-ollama-logs-dir" value={config.ollama_logs_dir ?? ''} onChange={e => updateField('ollama_logs_dir', e.target.value)} placeholder="Chemin vers les logs Ollama (optionnel)" className={inputClass} />
          </div>
        </div>

        {/* LM Studio */}
        <div className="bg-neutral-950/60 border border-neutral-800 rounded-lg p-4 flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-neutral-200">LM Studio</h4>
          <Checkbox id="cfg-lm-studio-enabled" checked={config.lm_studio_enabled !== false} onChange={e => updateField('lm_studio_enabled', e.target.checked)} label="Active" tooltip="Utiliser LM Studio comme backend local." />
          <Checkbox id="cfg-lm-studio-proxy-only" checked={config.lm_studio_proxy_only === true} onChange={e => updateField('lm_studio_proxy_only', e.target.checked)} label="Proxy transparent" tooltip="Forward les requetes telles quelles vers /v1/chat/completions de LM Studio (pas de traduction de format)." />
          <div className={fieldClass}>
            <label htmlFor="cfg-lm-studio-url" className={labelClass}>URL</label>
            <input id="cfg-lm-studio-url" value={config.lm_studio_url ?? ''} onChange={e => updateField('lm_studio_url', e.target.value)} placeholder="http://localhost:1234" className={inputClass} title="Adresse de l'API LM Studio (par defaut : localhost:1234)" />
          </div>
          <ProbeUrlField
            id="cfg-lm-studio-probe"
            value={config.lm_studio_probe_url ?? ''}
            onChange={v => updateField('lm_studio_probe_url', v)}
            description="URL de la probe telle que joignable depuis ce serveur (ex. http://brain:4567). Pas localhost si la probe tourne sur une autre machine."
          />
          <div className={fieldClass}>
            <label htmlFor="cfg-lm-studio-logs-dir" className={labelClass}>Repertoire logs LM Studio</label>
            <input id="cfg-lm-studio-logs-dir" value={config.lmstudio_logs_dir ?? ''} onChange={e => updateField('lmstudio_logs_dir', e.target.value)} placeholder="Chemin vers les logs LM Studio (optionnel)" className={inputClass} />
          </div>
          <div className={fieldClass}>
            <label htmlFor="cfg-lm-studio-reasoning" className={`${labelClass} flex items-center gap-1.5`}>
              Reasoning
              <span className="text-neutral-500 font-normal" title="Niveau de raisonnement pour les modeles compatibles (ex. deepseek)">ⓘ</span>
            </label>
            <select id="cfg-lm-studio-reasoning" value={config.lm_studio_reasoning ?? ''} onChange={e => updateField('lm_studio_reasoning', e.target.value)} className={inputClass}>
              <option value="">Desactive</option>
              <option value="off">Off</option>
              <option value="low">Faible</option>
              <option value="medium">Moyen</option>
              <option value="high">Eleve</option>
              <option value="on">On</option>
            </select>
          </div>

          <button
            type="button"
            onClick={() => setLmStudioAdvancedOpen(o => !o)}
            className="text-xs font-medium text-neutral-400 hover:text-neutral-200 flex items-center gap-1.5 mt-1"
          >
            {lmStudioAdvancedOpen ? '▼' : '▶'} Options avancees LM Studio
          </button>
          {lmStudioAdvancedOpen && (
            <div className="flex flex-col gap-4 border-l-2 border-neutral-700 pl-4">
              <div>
                <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Stateful (previous_response_id)</span>
                <Checkbox id="cfg-stateful-responses-enabled" checked={config.stateful_responses_enabled !== false} onChange={e => updateField('stateful_responses_enabled', e.target.checked)} label="Activer stateful" tooltip="Utiliser previous_response_id pour reduire les tokens envoyes au backend (session LM Studio)." />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
                  <div className={fieldClass}>
                    <label htmlFor="cfg-stateful-ttl" className={labelClass} title="Duree de vie d'une session en secondes">TTL session (s)</label>
                    <input id="cfg-stateful-ttl" type="number" value={config.stateful_responses_ttl_seconds ?? 600} min={60} placeholder="600" className={inputClass} onChange={e => updateField('stateful_responses_ttl_seconds', Number(e.target.value))} />
                  </div>
                  <div className={fieldClass}>
                    <label htmlFor="cfg-stateful-send-max-age" className={labelClass} title="N'utiliser previous_response_id que si enregistre il y a moins de X s">Age max previous_id (s)</label>
                    <input id="cfg-stateful-send-max-age" type="number" value={config.stateful_responses_send_max_age_seconds ?? 120} min={0} placeholder="120" className={inputClass} onChange={e => updateField('stateful_responses_send_max_age_seconds', e.target.value === '' ? undefined : Number(e.target.value))} />
                  </div>
                </div>
                <div className={fieldClass}>
                  <label htmlFor="cfg-stateful-header" className={labelClass}>Header conversation (optionnel)</label>
                  <input id="cfg-stateful-header" value={config.stateful_responses_session_header ?? ''} onChange={e => updateField('stateful_responses_session_header', e.target.value)} placeholder="X-Conversation-Id" className={inputClass} />
                </div>
              </div>
              <div>
                <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Injection prompt</span>
                <Checkbox id="cfg-session-init" checked={config.lm_studio_session_init_enabled === true} onChange={e => updateField('lm_studio_session_init_enabled', e.target.checked)} label='Bouton « Injecter Prompt »' tooltip="Activer le bouton sur les modeles charges (utile pour fix template jinja, ex. qwen3.5)." />
                {config.lm_studio_session_init_enabled && (
                  <div className={fieldClass}>
                    <label htmlFor="cfg-session-init-prompt" className={labelClass}>Prompt fallback (si pas de body en cache)</label>
                    <input id="cfg-session-init-prompt" value={config.lm_studio_session_init_prompt ?? 'Ready.'} onChange={e => updateField('lm_studio_session_init_prompt', e.target.value)} placeholder="Ready." className={inputClass} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* MLX */}
        <div className="bg-neutral-950/60 border border-neutral-800 rounded-lg p-4 flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-neutral-200">MLX</h4>
          <Checkbox id="cfg-mlx-enabled" checked={config.mlx_enabled !== false} onChange={e => updateField('mlx_enabled', e.target.checked)} label="Active" tooltip="Utiliser MLX comme backend local (Apple Silicon)." />
          <div className={fieldClass}>
            <label htmlFor="cfg-mlx-url" className={labelClass}>URL</label>
            <input id="cfg-mlx-url" value={config.mlx_url ?? ''} onChange={e => updateField('mlx_url', e.target.value)} placeholder="http://localhost:8080" className={inputClass} title="Adresse de l'API MLX (par defaut : localhost:8080)" />
          </div>
        </div>

        {/* LlamaCPP Daemon */}
        <div className="bg-neutral-950/60 border border-neutral-800 rounded-lg p-4 flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-neutral-200">LlamaCPP Daemon</h4>
          <Checkbox id="cfg-llamacpp-enabled" checked={config.llamacpp_enabled !== false} onChange={e => updateField('llamacpp_enabled', e.target.checked)} label="Active" tooltip="Utiliser llamacpp-daemon comme backend local (llama.cpp). Gere des instances llama-server a la demande avec une API OpenAI-compatible." />
          <div className={fieldClass}>
            <label htmlFor="cfg-llamacpp-url" className={labelClass}>URL</label>
            <input id="cfg-llamacpp-url" value={config.llamacpp_url ?? ''} onChange={e => updateField('llamacpp_url', e.target.value)} placeholder="http://localhost:4321" className={inputClass} title="Adresse du daemon llamacpp (par defaut : localhost:4321). Sert aussi de probe pour les stats." />
          </div>
        </div>

        {/* vLLM (via brain-daemon, toolbox kyuz0/vllm-therock-gfx1151) */}
        <div className="bg-neutral-950/60 border border-neutral-800 rounded-lg p-4 flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-neutral-200">vLLM</h4>
          <Checkbox id="cfg-vllm-enabled" checked={config.vllm_enabled === true} onChange={e => updateField('vllm_enabled', e.target.checked)} label="Active" tooltip="Sert les modeles HF (vLLM) via le brain-daemon. Spec decoding MTP Gemma 4 supporte. Off par defaut." />
          <div className={fieldClass}>
            <label htmlFor="cfg-vllm-url" className={labelClass}>URL</label>
            <input id="cfg-vllm-url" value={config.vllm_url ?? ''} onChange={e => updateField('vllm_url', e.target.value)} placeholder="http://localhost:4321 (= llamacpp_url)" className={inputClass} title="Optionnel — vide par defaut, retombe sur llamacpp_url (meme brain-daemon). Override seulement si daemon vLLM dedie." />
          </div>
        </div>

        {/* Lucebox (backend natif extra brain-daemon : DFlash speculative decoding sur GGUF) */}
        <div className="bg-neutral-950/60 border border-neutral-800 rounded-lg p-4 flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-neutral-200">Lucebox</h4>
          <Checkbox id="cfg-lucebox-enabled" checked={config.lucebox_enabled === true} onChange={e => updateField('lucebox_enabled', e.target.checked)} label="Active" tooltip="Sert les GGUF en mode DFlash speculative decoding (target GGUF + draft safetensors). Pris en charge par brain-daemon via extra_native_backends.native-lucebox. Off par defaut." />
          <div className={fieldClass}>
            <label htmlFor="cfg-lucebox-url" className={labelClass}>URL</label>
            <input id="cfg-lucebox-url" value={config.lucebox_url ?? ''} onChange={e => updateField('lucebox_url', e.target.value)} placeholder="http://localhost:4321 (= llamacpp_url)" className={inputClass} title="Optionnel — vide par defaut, retombe sur llamacpp_url (meme brain-daemon). Override seulement si daemon Lucebox dedie." />
          </div>
        </div>
      </div>

        {/* ── Audio Local (Brain) ──────────────────────────────────── */}
        <div className="bg-neutral-950/60 border border-neutral-800 rounded-lg p-4 flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-neutral-200">Audio Local (Brain)</h4>
          <Checkbox id="cfg-audio-local-enabled" checked={config.audio_local_enabled === true} onChange={e => updateField('audio_local_enabled', e.target.checked)} label="Active" tooltip="Active le backend audio local (Kokoro TTS + Faster Whisper STT) sur le daemon brain." />
          <div className={fieldClass}>
            <label htmlFor="cfg-audio-local-url" className={labelClass}>URL</label>
            <input id="cfg-audio-local-url" value={config.audio_local_url ?? ''} onChange={e => updateField('audio_local_url', e.target.value)} placeholder="http://brain:4321" className={inputClass} title="URL du daemon brain (meme service que llamacpp). Les routes audio sont sur /audio/*." />
          </div>
        </div>

        {/* ── Benchmarks externes ────────────────────────────────────── */}

        {/* ToolCall-15 */}
        <div className="bg-neutral-950/60 border border-neutral-800 rounded-lg p-4 flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-neutral-200">ToolCall-15</h4>
          <Checkbox id="cfg-toolcall15-enabled" checked={config.toolcall15_enabled === true} onChange={e => updateField('toolcall15_enabled', e.target.checked)} label="Active" tooltip="Active le proxy ToolCall-15 (benchmark tool calling). Le service Next.js doit tourner sur le port configure." />
          <div className={fieldClass}>
            <label htmlFor="cfg-toolcall15-url" className={labelClass}>URL</label>
            <input id="cfg-toolcall15-url" value={config.toolcall15_url ?? ''} onChange={e => updateField('toolcall15_url', e.target.value)} placeholder="http://localhost:3015" className={inputClass} title="Adresse du service ToolCall-15 (par defaut : localhost:3015)" />
          </div>
        </div>

        {/* BugFind-15 */}
        <div className="bg-neutral-950/60 border border-neutral-800 rounded-lg p-4 flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-neutral-200">BugFind-15</h4>
          <Checkbox id="cfg-bugfind15-enabled" checked={config.bugfind15_enabled === true} onChange={e => updateField('bugfind15_enabled', e.target.checked)} label="Active" tooltip="Active le proxy BugFind-15 (benchmark debugging). Necessite le service Next.js + le sandbox Docker (verify:sandbox:serve)." />
          <div className={fieldClass}>
            <label htmlFor="cfg-bugfind15-url" className={labelClass}>URL</label>
            <input id="cfg-bugfind15-url" value={config.bugfind15_url ?? ''} onChange={e => updateField('bugfind15_url', e.target.value)} placeholder="http://localhost:3016" className={inputClass} title="Adresse du service BugFind-15 (par defaut : localhost:3016)" />
          </div>
        </div>

      {/* Provider Priority */}
      <fieldset className="border-0 p-0 m-0 flex flex-col gap-3">
        <legend className={legendClass}>Ordre de priorite des providers</legend>
        <p className="text-xs text-neutral-500 m-0">Ordre dans lequel les backends locaux sont interroges pour la resolution automatique des modeles.</p>
        <OrderableList
          items={config.provider_priority ?? DEFAULT_PROVIDER_ORDER}
          onChange={items => { markDirty(); updateField('provider_priority', items) }}
          labels={PROVIDER_LABELS}
        />
      </fieldset>
    </section>
  )
}
