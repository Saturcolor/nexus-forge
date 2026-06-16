import { useState } from 'react'
import { Cpu, ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { StatusDot } from '../../ui/Badge'
import { ConfigCheckbox } from './ConfigCheckbox'
import { ConfigOrderableList } from './ConfigOrderableList'
import { inputCls, labelCls, fieldCls, groupCls, selectCls, type SectionProps } from './shared'

const DEFAULT_PROVIDER_ORDER = ['llamacpp', 'vllm', 'lucebox', 'ollama', 'lm_studio', 'mlx']
const PROVIDER_LABELS: Record<string, string> = {
  llamacpp: 'LlamaCPP', vllm: 'vLLM', lucebox: 'Lucebox',
  ollama: 'Ollama', lm_studio: 'LM Studio', mlx: 'MLX',
}

/* ── Toggle pill ─────────────────────────────────────────────────── */
function PillToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onToggle() }}
      aria-label={enabled ? 'Désactiver' : 'Activer'}
      className={clsx(
        'relative shrink-0 w-7 h-[15px] rounded-full border transition-colors',
        enabled ? 'bg-primary border-primary' : 'bg-background border-border/70',
      )}
    >
      <span className={clsx(
        'absolute top-px w-[11px] h-[11px] rounded-full transition-all duration-150',
        enabled ? 'left-[14px] bg-primary-foreground' : 'left-px bg-muted-foreground/40',
      )} />
    </button>
  )
}

/* ── Single accordion row ────────────────────────────────────────── */
type ProviderRowProps = {
  id: string
  label: string
  enabled: boolean
  url: string
  urlPlaceholder: string
  urlHint?: string
  isOpen: boolean
  onToggle: () => void
  onUrlChange: (v: string) => void
  onExpandToggle: () => void
  extra?: React.ReactNode
}

function ProviderRow({
  id, label, enabled, url, urlPlaceholder, urlHint,
  isOpen, onToggle, onUrlChange, onExpandToggle, extra,
}: ProviderRowProps) {
  return (
    <div className={clsx(
      'rounded-md border transition-colors overflow-hidden',
      isOpen ? 'border-border/70' : 'border-border/40',
    )}>
      {/* ── Header row ── */}
      <div className="flex items-center bg-background/60 hover:bg-background/80 transition-colors">
        <div className="pl-2.5 py-2 shrink-0">
          <PillToggle enabled={enabled} onToggle={onToggle} />
        </div>
        <button
          type="button"
          onClick={onExpandToggle}
          className="flex items-center gap-2 px-2 py-2 flex-1 min-w-0 text-left"
        >
          <StatusDot tone={enabled ? 'success' : 'muted'} />
          <span className={clsx(
            'text-[11px] font-semibold flex-1 min-w-0',
            enabled ? 'text-foreground' : 'text-muted-foreground/70',
          )}>
            {label}
          </span>
          {url ? (
            <code className="text-[10px] font-mono text-muted-foreground/50 truncate max-w-[130px] hidden sm:block">
              {url}
            </code>
          ) : (
            <span className="text-[10px] text-muted-foreground/30 hidden sm:block">—</span>
          )}
          <ChevronDown
            size={12}
            className={clsx('text-muted-foreground/40 shrink-0 transition-transform duration-200', isOpen && 'rotate-180')}
          />
        </button>
      </div>

      {/* ── Expanded content ── */}
      {isOpen && (
        <div className="px-3 pt-3 pb-3.5 border-t border-border/40 bg-background/30 flex flex-col gap-3">
          <div className={fieldCls}>
            <label htmlFor={`cfg-${id}-url`} className={labelCls}>URL</label>
            <input
              id={`cfg-${id}-url`}
              value={url}
              onChange={e => onUrlChange(e.target.value)}
              placeholder={urlPlaceholder}
              className={inputCls}
            />
            {urlHint && <p className="text-[10px] text-muted-foreground/50 m-0">{urlHint}</p>}
          </div>
          {extra}
        </div>
      )}
    </div>
  )
}

/* ── Group separator ─────────────────────────────────────────────── */
function GroupLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className={groupCls}>{label}</span>
      <div className="flex-1 h-px bg-border/40" />
    </div>
  )
}

