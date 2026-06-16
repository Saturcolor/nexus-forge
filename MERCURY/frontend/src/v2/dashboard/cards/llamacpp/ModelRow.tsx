import { useState, useRef, useEffect } from 'react'
import { Power, PowerOff, MoreVertical, Pin, ChevronRight, Tag, Eye, EyeOff, Save, Trash2, Wand2 } from 'lucide-react'
import { clsx } from 'clsx'
import type { LlamacppModelEntry, AtlasPreset } from '../../../../api/admin'
import {
  useLoadLlamacppModelMutation,
  useUnloadLlamacppModelMutation,
  useBrainMemoryProtectMutation,
  useBrainMemoryUnprotectMutation,
  useSaveKvCacheMutation,
  useDeleteKvCacheMutation,
  useSetHiddenModelMutation,
  useSetModelCategoryMutation,
  useAtlasPresets,
  useApplyAtlasPresetMutation,
  useApplyAtlasPresetsMutation,
  useClearAtlasPresetMutation,
} from '../../../../api/queries'
import { Badge, StatusDot } from '../../../ui/Badge'
import { Button } from '../../../ui/Button'
import { Spinner } from '../../../ui/Spinner'

type MemoryInfo = {
  vram_delta_mb?: number
  ram_delta_mb?: number
  ram_rss_mb?: number
  protected?: boolean
  load_order?: number
}

/** Label lisible pour un LoRA du stack : nom du preset si on a pu le matcher
 *  par brain_path, sinon le basename du .gguf (fallback sans plomberie). */
function loraLabel(path: string, nameByPath?: Map<string, string>): string {
  const matched = nameByPath?.get(path)
  if (matched) return matched
  const base = path.split('/').pop() ?? path
  return base.replace(/\.gguf$/i, '')
}

