import { useEffect, useState } from 'react'
import { X, Power, PowerOff, Pin, PinOff, Save as SaveIcon, Trash2, FileCode, ChartLine, ScrollText, Wand2 } from 'lucide-react'
import { clsx } from 'clsx'
import type { LlamacppModelEntry } from '../../../../api/admin'
import {
  useLoadLlamacppModelMutation,
  useUnloadLlamacppModelMutation,
  useBrainMemoryProtectMutation,
  useBrainMemoryUnprotectMutation,
  useSaveKvCacheMutation,
  useDeleteKvCacheMutation,
} from '../../../../api/queries'
import { Button } from '../../../ui/Button'
import { Badge, StatusDot } from '../../../ui/Badge'
import { Spinner } from '../../../ui/Spinner'
import { TemplateEditor } from './TemplateEditor'
import { InstanceLogs } from './InstanceLogs'

type DrawerTab = 'overview' | 'template' | 'logs'

const TABS: { id: DrawerTab; label: string; icon: typeof ChartLine }[] = [
  { id: 'overview', label: 'Aperçu',   icon: ChartLine },
  { id: 'template', label: 'Template', icon: FileCode },
  { id: 'logs',     label: 'Logs',     icon: ScrollText },
]

type MemoryInfo = {
  vram_delta_mb?: number
  ram_delta_mb?: number
  ram_estimated_mb?: number
  ram_rss_mb?: number
  protected?: boolean
  load_order?: number
  /** Live PID/port from the probe — fall back here if model.pid is missing. */
  pid?: number
  port?: number
}

