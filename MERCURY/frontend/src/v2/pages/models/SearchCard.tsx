import { useMemo, useState } from 'react'
import { Search, ChevronDown, Download, X } from 'lucide-react'
import { clsx } from 'clsx'
import {
  useHfSearch, useHfRepoFiles,
  useStartHfDownloadMutation, useStartHfDownloadBatchMutation,
} from '../../../api/queries'
import type { HfModelSummary, HfSortKey, HfFile } from '../../../api/admin'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'

// ── Constants ────────────────────────────────────────────────────────────────

type SizeBucket = 'all' | 'lt10' | '10to30' | '30to50' | '50to100' | 'gt100'

const SIZE_BUCKETS: { id: SizeBucket; label: string; match: (b: number | null) => boolean }[] = [
  { id: 'all',      label: 'Toutes',  match: () => true },
  { id: 'lt10',     label: '< 10B',   match: b => b !== null && b < 10 },
  { id: '10to30',   label: '10–30B',  match: b => b !== null && b >= 10 && b < 30 },
  { id: '30to50',   label: '30–50B',  match: b => b !== null && b >= 30 && b < 50 },
  { id: '50to100',  label: '50–100B', match: b => b !== null && b >= 50 && b < 100 },
  { id: 'gt100',    label: '> 100B',  match: b => b !== null && b >= 100 },
]

const TAG_CHIPS = [
  { id: 'uncensored',  label: 'uncensored',  keywords: ['uncensored', 'heretic'] },
  { id: 'abliterated', label: 'abliterated', keywords: ['abliterated'] },
  { id: 'thinking',    label: 'thinking',    keywords: ['thinking'] },
  { id: 'reasoning',   label: 'reasoning',   keywords: ['reasoning', 'reason', 'cot'] },
  { id: 'deckard',     label: 'deckard',     keywords: ['deckard'] },
  { id: 'distill',     label: 'distill',     keywords: ['distill', 'distilled'] },
]

const SORT_OPTIONS: { id: HfSortKey; label: string }[] = [
  { id: 'downloads',     label: 'Téléchargements' },
  { id: 'likes',         label: 'Likes' },
  { id: 'last_modified', label: 'Récents' },
]

const QUANT_ORDER = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q5_K_S', 'Q4_K_M', 'Q4_K_S', 'Q3_K_M', 'Q3_K_S', 'Q2_K', 'F16', 'BF16', 'F32']
const SHARD_RE = /-\d{5}-of-\d{5}\.gguf$/i

// ── Utils ────────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtSize(n: number): string {
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function extractSizeB(repoId: string): number | null {
  const m = repoId.match(/(?:^|[^a-zA-Z0-9])(\d+(?:\.\d+)?)[bB](?![a-zA-Z0-9])/)
  return m ? parseFloat(m[1]) : null
}

function matchesChips(repoId: string, tags: string[], selected: Set<string>): boolean {
  if (selected.size === 0) return true
  const hay = (repoId + ' ' + tags.join(' ')).toLowerCase()
  for (const chipId of selected) {
    const chip = TAG_CHIPS.find(c => c.id === chipId)
    if (!chip) continue
    if (!chip.keywords.some(kw => hay.includes(kw))) return false
  }
  return true
}

type DisplayItem =
  | { type: 'single'; file: HfFile }
  | { type: 'shard'; basePath: string; files: HfFile[]; totalSize: number }

function buildDisplayItems(files: HfFile[]): DisplayItem[] {
  const shardMap = new Map<string, HfFile[]>()
  const items: DisplayItem[] = []
  for (const f of files) {
    if (f.is_shard) {
      const base = f.path.replace(SHARD_RE, '')
      if (!shardMap.has(base)) shardMap.set(base, [])
      shardMap.get(base)!.push(f)
    } else {
      items.push({ type: 'single', file: f })
    }
  }
  for (const [base, shards] of shardMap) {
    items.push({
      type: 'shard',
      basePath: base,
      files: shards.sort((a, b) => a.path.localeCompare(b.path)),
      totalSize: shards.reduce((s, f) => s + f.size, 0),
    })
  }
  return items
}

// ── RepoFilesDrawer ──────────────────────────────────────────────────────────