/* ── Main card ───────────────────────────────────────────────────── */
export function LocalProvidersCard({ config, updateField, markDirty }: SectionProps) {
  const [openProvider, setOpenProvider] = useState<string | null>(null)
  const [lmAdvancedOpen, setLmAdvancedOpen] = useState(false)

  const expand = (id: string) => setOpenProvider(o => o === id ? null : id)

  return (
    <Card>
      <CardHeader title="Providers Locaux" icon={<Cpu size={13} />} />
      <CardBody className="!py-3 flex flex-col gap-1.5">

        {/* ── Backends ── */}
        <GroupLabel label="Backends" />

        <ProviderRow
          id="llamacpp"
          label="LlamaCPP Daemon"
          enabled={config.llamacpp_enabled !== false}
          url={config.llamacpp_url ?? ''}
          urlPlaceholder="http://localhost:4321"
          isOpen={openProvider === 'llamacpp'}
          onToggle={() => updateField('llamacpp_enabled', !(config.llamacpp_enabled !== false))}
          onUrlChange={v => updateField('llamacpp_url', v)}
          onExpandToggle={() => expand('llamacpp')}
        />

        <ProviderRow
          id="vllm"
          label="vLLM"
          enabled={config.vllm_enabled === true}
          url={config.vllm_url ?? ''}
          urlPlaceholder="vide = retombe sur llamacpp_url"
          urlHint="Laisser vide si vLLM partage le même daemon que LlamaCPP."
          isOpen={openProvider === 'vllm'}
          onToggle={() => updateField('vllm_enabled', !config.vllm_enabled)}
          onUrlChange={v => updateField('vllm_url', v)}
          onExpandToggle={() => expand('vllm')}
        />

        <ProviderRow
          id="lucebox"
          label="Lucebox"
          enabled={config.lucebox_enabled === true}
          url={config.lucebox_url ?? ''}
          urlPlaceholder="vide = retombe sur llamacpp_url"
          urlHint="Laisser vide si Lucebox partage le même daemon que LlamaCPP."
          isOpen={openProvider === 'lucebox'}
          onToggle={() => updateField('lucebox_enabled', !config.lucebox_enabled)}
          onUrlChange={v => updateField('lucebox_url', v)}
          onExpandToggle={() => expand('lucebox')}
        />

        <ProviderRow
          id="ollama"
          label="Ollama"
          enabled={config.ollama_enabled !== false}
          url={config.ollama_url ?? ''}
          urlPlaceholder="http://localhost:11434"
          isOpen={openProvider === 'ollama'}
          onToggle={() => updateField('ollama_enabled', !(config.ollama_enabled !== false))}
          onUrlChange={v => updateField('ollama_url', v)}
          onExpandToggle={() => expand('ollama')}
          extra={
            <div className="flex flex-col gap-2">
              <ConfigCheckbox
                id="cfg-ollama-proxy-only"
                checked={config.ollama_proxy_only === true}
                onChange={e => updateField('ollama_proxy_only', e.target.checked)}
                label="Proxy transparent"
                hint="Forward les requêtes telles quelles sans traduction de format."
              />
              <ConfigCheckbox
                id="cfg-ollama-auto-pull"
                checked={config.ollama_auto_pull !== false}
                onChange={e => updateField('ollama_auto_pull', e.target.checked)}
                label="Auto-pull"
                hint="Pull automatiquement les modèles non présents à la demande."
              />
            </div>
          }
        />

        <ProviderRow
          id="lm_studio"
          label="LM Studio"
          enabled={config.lm_studio_enabled !== false}
          url={config.lm_studio_url ?? ''}
          urlPlaceholder="http://localhost:1234"
          isOpen={openProvider === 'lm_studio'}
          onToggle={() => updateField('lm_studio_enabled', !(config.lm_studio_enabled !== false))}
          onUrlChange={v => updateField('lm_studio_url', v)}
          onExpandToggle={() => expand('lm_studio')}
          extra={
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <ConfigCheckbox
                  id="cfg-lm-studio-proxy-only"
                  checked={config.lm_studio_proxy_only === true}
                  onChange={e => updateField('lm_studio_proxy_only', e.target.checked)}
                  label="Proxy transparent"
                />
                <div className={fieldCls}>
                  <label htmlFor="cfg-lm-studio-reasoning" className={labelCls}>Reasoning</label>
                  <select id="cfg-lm-studio-reasoning" value={config.lm_studio_reasoning ?? ''} onChange={e => updateField('lm_studio_reasoning', e.target.value)} className={selectCls}>
                    <option value="">Désactivé</option>
                    <option value="off">Off</option>
                    <option value="low">Faible</option>
                    <option value="medium">Moyen</option>
                    <option value="high">Élevé</option>
                    <option value="on">On</option>
                  </select>
                </div>
              </div>

              {/* Advanced section */}
              <button
                type="button"
                onClick={() => setLmAdvancedOpen(o => !o)}
                className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors w-fit"
              >
                <ChevronDown size={10} className={clsx('transition-transform duration-200', lmAdvancedOpen && 'rotate-180')} />
                Options avancées
              </button>

              {lmAdvancedOpen && (
                <div className="flex flex-col gap-3 border-l-2 border-border/50 pl-3">
                  <div className="flex flex-col gap-2">
                    <span className={groupCls}>Stateful (previous_response_id)</span>
                    <ConfigCheckbox
                      id="cfg-stateful-responses-enabled"
                      checked={config.stateful_responses_enabled !== false}
                      onChange={e => updateField('stateful_responses_enabled', e.target.checked)}
                      label="Activer stateful"
                      hint="Utiliser previous_response_id pour réduire les tokens envoyés."
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <div className={fieldCls}>
                        <label htmlFor="cfg-stateful-ttl" className={labelCls}>TTL session (s)</label>
                        <input id="cfg-stateful-ttl" type="number" value={config.stateful_responses_ttl_seconds ?? 600} min={60} onChange={e => updateField('stateful_responses_ttl_seconds', Number(e.target.value))} className={inputCls} />
                      </div>
                      <div className={fieldCls}>
                        <label htmlFor="cfg-stateful-max-age" className={labelCls}>Age max (s)</label>
                        <input id="cfg-stateful-max-age" type="number" value={config.stateful_responses_send_max_age_seconds ?? 120} min={0} onChange={e => updateField('stateful_responses_send_max_age_seconds', e.target.value === '' ? undefined : Number(e.target.value))} className={inputCls} />
                      </div>
                    </div>
                    <div className={fieldCls}>
                      <label htmlFor="cfg-stateful-header" className={labelCls}>Header conversation</label>
                      <input id="cfg-stateful-header" value={config.stateful_responses_session_header ?? ''} onChange={e => updateField('stateful_responses_session_header', e.target.value)} placeholder="X-Conversation-Id" className={inputCls} />
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className={groupCls}>Injection prompt</span>
                    <ConfigCheckbox
                      id="cfg-session-init"
                      checked={config.lm_studio_session_init_enabled === true}
                      onChange={e => updateField('lm_studio_session_init_enabled', e.target.checked)}
                      label='Bouton « Injecter Prompt »'
                      hint="Fix template jinja (ex. qwen3.5) — injecte un pré-prompt avant le contenu."
                    />
                    {config.lm_studio_session_init_enabled && (
                      <div className={fieldCls}>
                        <label htmlFor="cfg-session-init-prompt" className={labelCls}>Prompt fallback</label>
                        <input id="cfg-session-init-prompt" value={config.lm_studio_session_init_prompt ?? 'Ready.'} onChange={e => updateField('lm_studio_session_init_prompt', e.target.value)} placeholder="Ready." className={inputCls} />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          }
        />

        <ProviderRow
          id="mlx"
          label="MLX"
          enabled={config.mlx_enabled !== false}
          url={config.mlx_url ?? ''}
          urlPlaceholder="http://localhost:8080"
          isOpen={openProvider === 'mlx'}
          onToggle={() => updateField('mlx_enabled', !(config.mlx_enabled !== false))}
          onUrlChange={v => updateField('mlx_url', v)}
          onExpandToggle={() => expand('mlx')}
        />

        {/* ── Audio ── */}
        <GroupLabel label="Audio" />

        <ProviderRow
          id="audio_local"
          label="Audio Local (Brain)"
          enabled={config.audio_local_enabled === true}
          url={config.audio_local_url ?? ''}
          urlPlaceholder="http://brain:4321"
          urlHint="Même service que LlamaCPP — routes audio sur /audio/*."
          isOpen={openProvider === 'audio_local'}
          onToggle={() => updateField('audio_local_enabled', !config.audio_local_enabled)}
          onUrlChange={v => updateField('audio_local_url', v)}
          onExpandToggle={() => expand('audio_local')}
        />

        {/* ── Benchmarks ── */}
        <GroupLabel label="Benchmarks" />

        <ProviderRow
          id="toolcall15"
          label="ToolCall-15"
          enabled={config.toolcall15_enabled === true}
          url={config.toolcall15_url ?? ''}
          urlPlaceholder="http://localhost:3015"
          isOpen={openProvider === 'toolcall15'}
          onToggle={() => updateField('toolcall15_enabled', !config.toolcall15_enabled)}
          onUrlChange={v => updateField('toolcall15_url', v)}
          onExpandToggle={() => expand('toolcall15')}
        />

        <ProviderRow
          id="bugfind15"
          label="BugFind-15"
          enabled={config.bugfind15_enabled === true}
          url={config.bugfind15_url ?? ''}
          urlPlaceholder="http://localhost:3016"
          isOpen={openProvider === 'bugfind15'}
          onToggle={() => updateField('bugfind15_enabled', !config.bugfind15_enabled)}
          onUrlChange={v => updateField('bugfind15_url', v)}
          onExpandToggle={() => expand('bugfind15')}
        />

        {/* ── Priority ── */}
        <div className="flex flex-col gap-2 pt-2">
          <GroupLabel label="Priorité" />
          <p className="text-[10px] text-muted-foreground/60 m-0">
            Ordre dans lequel les backends locaux sont interrogés pour la résolution automatique.
          </p>
          <ConfigOrderableList
            items={config.provider_priority ?? DEFAULT_PROVIDER_ORDER}
            onChange={items => { markDirty(); updateField('provider_priority', items) }}
            labels={PROVIDER_LABELS}
          />
        </div>

      </CardBody>
    </Card>
  )
}
