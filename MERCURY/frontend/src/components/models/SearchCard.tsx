import { useMemo, useState } from 'react'
import { useHfSearch } from '../../api/queries'
import type { HfModelSummary, HfSortKey } from '../../api/admin'
import RepoFilesDrawer from './RepoFilesDrawer'

const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
const btnGray = `${btn} bg-neutral-700 hover:bg-neutral-600 text-neutral-200`
const inputSm = 'px-3 py-1.5 bg-neutral-950 border border-neutral-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500'
const selectSm = 'px-2 py-1.5 bg-neutral-950 border border-neutral-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer'

// ── Filtres constants ────────────────────────────────────────────────────────

type SizeBucket = 'all' | 'lt10' | '10to30' | '30to50' | '50to100' | 'gt100'

const SIZE_BUCKETS: { id: SizeBucket; label: string; match: (b: number | null) => boolean }[] = [
  { id: 'all',     label: 'Toutes tailles', match: () => true },
  { id: 'lt10',    label: '< 10B',          match: (b) => b !== null && b < 10 },
  { id: '10to30',  label: '10–30B',         match: (b) => b !== null && b >= 10 && b < 30 },
  { id: '30to50',  label: '30–50B',         match: (b) => b !== null && b >= 30 && b < 50 },
  { id: '50to100', label: '50–100B',        match: (b) => b !== null && b >= 50 && b < 100 },
  { id: 'gt100',   label: '> 100B',         match: (b) => b !== null && b >= 100 },
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

// ── Utils ────────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Extrait la taille approximative en milliards depuis le repo_id (ex: "gemma-4-31B" → 31). */
function extractSizeB(repoId: string): number | null {
  // Match le premier nombre suivi de B/b, avec boundary. Evite matcher "14B" dans "hash14B".
  const m = repoId.match(/(?:^|[^a-zA-Z0-9])(\d+(?:\.\d+)?)[bB](?![a-zA-Z0-9])/)
  return m ? parseFloat(m[1]) : null
}

function matchesChips(repoId: string, tags: string[], selectedChips: Set<string>): boolean {
  if (selectedChips.size === 0) return true
  const hay = (repoId + ' ' + tags.join(' ')).toLowerCase()
  for (const chipId of selectedChips) {
    const chip = TAG_CHIPS.find(c => c.id === chipId)
    if (!chip) continue
    const hit = chip.keywords.some(kw => hay.includes(kw.toLowerCase()))
    if (!hit) return false
  }
  return true
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SearchCard() {
  // Inputs (unsubmitted)
  const [query, setQuery] = useState('')
  const [author, setAuthor] = useState('')
  // Submitted (ce qui est envoye au backend)
  const [submitted, setSubmitted] = useState<{ q: string; author: string; sort: HfSortKey; ggufOnly: boolean } | null>(null)

  // Filtres client-side
  const [ggufOnly, setGgufOnly] = useState(true)
  const [sortKey, setSortKey] = useState<HfSortKey>('downloads')
  const [sizeBucket, setSizeBucket] = useState<SizeBucket>('all')
  const [selectedChips, setSelectedChips] = useState<Set<string>>(new Set())

  const [expanded, setExpanded] = useState<string | null>(null)

  const { data, isFetching, error } = useHfSearch(
    submitted ?? {},
    !!submitted,
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    const a = author.trim()
    if (q.length < 2 && a.length < 2) return
    setSubmitted({ q, author: a, sort: sortKey, ggufOnly })
    setExpanded(null)
  }

  const toggleChip = (chipId: string) => {
    setSelectedChips(prev => {
      const next = new Set(prev)
      if (next.has(chipId)) next.delete(chipId)
      else next.add(chipId)
      return next
    })
  }

  // Re-soumettre quand sort change et qu'on a deja une recherche active
  const changeSortAndResubmit = (s: HfSortKey) => {
    setSortKey(s)
    if (submitted) setSubmitted({ ...submitted, sort: s })
  }

  const changeGgufAndResubmit = (g: boolean) => {
    setGgufOnly(g)
    if (submitted) setSubmitted({ ...submitted, ggufOnly: g })
  }

  // Filtrage client-side (taille + chips) sur les resultats serveur
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
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      <div className="px-4 py-2.5 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-white m-0">Recherche HuggingFace</h2>
      </div>
      <div className="px-4 py-3 flex flex-col gap-3">
        {/* Row 1: query + author + submit */}
        <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Recherche (ex: gemma-4 deckard)"
            className={`${inputSm} flex-1 min-w-[200px]`}
          />
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Auteur (ex: DavidAU)"
            className={`${inputSm} w-40`}
          />
          <button type="submit" className={btnGray} disabled={!canSearch}>
            Chercher
          </button>
        </form>

        {/* Row 2: options serveur (gguf + tri) */}
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <label className="flex items-center gap-1.5 text-neutral-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={ggufOnly}
              onChange={(e) => changeGgufAndResubmit(e.target.checked)}
              className="accent-blue-600"
            />
            GGUF seulement
          </label>
          <label className="flex items-center gap-1.5 text-neutral-400">
            <span>Trier par :</span>
            <select
              value={sortKey}
              onChange={(e) => changeSortAndResubmit(e.target.value as HfSortKey)}
              className={selectSm}
            >
              {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
        </div>

        {/* Row 3: filtres client (taille) */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500 mr-1">Taille</span>
          {SIZE_BUCKETS.map(b => (
            <button
              key={b.id}
              type="button"
              onClick={() => setSizeBucket(b.id)}
              className={`px-2 py-1 text-[11px] rounded border transition-colors ${
                sizeBucket === b.id
                  ? 'bg-blue-600/20 text-blue-400 border-blue-500/40'
                  : 'bg-neutral-950 text-neutral-400 border-neutral-700 hover:bg-neutral-800'
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>

        {/* Row 4: filtres client (chips) */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500 mr-1">Tags</span>
          {TAG_CHIPS.map(chip => {
            const active = selectedChips.has(chip.id)
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => toggleChip(chip.id)}
                className={`px-2 py-1 text-[11px] rounded border transition-colors font-mono ${
                  active
                    ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/40'
                    : 'bg-neutral-950 text-neutral-400 border-neutral-700 hover:bg-neutral-800'
                }`}
              >
                {active ? '✓ ' : ''}{chip.label}
              </button>
            )
          })}
          {selectedChips.size > 0 && (
            <button
              type="button"
              onClick={() => setSelectedChips(new Set())}
              className="text-[11px] text-neutral-500 hover:text-white ml-2"
            >
              Effacer
            </button>
          )}
        </div>

        {/* Resultats */}
        <div className="flex flex-col gap-1.5">
          {submitted && isFetching && <p className="text-xs text-neutral-500">Recherche…</p>}
          {error && <p className="text-xs text-red-400">Erreur : {(error as Error).message}</p>}

          {data && data.length === 0 && (
            <p className="text-xs text-neutral-500 italic">Aucun résultat côté HuggingFace.</p>
          )}

          {data && data.length > 0 && filtered.length === 0 && (
            <p className="text-xs text-amber-400 italic">
              {data.length} résultat(s) HuggingFace mais aucun ne correspond aux filtres Taille/Tags appliqués.
            </p>
          )}

          {data && filtered.length > 0 && (
            <>
              <p className="text-[10px] text-neutral-500 mb-1">
                {filtered.length} résultat(s) affiché(s)
                {filtered.length !== data.length && ` / ${data.length} renvoyés par HF (filtrés client-side)`}
              </p>
              {filtered.map((m) => {
                const size = extractSizeB(m.repo_id)
                return (
                  <div key={m.repo_id} className="border border-neutral-800 rounded-lg bg-neutral-950/60">
                    <div className="flex items-center justify-between gap-2 px-3 py-2">
                      <div className="flex flex-col min-w-0">
                        <span className="font-mono text-xs text-white truncate" title={m.repo_id}>
                          {m.repo_id}
                          {size !== null && (
                            <span className="ml-2 px-1.5 py-0.5 text-[9px] font-bold uppercase bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded">
                              {size}B
                            </span>
                          )}
                          {m.gated && (
                            <span className="ml-2 px-1.5 py-0.5 text-[9px] font-bold uppercase bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded">
                              gated
                            </span>
                          )}
                        </span>
                        <span className="text-[10px] text-neutral-500">
                          ↓ {fmtNum(m.downloads)} · ♥ {fmtNum(m.likes)}
                          {m.last_modified ? ` · ${m.last_modified.slice(0, 10)}` : ''}
                        </span>
                      </div>
                      <button
                        className={btnGray}
                        onClick={() => setExpanded(expanded === m.repo_id ? null : m.repo_id)}
                      >
                        {expanded === m.repo_id ? 'Masquer' : 'Voir fichiers'}
                      </button>
                    </div>
                    {expanded === m.repo_id && (
                      <RepoFilesDrawer repoId={m.repo_id} onClose={() => setExpanded(null)} />
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