export function ModelDrawer({
  model,
  memoryInfo,
  onClose,
  onMessage,
}: {
  model: LlamacppModelEntry
  memoryInfo?: MemoryInfo
  onClose: () => void
  onMessage: (msg: string, type: 'info' | 'error') => void
}) {
  const [tab, setTab] = useState<DrawerTab>('overview')

  const loadMut = useLoadLlamacppModelMutation()
  const unloadMut = useUnloadLlamacppModelMutation()
  const protectMut = useBrainMemoryProtectMutation()
  const unprotectMut = useBrainMemoryUnprotectMutation()
  const saveKvMut = useSaveKvCacheMutation()
  const deleteKvMut = useDeleteKvCacheMutation()
  const busy =
    loadMut.isPending || unloadMut.isPending ||
    protectMut.isPending || unprotectMut.isPending ||
    saveKvMut.isPending || deleteKvMut.isPending

  // Close on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleAction = async (mut: typeof loadMut, success: string) => {
    try {
      const res = await mut.mutateAsync(model.model_id)
      if (res.ok) {
        onMessage(success, 'info')
      } else {
        const b = res.body as Record<string, unknown> | undefined
        onMessage(String(b?.detail ?? b?.error ?? `Erreur ${res.status}`), 'error')
      }
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const hasConfiguredTemplate = Boolean(
    model.template &&
      ((model.template.load && Object.keys(model.template.load).length > 0) ||
       (model.template.defaults && Object.keys(model.template.defaults).length > 0))
  )
  const isProtected = model.protected === true || memoryInfo?.protected === true

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      {/* Drawer */}
      <aside
        className="fixed inset-y-0 right-0 z-50 w-full max-w-[760px] bg-card border-l border-border shadow-2xl flex flex-col animate-[slide-in-left_220ms_ease-out]"
        style={{ animation: 'slide-in-left 220ms ease-out reverse' }}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <header className="shrink-0 flex flex-col gap-2 px-5 py-4 border-b border-border bg-card">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-2">
                <StatusDot tone={model.running ? 'success' : 'muted'} pulse={model.running} />
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
                  {model.running ? 'En cours' : 'Inactif'}
                </span>
                {isProtected && <Badge tone="primary">PIN</Badge>}
                {hasConfiguredTemplate && <Badge tone="warning">TPL</Badge>}
                {model.kv_cache_exists && <Badge tone="success">KV</Badge>}
                {model.active_preset_name && (
                  <Badge tone="purple">
                    <Wand2 size={9} className="inline mr-1" />
                    {model.active_preset_name}
                  </Badge>
                )}
              </div>
              <h2 className="text-base font-semibold text-foreground tracking-tight m-0 break-all">
                {model.model_id}
              </h2>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/80 font-mono">
                {model.size_gb != null && <span>{model.size_gb.toFixed(1)} Go</span>}
                {model.running && model.ctx_size && <span>ctx {model.ctx_size.toLocaleString()}</span>}
                {model.running && model.port && <span>port {model.port}</span>}
                {memoryInfo?.vram_delta_mb != null && <span>VRAM Δ {(memoryInfo.vram_delta_mb / 1024).toFixed(1)} Go</span>}
                {memoryInfo?.ram_rss_mb != null && <span>RAM {(memoryInfo.ram_rss_mb / 1024).toFixed(1)} Go</span>}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              aria-label="Fermer"
            >
              <X size={16} />
            </button>
          </div>

          {/* Primary actions */}
          <div className="flex items-center gap-2 flex-wrap mt-1">
            {model.running ? (
              <Button
                variant="destructive"
                size="md"
                disabled={busy}
                onClick={() => handleAction(unloadMut, `"${model.model_id}" déchargé`)}
              >
                {unloadMut.isPending ? <Spinner size={11} /> : <PowerOff size={12} />}
                Décharger
              </Button>
            ) : (
              <Button
                variant="primary"
                size="md"
                disabled={busy}
                onClick={() => {
                  setTab('logs') // jump to logs while it loads
                  handleAction(loadMut, `"${model.model_id}" chargé`)
                }}
              >
                {loadMut.isPending ? <Spinner size={11} /> : <Power size={12} />}
                Charger
              </Button>
            )}
            <Button
              variant="subtle"
              size="md"
              disabled={busy}
              onClick={() => {
                if (isProtected) unprotectMut.mutate(model.model_id)
                else protectMut.mutate(model.model_id)
              }}
              title={isProtected
                ? 'Unpin : retire la protection brain-memory'
                : 'Pin : protège le modèle contre l\'éviction brain-memory'}
            >
              {isProtected ? <PinOff size={12} /> : <Pin size={12} />}
              {isProtected ? 'Unpin' : 'Pin'}
            </Button>
            {model.running && (
              <Button
                variant="subtle"
                size="md"
                disabled={busy}
                onClick={() => handleAction(saveKvMut, `KV cache sauvegardé pour "${model.model_id}"`)}
                title="Sauvegarder le KV cache courant (slot 0)"
              >
                {saveKvMut.isPending ? <Spinner size={11} /> : <SaveIcon size={12} />}
                Save KV
              </Button>
            )}
            {model.kv_cache_exists && (
              <Button
                variant="subtle"
                size="md"
                disabled={busy}
                onClick={() => handleAction(deleteKvMut, `KV cache supprimé pour "${model.model_id}"`)}
              >
                {deleteKvMut.isPending ? <Spinner size={11} /> : <Trash2 size={12} />}
                Delete KV
              </Button>
            )}
          </div>
        </header>

        {/* Tabs */}
        <div className="shrink-0 flex items-center gap-0.5 px-4 pt-2 border-b border-border/40 bg-card">
          {TABS.map(t => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={clsx(
                  'inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-widest border-b-2 transition-colors',
                  tab === t.id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon size={12} />
                {t.label}
              </button>
            )
          })}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {tab === 'overview' && (
            <DrawerOverview model={model} memoryInfo={memoryInfo} />
          )}
          {tab === 'template' && (
            <TemplateEditor modelId={model.model_id} existingTemplate={model.template} />
          )}
          {tab === 'logs' && (
            <InstanceLogs modelId={model.model_id} active={!!model.running || loadMut.isPending} />
          )}
        </div>
      </aside>
    </>
  )
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-background border border-border/40">
      <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
        {label}
      </span>
      <span className="text-[12px] font-mono tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function DrawerOverview({ model, memoryInfo }: { model: LlamacppModelEntry; memoryInfo?: MemoryInfo }) {
  // Fall back to the probe instance for live PID/port — the canonical
  // /admin/llamacpp/models payload doesn't always include them.
  const port = model.port ?? memoryInfo?.port ?? null
  const pid = model.pid ?? memoryInfo?.pid ?? null
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-foreground m-0">
          Fichier modèle
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <StatRow label="Taille" value={model.size_gb != null ? `${model.size_gb.toFixed(1)} Go` : '—'} />
          <StatRow label="Kind" value={model.kind ?? '—'} />
          <StatRow label="Backend" value={model.template?.load?.backend ?? 'native-vulkan'} />
        </div>
        {/* Chemin sur une row pleine largeur pour éviter le débordement. */}
        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-background border border-border/40 min-w-0">
          <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground shrink-0">
            Chemin
          </span>
          <span
            className="text-[11px] font-mono text-foreground truncate min-w-0 text-right"
            title={model.path ?? undefined}
          >
            {model.path ?? '—'}
          </span>
        </div>
      </section>

      {model.active_preset_name && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-foreground m-0 flex items-center gap-1.5">
            <Wand2 size={11} className="text-primary" />
            Preset AtlasMind assigné
          </h3>
          <div className="px-3 py-2 rounded-md bg-primary/5 border border-primary/30 flex items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[12px] font-semibold text-primary truncate" title={model.active_preset_name}>
                {model.active_preset_name}
              </span>
              <span className="text-[10px] text-muted-foreground/70 font-mono">
                preset #{model.active_preset_id ?? '?'} · cocktail control_vector
              </span>
            </div>
            <span
              className="text-[9px] uppercase tracking-widest text-muted-foreground/60 shrink-0 text-right max-w-[90px]"
              title={model.running
                ? 'Appliqué seulement au prochain chargement — l\'instance running garde son cocktail courant.'
                : 'Sera appliqué quand tu cliqueras Charger.'}
            >
              {model.running ? 'au prochain load' : 'au prochain load'}
            </span>
          </div>
        </section>
      )}

      {model.running && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-foreground m-0">
            Instance running
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <StatRow label="Port" value={port ?? '—'} />
            <StatRow label="PID" value={pid ?? '—'} />
            <StatRow label="Context size" value={model.ctx_size?.toLocaleString() ?? '—'} />
            <StatRow label="Load order" value={memoryInfo?.load_order ?? '—'} />
          </div>
        </section>
      )}

      {memoryInfo && (memoryInfo.vram_delta_mb != null || memoryInfo.ram_rss_mb != null) && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-foreground m-0">
            Empreinte mémoire
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <StatRow label="VRAM Δ" value={memoryInfo.vram_delta_mb != null ? `${(memoryInfo.vram_delta_mb / 1024).toFixed(2)} Go` : '—'} />
            <StatRow label="RAM RSS" value={memoryInfo.ram_rss_mb != null ? `${(memoryInfo.ram_rss_mb / 1024).toFixed(2)} Go` : '—'} />
            <StatRow label="RAM Δ" value={memoryInfo.ram_delta_mb != null ? `${(memoryInfo.ram_delta_mb / 1024).toFixed(2)} Go` : '—'} />
            <StatRow label="Protected" value={memoryInfo.protected ? 'oui' : 'non'} />
          </div>
        </section>
      )}

      <p className="text-[10px] text-muted-foreground/60 mt-2">
        Onglet <code className="font-mono px-1 rounded bg-secondary text-foreground">Template</code> pour éditer les paramètres de chargement et de sampling · onglet <code className="font-mono px-1 rounded bg-secondary text-foreground">Logs</code> pour voir le SSE du daemon llama-server pendant chargement et runtime.
      </p>
    </div>
  )
}
