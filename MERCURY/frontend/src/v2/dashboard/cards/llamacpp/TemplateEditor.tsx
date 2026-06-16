import { useMemo, useState } from 'react'
import { Save, Trash2, Copy, ClipboardPaste, RotateCcw, AlertCircle, CheckCircle2 } from 'lucide-react'
import { clsx } from 'clsx'
import {
  useSetLlamacppTemplateMutation,
  useDeleteLlamacppTemplateMutation,
} from '../../../../api/queries'
import type { LlamacppTemplate } from '../../../../api/admin'
import { setTemplateClipboard, useTemplateClipboard } from '../../../../components/templates/clipboard'
import { Button } from '../../../ui/Button'
import { Spinner } from '../../../ui/Spinner'
import {
  templateToForm,
  formToTemplate,
  KV_TYPE_OPTIONS,
  type TemplateFormState,
} from './templateForm'
import {
  NumberInput,
  TextInput,
  SelectInput,
  TextareaInput,
  BooleanSwitch,
  BackendSelector,
  Section,
} from './fields'

type Tab = 'load' | 'sampling' | 'speculative' | 'advanced'

const TABS: { id: Tab; label: string; hint?: string }[] = [
  { id: 'load',        label: 'Load',         hint: 'démarrage · KV · RoPE' },
  { id: 'sampling',    label: 'Sampling',     hint: 'valeurs par défaut' },
  { id: 'speculative', label: 'Speculative',  hint: 'MTP / draft' },
  { id: 'advanced',    label: 'Avancé',       hint: 'env vars, extra args, chat template' },
]