export function ModelRow({
  model,
  category,
  categoryOptions,
  isHidden,
  memoryInfo,
  tps,
  loraNameByPath,
  onOpenDrawer,
  onMessage,
}: {
  model: LlamacppModelEntry
  category?: string
  categoryOptions: string[]
  isHidden?: boolean
  memoryInfo?: MemoryInfo
  tps?: number | null
  /** Map brain_path → nom de preset, construite une fois par le parent pour
   *  étiqueter chaque LoRA du stack sans refetch par card. */
  loraNameByPath?: Map<string, string>
  onOpenDrawer: () => void
  onMessage: (msg: string, type: 'info' | 'error') => void
}) {
  const loadMut = useLoadLlamacppModelMutation()
  const unloadMut = useUnloadLlamacppModelMutation()
  const protectMut = useBrainMemoryProtectMutation()
  const unprotectMut = useBrainMemoryUnprotectMutation()
  const saveKvMut = useSaveKvCacheMutation()
  const deleteKvMut = useDeleteKvCacheMutation()
  const setHiddenMut = useSetHiddenModelMutation()
  const setCategoryMut = useSetModelCategoryMutation()
  const applyPresetMut = useApplyAtlasPresetMutation()
  const applyPresetsMut = useApplyAtlasPresetsMutation()
  const clearPresetMut = useClearAtlasPresetMutation()
  const busy = loadMut.isPending || unloadMut.isPending || applyPresetMut.isPending || applyPresetsMut.isPending || clearPresetMut.isPending

  // Cache mutations (hide / category) target the backend-prefixed identifier —
  // the same key used to read these fields back from /admin/cache/models.
  const cacheKey = `llamacpp/${model.model_id}`

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  // The `protected` flag is exposed both on the model entry (persisted) and on
  // the probe instance (live brain-memory). Use either signal so pin works
  // even when the model is idle.
  const isProtected = model.protected === true || memoryInfo?.protected === true
  const hasConfiguredTemplate = Boolean(
    model.template &&
      ((model.template.load && Object.keys(model.template.load).length > 0) ||
       (model.template.defaults && Object.keys(model.template.defaults).length > 0))
  )

  const handleAction = async (mut: typeof loadMut, success: string) => {
    try {
      const res = await mut.mutateAsync(model.model_id)
      if (res.ok) onMessage(success, 'info')
      else {
        const b = res.body as Record<string, unknown> | undefined
        onMessage(String(b?.detail ?? b?.error ?? `Erreur ${res.status}`), 'error')
      }
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  return (
    <li
      className={clsx(
        'group flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors',
        model.running
          ? 'bg-theme-green/5 border-theme-green/30'
          : 'bg-background border-border/40 hover:border-border hover:bg-secondary/30',
        isHidden && 'opacity-50',
      )}
    >
      {/* Status dot */}
      <StatusDot
        tone={model.running ? 'success' : 'muted'}
        pulse={model.running}
      />

      {/* Main column: name + meta */}
      <button
        type="button"
        onClick={onOpenDrawer}
        className="flex-1 min-w-0 text-left"
        title="Voir le détail"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-foreground truncate" title={model.model_id}>
            {model.model_id}
          </span>
          {isProtected && <Pin size={10} className="text-primary shrink-0" />}
          {category && <Badge tone="purple">{category}</Badge>}
          {hasConfiguredTemplate && <Badge tone="warning">TPL</Badge>}
          {model.kv_cache_exists && <Badge tone="success">KV</Badge>}
          {/* Stack LoRA : index = id côté llama-server (= slider Mastermind).
            * On affiche "0·nom 1·nom" plutôt que le composite "a + b" du preset
            * name, qui inclut les presets CV-only sans LoRA et fausserait le
            * mapping d'index. Fallback sur le badge preset quand pas de LoRA. */}
          {model.loras && model.loras.length > 0 ? (
            model.loras.map((l, i) => (
              <Badge
                key={`${i}-${l.path}`}
                tone="purple"
                title={`LoRA id ${i} (= slider Mastermind)\n${l.path}\nscale par défaut ×${(l.default_scale ?? 1).toFixed(2)}`}
              >
                <span className="font-mono font-bold mr-1 opacity-80">{i}·</span>
                {loraLabel(l.path, loraNameByPath)}
              </Badge>
            ))
          ) : model.active_preset_name ? (
            <Badge tone="purple">
              <Wand2 size={9} className="inline mr-1" />
              {model.active_preset_name}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] font-mono text-muted-foreground/70 mt-0.5">
          {model.size_gb != null && <span>{model.size_gb.toFixed(1)} Go</span>}
          {model.running && model.ctx_size && <span>ctx {model.ctx_size.toLocaleString()}</span>}
          {model.running && tps != null && <span className="text-theme-green">{tps.toFixed(1)} tok/s</span>}
          {memoryInfo?.vram_delta_mb != null && (
            <span>VRAM Δ {(memoryInfo.vram_delta_mb / 1024).toFixed(1)} Go</span>
          )}
          {memoryInfo?.ram_rss_mb != null && (
            <span>RAM {(memoryInfo.ram_rss_mb / 1024).toFixed(1)} Go</span>
          )}
        </div>
      </button>

      {/* Primary action: Load/Unload */}
      {model.running ? (
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={() => handleAction(unloadMut, `"${model.model_id}" déchargé`)}
        >
          {unloadMut.isPending ? <Spinner size={10} /> : <PowerOff size={11} />}
          Décharger
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => handleAction(loadMut, `"${model.model_id}" chargé`)}
        >
          {loadMut.isPending ? <Spinner size={10} /> : <Power size={11} />}
          Charger
        </Button>
      )}

      {/* Kebab menu */}
      <div className="relative shrink-0" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen(o => !o)}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          aria-label="Plus d'actions"
        >
          <MoreVertical size={14} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 z-30 min-w-[220px] py-1 rounded-md border border-border bg-card shadow-xl">
            <MenuItem
              icon={<Pin size={12} />}
              label={isProtected ? 'Unpin (brain memory)' : 'Pin (protéger en mémoire)'}
              onClick={() => {
                const mut = isProtected ? unprotectMut : protectMut
                const verb = isProtected ? 'déprotégé' : 'protégé'
                mut.mutate(model.model_id, {
                  onSuccess: () => onMessage(`Modèle ${verb} en mémoire`, 'info'),
                  onError: e => onMessage(e instanceof Error ? e.message : String(e), 'error'),
                })
                setMenuOpen(false)
              }}
            />
            {model.running && (
              <MenuItem
                icon={<Save size={12} />}
                label="Save KV cache"
                onClick={() => {
                  handleAction(saveKvMut, `KV cache sauvegardé`)
                  setMenuOpen(false)
                }}
              />
            )}
            {model.kv_cache_exists && (
              <MenuItem
                icon={<Trash2 size={12} />}
                label="Delete KV cache"
                onClick={() => {
                  handleAction(deleteKvMut, `KV cache supprimé`)
                  setMenuOpen(false)
                }}
              />
            )}
            <div className="my-1 border-t border-border/60" />
            {/* Preset = config persistante du modèle. Sélection = écrit
             * load_configs côté brain, sans loader. Si le modèle tourne déjà,
             * son cocktail courant reste actif jusqu'au prochain unload+load. */}
            <PresetSubmenu
              modelId={model.model_id}
              activePresetIds={
                model.active_preset_ids
                  ?? (model.active_preset_id != null ? [model.active_preset_id] : [])
              }
              modelRunning={model.running === true}
              menuOpen={menuOpen}
              onApply={presetIds => {
                applyPresetsMut.mutate(
                  { model_id: model.model_id, preset_ids: presetIds },
                  {
                    onSuccess: () => onMessage(
                      model.running
                        ? `${presetIds.length} preset(s) assigné(s) — prend effet au prochain rechargement`
                        : `${presetIds.length} preset(s) assigné(s) — appliqué(s) au chargement`,
                      'info',
                    ),
                    onError: e => onMessage(e instanceof Error ? e.message : String(e), 'error'),
                  },
                )
                setMenuOpen(false)
              }}
              onClear={() => {
                clearPresetMut.mutate(model.model_id, {
                  onSuccess: () => onMessage(
                    model.running
                      ? 'Presets retirés — prend effet au prochain rechargement'
                      : 'Presets retirés',
                    'info',
                  ),
                  onError: e => onMessage(e instanceof Error ? e.message : String(e), 'error'),
                })
                setMenuOpen(false)
              }}
            />
            <div className="my-1 border-t border-border/60" />
            <CategorySubmenu
              currentCategory={category}
              categoryOptions={categoryOptions}
              onSelect={cat => {
                setCategoryMut.mutate(
                  { modelName: cacheKey, category: cat },
                  {
                    onSuccess: () => onMessage(cat ? `Tag « ${cat} » appliqué` : 'Tag retiré', 'info'),
                    onError: e => onMessage(e instanceof Error ? e.message : String(e), 'error'),
                  },
                )
                setMenuOpen(false)
              }}
            />
            <MenuItem
              icon={isHidden ? <Eye size={12} /> : <EyeOff size={12} />}
              label={isHidden ? 'Afficher dans la liste' : 'Masquer dans la liste'}
              onClick={() => {
                setHiddenMut.mutate(
                  { modelName: cacheKey, hidden: !isHidden },
                  {
                    onSuccess: () => onMessage(isHidden ? 'Modèle affiché' : 'Modèle masqué', 'info'),
                    onError: e => onMessage(e instanceof Error ? e.message : String(e), 'error'),
                  },
                )
                setMenuOpen(false)
              }}
            />
          </div>
        )}
      </div>

      {/* Open drawer chevron */}
      <button
        type="button"
        onClick={onOpenDrawer}
        className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-secondary transition-colors"
        title="Voir le détail"
        aria-label="Ouvrir détail"
      >
        <ChevronRight size={14} />
      </button>
    </li>
  )
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-foreground hover:bg-secondary text-left transition-colors"
    >
      <span className="text-muted-foreground/70">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