function RepoFilesDrawer({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const { data, isLoading, error } = useHfRepoFiles(repoId, true)
  const startMut  = useStartHfDownloadMutation()
  const batchMut  = useStartHfDownloadBatchMutation()

  const groups: Record<string, HfFile[]> = {}
  for (const f of data?.files ?? []) {
    const key = f.quant ?? (f.path.toLowerCase().includes('mmproj') ? 'MMPROJ' : 'OTHER')
    if (!groups[key]) groups[key] = []
    groups[key].push(f)
  }
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const ia = QUANT_ORDER.indexOf(a)
    const ib = QUANT_ORDER.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })

  return (
    <div className="mt-1 border-l-2 border-primary/40 bg-background/60 rounded-r-lg px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <code className="text-[10px] font-mono text-muted-foreground">{repoId}</code>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground/50 hover:text-foreground transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      {isLoading && <div className="flex justify-center py-3"><Spinner /></div>}
      {error && <p className="text-[11px] text-destructive">Erreur : {(error as Error).message}</p>}
      {data && data.files.length === 0 && (
        <p className="text-[11px] text-muted-foreground/50">Aucun fichier GGUF dans ce repo.</p>
      )}

      {sortedKeys.map(quant => {
        const items = buildDisplayItems(groups[quant])
        return (
          <div key={quant} className="flex flex-col gap-1">
            <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">{quant}</span>
            {items.map(item =>
              item.type === 'single' ? (
                <div key={item.file.path} className="flex items-center gap-2 px-2 py-1.5 bg-background border border-border/40 rounded-md">
                  <div className="flex flex-col min-w-0 flex-1">
                    <code className="text-[10px] font-mono text-foreground truncate" title={item.file.path}>{item.file.path}</code>
                    <span className="text-[9px] text-muted-foreground/50">{fmtSize(item.file.size)}</span>
                  </div>
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => startMut.mutate({ repo_id: repoId, filename: item.file.path })}
                    disabled={startMut.isPending}
                  >
                    <Download size={10} />
                    Télécharger
                  </Button>
                </div>
              ) : (
                <div key={item.basePath} className="flex items-center gap-2 px-2 py-1.5 bg-background border border-border/40 rounded-md">
                  <div className="flex flex-col min-w-0 flex-1">
                    <code className="text-[10px] font-mono text-foreground truncate" title={item.basePath}>{item.basePath}.gguf</code>
                    <span className="text-[9px] text-muted-foreground/50">{fmtSize(item.totalSize)} · {item.files.length} shards</span>
                  </div>
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => batchMut.mutate({ repo_id: repoId, filenames: item.files.map(f => f.path) })}
                    disabled={batchMut.isPending}
                  >
                    <Download size={10} />
                    {item.files.length} shards
                  </Button>
                </div>
              )
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── ModelRow ─────────────────────────────────────────────────────────────────

function ModelRow({ model, expanded, onToggle }: {
  model: HfModelSummary
  expanded: boolean
  onToggle: () => void
}) {
  const size = extractSizeB(model.repo_id)
  return (
    <div className="border border-border/40 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-2 bg-background/60">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
        >
          <ChevronDown
            size={11}
            className={clsx('text-muted-foreground/60 shrink-0 transition-transform duration-150', !expanded && '-rotate-90')}
          />
          <div className="flex flex-col min-w-0">
            <code className="text-[11px] font-mono text-foreground truncate" title={model.repo_id}>
              {model.repo_id}
            </code>
            <span className="text-[10px] text-muted-foreground/60">
              ↓ {fmtNum(model.downloads)} · ♥ {fmtNum(model.likes)}
              {model.last_modified ? ` · ${model.last_modified.slice(0, 10)}` : ''}
            </span>
          </div>
        </button>
        <div className="flex items-center gap-1.5 shrink-0">
          {size !== null && <Badge tone="muted" mono>{size}B</Badge>}
          {model.gated && <Badge tone="warning">gated</Badge>}
        </div>
      </div>
      {expanded && <RepoFilesDrawer repoId={model.repo_id} onClose={onToggle} />}
    </div>
  )
}

// ── SearchCard ───────────────────────────────────────────────────────────────

export function SearchCard() {
  const [query,  setQuery]  = useState('')
  const [author, setAuthor] = useState('')
  const [submitted, setSubmitted] = useState<{ q: string; author: string; sort: HfSortKey; ggufOnly: boolean } | null>(null)

  const [ggufOnly,       setGgufOnly]       = useState(true)
  const [sortKey,        setSortKey]        = useState<HfSortKey>('downloads')
  const [sizeBucket,     setSizeBucket]     = useState<SizeBucket>('all')
  const [selectedChips,  setSelectedChips]  = useState<Set<string>>(new Set())
  const [expanded,       setExpanded]       = useState<string | null>(null)

  const { data, isFetching, error } = useHfSearch(submitted ?? {}, !!submitted)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    const a = author.trim()
    if (q.length < 2 && a.length < 2) return
    setSubmitted({ q, author: a, sort: sortKey, ggufOnly })
    setExpanded(null)
  }

  const changeSort = (s: HfSortKey) => {
    setSortKey(s)
    if (submitted) setSubmitted({ ...submitted, sort: s })
  }

  const changeGguf = (g: boolean) => {
    setGgufOnly(g)
    if (submitted) setSubmitted({ ...submitted, ggufOnly: g })
  }

  const toggleChip = (chipId: string) => {
    setSelectedChips(prev => {
      const next = new Set(prev)
      if (next.has(chipId)) next.delete(chipId)
      else next.add(chipId)
      return next
    })
  }

  const filtered = useMemo<HfModelSummary[]>(() => {
    if (!data) return []
    const sizeMatch = SIZE_BUCKETS.find(b => b.id === sizeBucket)?.match ?? (() => true)
    return data.filter(m => {
      const size = extractSizeB(m.repo_id)
      if (sizeBucket !== 'all' && !sizeMatch(size)) return false
      if (!matchesChips(m.repo_id, m.tags, selectedChips)) return false
      return true
    })
  }, [data, sizeBucket, selectedChips])

  const canSearch = query.trim().length >= 2 || author.trim().length >= 2

  return (
    <Card>
      <CardHeader
        title="Recherche HuggingFace"
        icon={<Search size={13} />}
        right={
          data && filtered.length > 0
            ? <span className="text-[10px] text-muted-foreground/60 font-mono">{filtered.length}{filtered.length !== data.length ? ` / ${data.length}` : ''}</span>
            : undefined
        }
      />
      <CardBody className="!py-4 flex flex-col gap-3">

        {/* Search form */}
        <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Recherche (ex: gemma-4 deckard)"
              className="w-full pl-7 pr-2.5 py-1.5 bg-background border border-border/60 rounded-md text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40"
            />
          </div>
          <input
            type="text"
            value={author}
            onChange={e => setAuthor(e.target.value)}
            placeholder="Auteur (ex: DavidAU)"
            className="w-36 px-2.5 py-1.5 bg-background border border-border/60 rounded-md text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40"
          />
          <Button type="submit" variant="primary" size="sm" disabled={!canSearch || isFetching}>
            {isFetching ? 'Recherche…' : 'Chercher'}
          </Button>
        </form>

        {/* Options */}
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={ggufOnly}
              onChange={e => changeGguf(e.target.checked)}
              className="accent-primary"
            />
            GGUF seulement
          </label>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>Tri :</span>
            <select
              value={sortKey}
              onChange={e => changeSort(e.target.value as HfSortKey)}
              className="px-2 py-1 bg-background border border-border/60 rounded text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30 cursor-pointer"
            >
              {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {/* Size filter */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mr-1">Taille</span>
          {SIZE_BUCKETS.map(b => (
            <button
              key={b.id}
              type="button"
              onClick={() => setSizeBucket(b.id)}
              className={clsx(
                'px-2 py-1 text-[10px] rounded border transition-colors font-medium',
                sizeBucket === b.id
                  ? 'bg-primary/10 text-primary border-primary/30'
                  : 'bg-background text-muted-foreground border-border/60 hover:text-foreground hover:border-border',
              )}
            >
              {b.label}
            </button>
          ))}
        </div>

        {/* Tag chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mr-1">Tags</span>
          {TAG_CHIPS.map(chip => {
            const active = selectedChips.has(chip.id)
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => toggleChip(chip.id)}
                className={clsx(
                  'px-2 py-1 text-[10px] rounded border transition-colors font-mono',
                  active
                    ? 'bg-theme-green/10 text-theme-green border-theme-green/30'
                    : 'bg-background text-muted-foreground border-border/60 hover:text-foreground hover:border-border',
                )}
              >
                {chip.label}
              </button>
            )
          })}
          {selectedChips.size > 0 && (
            <button
              type="button"
              onClick={() => setSelectedChips(new Set())}
              className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground ml-1"
            >
              <X size={9} /> Effacer
            </button>
          )}
        </div>

        {/* Results */}
        {error && (
          <p className="text-[11px] text-destructive">Erreur : {(error as Error).message}</p>
        )}

        {!submitted && !isFetching && (
          <p className="text-[11px] text-muted-foreground/40 text-center py-6">
            Lance une recherche pour explorer HuggingFace.
          </p>
        )}

        {submitted && !isFetching && data && data.length === 0 && (
          <p className="text-[11px] text-muted-foreground/50 py-4 text-center">Aucun résultat HuggingFace.</p>
        )}

        {submitted && !isFetching && data && data.length > 0 && filtered.length === 0 && (
          <p className="text-[11px] text-theme-amber py-4 text-center">
            {data.length} résultat(s) HuggingFace, aucun ne correspond aux filtres Taille/Tags.
          </p>
        )}

        {filtered.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {filtered.map(m => (
              <ModelRow
                key={m.repo_id}
                model={m}
                expanded={expanded === m.repo_id}
                onToggle={() => setExpanded(expanded === m.repo_id ? null : m.repo_id)}
              />
            ))}
          </div>
        )}

      </CardBody>
    </Card>
  )
}