export function TemplateEditor({
  modelId,
  existingTemplate,
}: {
  modelId: string
  existingTemplate?: LlamacppTemplate
}) {
  const [form, setForm] = useState<TemplateFormState>(() => templateToForm(existingTemplate))
  const [tab, setTab] = useState<Tab>('load')
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null)
  const setMut = useSetLlamacppTemplateMutation()
  const delMut = useDeleteLlamacppTemplateMutation()
  const clipboard = useTemplateClipboard<TemplateFormState>()
  const busy = setMut.isPending || delMut.isPending

  const update = <K extends keyof TemplateFormState>(key: K, value: TemplateFormState[K]) => {
    setForm(f => ({ ...f, [key]: value }))
  }

  const kvOptions = useMemo(
    () => KV_TYPE_OPTIONS.map(o => ({ value: o, label: o || '— (défaut)' })),
    [],
  )

  const handleSave = async () => {
    setStatus(null)
    if (form.chat_template_kwargs_extra.trim()) {
      try {
        const parsed = JSON.parse(form.chat_template_kwargs_extra)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setStatus({ msg: 'chat_template_kwargs doit être un objet JSON { clé: valeur }', ok: false })
          return
        }
      } catch (e) {
        setStatus({ msg: `JSON invalide : ${e instanceof Error ? e.message : String(e)}`, ok: false })
        return
      }
    }
    try {
      await setMut.mutateAsync({ model_id: modelId, template: formToTemplate(form) })
      setStatus({ msg: 'Template sauvegardé', ok: true })
    } catch (e) {
      setStatus({ msg: e instanceof Error ? e.message : String(e), ok: false })
    }
  }

  const handleDelete = async () => {
    setStatus(null)
    try {
      await delMut.mutateAsync(modelId)
      setStatus({ msg: 'Template supprimé', ok: true })
      setForm(templateToForm(undefined))
    } catch (e) {
      setStatus({ msg: e instanceof Error ? e.message : String(e), ok: false })
    }
  }

  const handleCopy = () => {
    setTemplateClipboard({ sourceModelId: modelId, form: { ...form } })
    setStatus({ msg: `Template copié depuis ${modelId}`, ok: true })
  }

  const handlePaste = () => {
    if (!clipboard) return
    if (clipboard.sourceModelId === modelId) {
      setStatus({ msg: 'Source et destination identiques', ok: false })
      return
    }
    setForm({ ...clipboard.form })
    setStatus({ msg: `Collé depuis ${clipboard.sourceModelId} — vérifie et sauvegarde`, ok: true })
  }

  const handleReset = () => {
    setForm(templateToForm(existingTemplate))
    setStatus({ msg: 'Réinitialisé', ok: true })
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Tabs */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-0.5 px-0.5 py-0.5 rounded-md bg-background border border-border/60 self-start">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={clsx(
                'px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors',
                tab === t.id
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              title={t.hint}
            >
              {t.label}
            </button>
          ))}
        </div>
        {TABS.find(t => t.id === tab)?.hint && (
          <span className="text-[10px] text-muted-foreground/70 px-0.5">
            {TABS.find(t => t.id === tab)?.hint}
          </span>
        )}
      </div>

      {/* Tab content */}
      <div className="flex flex-col gap-5">
        {tab === 'load' && (
          <>
            <Section title="Contexte & GPU" cols={2}>
              <NumberInput label="ctx_size" placeholder="32768" value={form.ctx_size} onChange={v => update('ctx_size', v)} disabled={busy}
                tooltip="Taille du contexte en tokens (-c N). Détermine la fenêtre prompt+réponse. Plus grand = plus de VRAM pour le KV cache. Valeurs typiques : 4096, 16384, 32768, 131072." />
              <NumberInput label="n_gpu_layers" placeholder="999" value={form.n_gpu_layers} onChange={v => update('n_gpu_layers', v)} disabled={busy}
                tooltip="Couches offloadées sur GPU (-ngl N). 999 = tout sur GPU. 0 = CPU uniquement. Augmenter progressivement selon la VRAM disponible." />
              <NumberInput label="parallel" placeholder="1" min={1} max={8} value={form.parallel} onChange={v => update('parallel', v)} disabled={busy}
                tooltip="Nombre de slots parallèles (--parallel N). 1 = une seule conversation active, tout le KV cache disponible." />
              <BackendSelector value={form.backend} onChange={v => update('backend', v)} disabled={busy} />
            </Section>
            <Section title="Toggles" cols={4}>
              <BooleanSwitch label="flash_attn" checked={form.flash_attn} onChange={v => update('flash_attn', v)} disabled={busy}
                tooltip="Flash Attention (-fa 1). Accélère le calcul d'attention sur GPU compatible. Fortement recommandé." />
              <BooleanSwitch label="jinja" checked={form.jinja} onChange={v => update('jinja', v)} disabled={busy}
                tooltip="--jinja : active le template Jinja bundled dans le GGUF. Requis pour tool-use natif, thinking blocks, Qwen3/Gemma-thinking/GPT-OSS." />
              <BooleanSwitch label="no_mmap" checked={form.no_mmap} onChange={v => update('no_mmap', v)} disabled={busy}
                tooltip="Désactiver le memory mapping (--no-mmap). Recommandé quand n_gpu_layers > 0." />
              <BooleanSwitch label="ctx_shift" checked={form.ctx_shift} onChange={v => update('ctx_shift', v)} disabled={busy}
                tooltip="Fenêtre glissante de contexte. Pour désactiver manuellement : --no-ctx-shift dans extra_args." />
              <BooleanSwitch label="unified_kv_cache" checked={form.unified_kv_cache} onChange={v => update('unified_kv_cache', v)} disabled={busy}
                tooltip="Buffer KV unifié (--kv-unified). Améliore l'utilisation mémoire quand parallel > 1." />
              <BooleanSwitch label="mlock" checked={form.mlock} onChange={v => update('mlock', v)} disabled={busy}
                tooltip="--mlock : force le kernel à garder le modèle en RAM. Recommandé sur Strix Halo 128 GiB unifiée." />
              <BooleanSwitch label="debug" checked={form.debug} onChange={v => update('debug', v)} disabled={busy} highlight
                tooltip="--verbose --verbose-prompt : dump le prompt rendu dans les logs daemon. Logs lourds — à activer temporairement pour diagnostic." />
              <BooleanSwitch label="merge consecutive" checked={form.mergeConsecutiveMessages} onChange={v => update('mergeConsecutiveMessages', v)} disabled={busy}
                tooltip="Fusionne messages adjacents de même rôle (user+user, assistant+assistant). Pour templates stricts (Mistral PEG-native)." />
            </Section>
            <Section title="Performance CPU / batch" cols={4}>
              <NumberInput label="n_threads" placeholder="— (auto)" min={1} value={form.n_threads} onChange={v => update('n_threads', v)} disabled={busy}
                tooltip="Threads pour la génération (-t N). Vide = auto." />
              <NumberInput label="n_threads_batch" placeholder="— (auto)" min={1} value={form.n_threads_batch} onChange={v => update('n_threads_batch', v)} disabled={busy}
                tooltip="Threads pour le prompt initial (-tb N). Vide = auto." />
              <NumberInput label="n_batch" placeholder="— (2048)" min={1} value={form.n_batch} onChange={v => update('n_batch', v)} disabled={busy}
                tooltip="Taille de batch logique pour le prompt (-b N). Plus grand = traitement plus rapide mais plus de VRAM." />
              <NumberInput label="n_ubatch" placeholder="— (512)" min={1} value={form.n_ubatch} onChange={v => update('n_ubatch', v)} disabled={busy}
                tooltip="Taille de sous-batch physique (-ub N). Doit être ≤ n_batch." />
            </Section>
            <Section title="KV cache" cols={2}>
              <SelectInput label="type_k" value={form.type_k} onChange={v => update('type_k', v)} options={kvOptions} disabled={busy}
                tooltip="Quantization des clés. f16 = défaut. q8_0 = bon compromis. turbo2/3/4 = fork native-turboquant (requiert -fa 1 + --kv-unified + head_dim%128==0)." />
              <SelectInput label="type_v" value={form.type_v} onChange={v => update('type_v', v)} options={kvOptions} disabled={busy}
                tooltip="Quantization des valeurs. Sweet spot Qwen3.6-35B-A3B : turbo3/turbo3." />
              <BooleanSwitch label="swa_full" checked={form.swa_full} onChange={v => update('swa_full', v)} disabled={busy}
                tooltip="--swa-full : cache KV plein pour modèles SWA (Qwen3, Nemotron). Élimine forced full reprocessing. + VRAM." />
              <BooleanSwitch label="kv_cache_auto_dump" checked={form.kv_cache_auto_dump} onChange={v => update('kv_cache_auto_dump', v)} disabled={busy}
                tooltip="Save/restore auto du KV cache à l'unload/reload. Nécessite kv_cache_dir configuré dans le daemon." />
            </Section>
            <Section title="RoPE & contexte" cols={3}>
              <NumberInput label="rope_freq_base" placeholder="— (modèle)" step="1000" min={0} value={form.rope_freq_base} onChange={v => update('rope_freq_base', v)} disabled={busy}
                tooltip="--rope-freq-base. Augmenter pour étendre le contexte (ex : 500000 pour certains Llama 3)." />
              <NumberInput label="rope_freq_scale" placeholder="— (défaut)" step="0.01" min={0} value={form.rope_freq_scale} onChange={v => update('rope_freq_scale', v)} disabled={busy}
                tooltip="--rope-freq-scale. < 1 = compresse positions (étend contexte)." />
              <NumberInput label="cache_ram (MiB)" placeholder="— (8192)" min={0} value={form.cache_ram} onChange={v => update('cache_ram', v)} disabled={busy}
                tooltip="--cache-ram MiB : prompt cache host. 0 = désactivé (workaround Gemma-4 RAM bloat)." />
              <NumberInput label="ctx_checkpoints" placeholder="— (32)" min={0} max={32} value={form.ctx_checkpoints} onChange={v => update('ctx_checkpoints', v)} disabled={busy}
                tooltip="--ctx-checkpoints : snapshots SWA. 1 = workaround Gemma-4 RAM bloat (défaut 32 = 30+ GiB)." />
              <BooleanSwitch label="cache_idle_slots" checked={form.cache_idle_slots} onChange={v => update('cache_idle_slots', v)} disabled={busy}
                tooltip="Sérialise KV idle vers slot-save-path. Redondant si kv_cache_auto_dump est on." />
            </Section>
          </>
        )}

        {tab === 'sampling' && (
          <>
            <Section title="Sampling" cols={3}>
              <NumberInput label="temperature" placeholder="—" step="0.05" min={0} max={2} value={form.temperature} onChange={v => update('temperature', v)} disabled={busy}
                tooltip="0 = déterministe. 0.2–0.7 = stable. 0.8–1.2 = créatif. Défaut llama-server : 0.8." />
              <NumberInput label="top_p" placeholder="—" step="0.05" min={0} max={1} value={form.top_p} onChange={v => update('top_p', v)} disabled={busy}
                tooltip="Nucleus sampling. 0.9–0.95 = standard." />
              <NumberInput label="top_k" placeholder="—" min={0} value={form.top_k} onChange={v => update('top_k', v)} disabled={busy}
                tooltip="Limite aux k meilleurs tokens. 0 = désactivé. 40–50 classiques." />
              <NumberInput label="min_p" placeholder="—" step="0.01" min={0} max={1} value={form.min_p} onChange={v => update('min_p', v)} disabled={busy}
                tooltip="Minimum-p sampling. Alternative plus stable à top_p. Ex : 0.05." />
              <NumberInput label="typical_p" placeholder="—" step="0.05" min={0} max={1} value={form.typical_p} onChange={v => update('typical_p', v)} disabled={busy}
                tooltip="Locally-typical sampling. 1.0 = désactivé." />
              <NumberInput label="tfs_z" placeholder="—" step="0.01" min={0} max={1} value={form.tfs_z} onChange={v => update('tfs_z', v)} disabled={busy}
                tooltip="Tail-free sampling. 1.0 = désactivé. Utile : 0.95–0.99." />
            </Section>
            <Section title="Pénalités" cols={3}>
              <NumberInput label="repeat_penalty" placeholder="—" step="0.05" min={0} value={form.repeat_penalty} onChange={v => update('repeat_penalty', v)} disabled={busy}
                tooltip="Pénalise les tokens récents. 1.0 = désactivé. 1.1–1.3 = classique." />
              <NumberInput label="frequency_penalty" placeholder="—" step="0.05" min={-2} max={2} value={form.frequency_penalty} onChange={v => update('frequency_penalty', v)} disabled={busy}
                tooltip="Standard OpenAI. Plage : -2 à 2." />
              <NumberInput label="presence_penalty" placeholder="—" step="0.05" min={-2} max={2} value={form.presence_penalty} onChange={v => update('presence_penalty', v)} disabled={busy}
                tooltip="Standard OpenAI. Favorise la diversité thématique." />
            </Section>
            <Section title="Mirostat" cols={3}>
              <NumberInput label="mirostat_mode" placeholder="— (0)" min={0} max={2} value={form.mirostat_mode} onChange={v => update('mirostat_mode', v)} disabled={busy}
                tooltip="0 = off. 1 = v1. 2 = v2 (recommandé). Remplace top_p/top_k." />
              <NumberInput label="mirostat_tau" placeholder="— (5.0)" step="0.5" min={0} value={form.mirostat_tau} onChange={v => update('mirostat_tau', v)} disabled={busy}
                tooltip="Entropie cible. Plus haut = plus créatif." />
              <NumberInput label="mirostat_eta" placeholder="— (0.1)" step="0.01" min={0} value={form.mirostat_eta} onChange={v => update('mirostat_eta', v)} disabled={busy}
                tooltip="Taux d'apprentissage Mirostat." />
            </Section>
            <Section title="Divers" cols={3}>
              <NumberInput label="seed" placeholder="— (-1)" min={-1} value={form.seed} onChange={v => update('seed', v)} disabled={busy}
                tooltip="-1 = aléatoire. Même seed + même prompt = résultat reproductible." />
              <NumberInput label="n_keep" placeholder="— (-1)" min={-1} value={form.n_keep} onChange={v => update('n_keep', v)} disabled={busy}
                tooltip="Tokens à préserver lors du ctx_shift. -1 = tout. 512 = system prompt." />
              <BooleanSwitch label="reasoning (enable_thinking)" checked={form.reasoning} onChange={v => update('reasoning', v)} disabled={busy}
                tooltip="Active le mode thinking via chat_template_kwargs.enable_thinking (Qwen3, Gemma-thinking, DeepSeek-R1)." />
              <BooleanSwitch label="cache prompt" checked={form.cache_prompt} onChange={v => update('cache_prompt', v)} disabled={busy}
                tooltip="Réutilisation du KV cache entre requêtes. Désactiver uniquement pour débug." />
              <NumberInput label="thinking_budget_low" placeholder="low" min={0} value={form.thinking_budget_low} onChange={v => update('thinking_budget_low', v)} disabled={busy}
                tooltip="Budget low (tokens) override per-model. Vide = config globale." />
              <NumberInput label="thinking_budget_medium" placeholder="med" min={0} value={form.thinking_budget_medium} onChange={v => update('thinking_budget_medium', v)} disabled={busy}
                tooltip="Budget medium override per-model." />
              <NumberInput label="thinking_budget_high" placeholder="high" min={-1} value={form.thinking_budget_high} onChange={v => update('thinking_budget_high', v)} disabled={busy}
                tooltip="Budget high override. -1 = illimité." />
            </Section>
          </>
        )}

        {tab === 'speculative' && (
          <>
            <Section title="Mode" cols={2}>
              <SelectInput label="spec_type" value={form.spec_type} onChange={v => update('spec_type', v)} disabled={busy}
                options={[
                  { value: '', label: '— (désactivé)' },
                  { value: 'mtp', label: 'mtp (mainline, draft-mtp)' },
                  { value: 'mtp-legacy', label: 'mtp-legacy (fork turboquant, deprecated)' },
                  { value: 'draft', label: 'draft (classique, draft-simple)' },
                  { value: 'ngram', label: 'ngram (ngram-simple)' },
                ]}
                tooltip="Type de spéculation. 'mtp' = PR mainline #22673 (mappé vers --spec-type draft-mtp). 'mtp-legacy' = fork atomic-llama-cpp-turboquant (deprecated). 'draft' = draft model classique." />
              <NumberInput label="spec_draft_n_max" placeholder="— (3)" min={1} max={16} value={form.spec_draft_n_max} onChange={v => update('spec_draft_n_max', v)} disabled={busy}
                tooltip="Nombre max de tokens drafted par cycle. Sweet spot Qwen3 = 3, Gemma 4 = 4-7." />
            </Section>
            <Section title="MTP (fork atomic-llama-cpp-turboquant)" cols={1}>
              <TextInput label="mtp_head" placeholder="/opt/llama-native-turboquant/share/assistants/...gguf"
                value={form.mtp_head} onChange={v => update('mtp_head', v)} disabled={busy}
                tooltip="--mtp-head <path> : chemin absolu du GGUF head MTP. Mode MTP embedded (mainline) → laisser vide." />
              <NumberInput label="draft_block_size" placeholder="— (3)" min={1} value={form.draft_block_size} onChange={v => update('draft_block_size', v)} disabled={busy}
                tooltip="Block size côté fork atomic-llama-cpp-turboquant." />
            </Section>
            <Section title="Draft model classique" cols={1}>
              <TextInput label="draft_model" placeholder="/path/to/draft-model.Q4_K_M.gguf"
                value={form.draft_model} onChange={v => update('draft_model', v)} disabled={busy}
                tooltip="-md <path> : GGUF d'un modèle draft (architecture compatible target). Sweet spot : draft ~10-20× plus petit que le target." />
            </Section>
            <Section title="Tuning draft" cols={3}>
              <NumberInput label="draft_n_gpu_layers" placeholder="— (999)" min={0} value={form.draft_n_gpu_layers} onChange={v => update('draft_n_gpu_layers', v)} disabled={busy}
                tooltip="-ngld : couches draft sur GPU." />
              <NumberInput label="draft_ctx_size" placeholder="— (= ctx_size)" min={0} value={form.draft_ctx_size} onChange={v => update('draft_ctx_size', v)} disabled={busy}
                tooltip="-cd : taille contexte draft." />
              <NumberInput label="draft_max" placeholder="— (16)" min={0} max={64} value={form.draft_max} onChange={v => update('draft_max', v)} disabled={busy}
                tooltip="--draft-max : max tokens drafted par étape." />
              <NumberInput label="draft_min" placeholder="— (0)" min={0} value={form.draft_min} onChange={v => update('draft_min', v)} disabled={busy}
                tooltip="--draft-min : min tokens avant vérification." />
              <NumberInput label="draft_p_min" placeholder="— (0.75)" step="0.05" min={0} max={1} value={form.draft_p_min} onChange={v => update('draft_p_min', v)} disabled={busy}
                tooltip="--draft-p-min : probabilité min d'acceptation (0-1). Plus haut = plus strict." />
            </Section>
          </>
        )}

        {tab === 'advanced' && (
          <>
            <Section title="Brut & env" cols={1}>
              <TextInput label="extra_args" placeholder="--poll 100 --numa distribute"
                value={form.extra_args} onChange={v => update('extra_args', v)} disabled={busy}
                tooltip="Arguments CLI supplémentaires pour llama-server, séparés par des espaces." />
              <TextareaInput label="env_vars (une ligne KEY=VAL)" rows={3}
                placeholder={'GGML_VK_DISABLE_F16=1\nLLAMA_LOG_PREFIX=1'}
                value={form.env_vars} onChange={v => update('env_vars', v)} disabled={busy}
                tooltip="Variables d'environnement injectées au process serveur. Ex: GGML_VK_DISABLE_F16=1." />
            </Section>
            <Section title="Chat template" cols={1}>
              <TextInput label="chat_template_file" placeholder="ex : gemma4-no-think.jinja"
                value={form.chat_template_file} onChange={v => update('chat_template_file', v)} disabled={busy} spellCheck={false}
                tooltip="--chat-template-file : override complet du template Jinja bundled. Chemin absolu ou nom sous ~/mercury/chat-templates/." />
              <TextareaInput label="chat_template_kwargs (JSON)" rows={4}
                placeholder={'{\n  "reasoning_effort": "low"\n}'}
                value={form.chat_template_kwargs_extra} onChange={v => update('chat_template_kwargs_extra', v)} disabled={busy} spellCheck={false}
                tooltip="Dict JSON passé au template Jinja. enable_thinking est géré par le toggle reasoning (onglet Sampling)." />
            </Section>
          </>
        )}
      </div>

      {/* Status */}
      {status && (
        <div
          className={clsx(
            'flex items-center gap-2 px-3 py-2 rounded-md text-[11px] border',
            status.ok
              ? 'bg-theme-green/5 text-theme-green border-theme-green/30'
              : 'bg-destructive/5 text-destructive border-destructive/30',
          )}
        >
          {status.ok ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
          <span>{status.msg}</span>
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center gap-2 pt-2 border-t border-border/40">
        <Button variant="primary" size="md" onClick={handleSave} disabled={busy}>
          {setMut.isPending ? <Spinner size={11} /> : <Save size={12} />}
          {setMut.isPending ? 'Sauvegarde…' : 'Sauvegarder'}
        </Button>
        <Button variant="subtle" size="md" onClick={handleReset} disabled={busy}>
          <RotateCcw size={12} /> Reset
        </Button>
        <Button variant="subtle" size="md" onClick={handleCopy} disabled={busy}>
          <Copy size={12} /> Copier
        </Button>
        <Button variant="subtle" size="md" onClick={handlePaste} disabled={busy || !clipboard}>
          <ClipboardPaste size={12} /> Coller
          {clipboard && <span className="ml-1 text-[9px] text-muted-foreground">depuis {clipboard.sourceModelId}</span>}
        </Button>
        <span className="flex-1" />
        <Button variant="destructive" size="md" onClick={handleDelete} disabled={busy || !existingTemplate}>
          {delMut.isPending ? <Spinner size={11} /> : <Trash2 size={12} />}
          Supprimer
        </Button>
      </div>
    </div>
  )
}