function PresetSubmenu({
  modelId,
  activePresetIds,
  modelRunning,
  menuOpen,
  onApply,
  onClear,
}: {
  modelId: string
  /** Liste exhaustive des presets assignés (multi-select). Vide = aucun. */
  activePresetIds: number[]
  modelRunning: boolean
  menuOpen: boolean
  /** Multi : applique la liste cochée. Vide → caller appelle onClear à la place. */
  onApply: (presetIds: number[]) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  // Sélection multi locale : initialisée depuis activePresetIds quand le panel s'ouvre.
  // Pattern set-via-button (pas live) pour éviter qu'un check transitoire trigger N applies.
  const [selected, setSelected] = useState<Set<number>>(() => new Set(activePresetIds))
  // Resync quand activePresetIds change (autre onglet / refetch /mgmt/status).
  // Et reset à chaque ouverture pour ne pas porter une sélection abandonnée.
  useEffect(() => {
    if (open) setSelected(new Set(activePresetIds))
  }, [open, activePresetIds])

  // Lazy fetch : on n'interroge AtlasMind que si le kebab est ouvert ET que
  // le user a déplié la section preset (évite N requêtes au mount du dashboard).
  const presetsQ = useAtlasPresets(modelId, menuOpen && open)
  const presets = (presetsQ.data?.presets ?? []).filter((p: AtlasPreset) => p.exportable)

  const activeSet = new Set(activePresetIds)
  const selectedArr = [...selected]
  const dirty = selectedArr.length !== activePresetIds.length
    || selectedArr.some(id => !activeSet.has(id))
    || activePresetIds.some(id => !selected.has(id))

  const toggle = (pid: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      return next
    })
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-foreground hover:bg-secondary text-left transition-colors"
        title={modelRunning
          ? 'Assigner des presets — prend effet au prochain chargement (le cocktail actuel n\'est pas changé)'
          : 'Assigner des presets — appliqués quand tu cliques Charger'}
      >
        <Wand2 size={12} className="text-muted-foreground/70" />
        <span className="flex-1">Preset{activePresetIds.length > 1 ? 's' : ''}</span>
        <span className="text-[10px] text-muted-foreground/70 font-mono truncate max-w-[120px]">
          {activePresetIds.length === 0
            ? 'aucun'
            : activePresetIds.length === 1
              ? `#${activePresetIds[0]}`
              : `${activePresetIds.length} cochés`}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 flex flex-col gap-1 bg-background/40 border-t border-border/30 max-h-72 overflow-y-auto">
          {presetsQ.isLoading && (
            <div className="text-[10px] text-muted-foreground/60 px-2 py-1">Chargement…</div>
          )}
          {presetsQ.isError && (
            <div className="text-[10px] text-red-400 px-2 py-1">
              Erreur AtlasMind : {(presetsQ.error as Error)?.message ?? 'inconnue'}
            </div>
          )}
          {!presetsQ.isLoading && !presetsQ.isError && presets.length === 0 && (
            <div className="text-[10px] text-muted-foreground/60 px-2 py-1">
              Aucun preset pour ce modèle
            </div>
          )}
          {presets.map(preset => {
            const isChecked = selected.has(preset.id)
            const isActive = activeSet.has(preset.id)
            return (
              <label
                key={preset.id}
                className={clsx(
                  'flex items-start gap-2 text-[11px] px-2 py-1 rounded cursor-pointer transition-colors',
                  isChecked ? 'bg-primary/10' : 'hover:bg-secondary',
                )}
                title={preset.description || preset.name}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(preset.id)}
                  className="mt-0.5 accent-primary"
                />
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <span className={clsx('truncate', isChecked && 'font-semibold text-foreground')}>
                    {preset.name}
                  </span>
                  {isActive && !isChecked && (
                    <span className="text-[9px] text-amber-400 shrink-0" title="Actuellement assigné — sera retiré au prochain Apply">
                      (assigné)
                    </span>
                  )}
                  <span className="ml-auto text-[9px] font-mono shrink-0 flex items-center gap-1">
                    {preset.control_vectors.length > 0 && (
                      <span className="text-muted-foreground/60">
                        {preset.control_vectors.length}cv
                        {preset.layer_range && ` L${preset.layer_range[0]}-${preset.layer_range[1]}`}
                      </span>
                    )}
                    {preset.lora_path && preset.control_vectors.length > 0 && (
                      <span className="text-muted-foreground/40">+</span>
                    )}
                    {preset.lora_path && (
                      <span
                        className="text-violet-400"
                        title={`LoRA ${preset.lora_path}\nscale ×${(preset.lora_scale ?? 1).toFixed(2)}`}
                      >
                        LoRA×{(preset.lora_scale ?? 1).toFixed(1)}
                      </span>
                    )}
                  </span>
                </div>
              </label>
            )
          })}
          {/* Action bar : Apply (multi) ou Clear (vide). Disabled si pas de changement. */}
          {presets.length > 0 && (
            <div className="flex items-center gap-1.5 pt-1 mt-1 border-t border-border/30">
              <button
                type="button"
                onClick={() => {
                  if (selectedArr.length === 0) {
                    onClear()
                  } else {
                    onApply(selectedArr)
                  }
                  setOpen(false)
                }}
                disabled={!dirty}
                className={clsx(
                  'flex-1 text-[11px] font-medium px-2 py-1 rounded transition-colors',
                  dirty
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-secondary/40 text-muted-foreground/60 cursor-not-allowed',
                )}
                title={selectedArr.length === 0
                  ? 'Retirer tous les presets'
                  : `Appliquer ${selectedArr.length} preset(s) — leurs LoRAs seront stack côté brain dans l'ordre`}
              >
                {selectedArr.length === 0 ? '✕ Retirer tout' : `Appliquer (${selectedArr.length})`}
              </button>
              {activePresetIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => { onClear(); setOpen(false) }}
                  className="text-[10px] text-amber-400 hover:text-amber-300 px-2 py-1 rounded hover:bg-secondary transition-colors"
                  title="Retirer tous les presets assignés"
                >
                  Reset
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CategorySubmenu({
  currentCategory,
  categoryOptions,
  onSelect,
}: {
  currentCategory?: string
  categoryOptions: string[]
  onSelect: (cat: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [newTag, setNewTag] = useState('')
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-foreground hover:bg-secondary text-left transition-colors"
      >
        <Tag size={12} className="text-muted-foreground/70" />
        <span className="flex-1">Tag</span>
        <span className="text-[10px] text-muted-foreground/70 font-mono">
          {currentCategory ?? 'sans tag'}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 flex flex-col gap-1 bg-background/40 border-t border-border/30">
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={clsx(
              'text-left text-[11px] px-2 py-1 rounded hover:bg-secondary',
              !currentCategory && 'text-primary font-semibold',
            )}
          >
            sans tag
          </button>
          {categoryOptions.map(cat => (
            <button
              key={cat}
              type="button"
              onClick={() => onSelect(cat)}
              className={clsx(
                'text-left text-[11px] px-2 py-1 rounded hover:bg-secondary',
                cat === currentCategory && 'text-primary font-semibold',
              )}
            >
              {cat}
            </button>
          ))}
          <form
            onSubmit={e => {
              e.preventDefault()
              const v = newTag.trim()
              if (v) {
                onSelect(v)
                setNewTag('')
                setOpen(false)
              }
            }}
            className="flex items-center gap-1 mt-1"
          >
            <input
              type="text"
              value={newTag}
              onChange={e => setNewTag(e.target.value)}
              placeholder="nouveau tag…"
              className="flex-1 min-w-0 px-2 py-1 text-[11px] bg-background border border-border/60 rounded text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/30"
            />
            <button
              type="submit"
              className="px-2 py-1 text-[10px] font-semibold bg-primary/15 text-primary border border-primary/30 rounded hover:bg-primary/25"
            >
              +
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
