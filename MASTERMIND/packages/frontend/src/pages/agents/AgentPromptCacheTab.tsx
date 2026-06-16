import { useEffect, useState, useCallback, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import type { PromptCacheAnalysis } from './types';

export interface AgentPromptCacheTabProps {
  /** Currently selected agent — highlights its row/column in the matrix and shows its breakdown. */
  selectedAgentId: string;
}

/** Pretty-print a token count with kilo-suffix once past 1000. */
const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/**
 * Cross-agent KV prefix cache analysis.
 *
 * - Per-agent breakdown: stacked bar (tools / system / other) + heaviest sections as horizontal
 *   bars, so it's obvious at a glance which content is driving the prompt.
 * - Partner list from the selected agent's POV: every other agent is a row with a proportion
 *   bar and the section where the common prefix diverges. Greener = diverges at
 *   `agent-identity` (ideal), bluer = earlier (cache cut short).
 *
 * Read-only — every datum comes from /api/debug/prompt-cache, no mutation.
 */
export function AgentPromptCacheTab({ selectedAgentId }: AgentPromptCacheTabProps) {
  const [data, setData] = useState<PromptCacheAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<PromptCacheAnalysis>('/api/debug/prompt-cache');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchAnalysis(); }, [fetchAnalysis]);

  const self = data?.agents.find(a => a.id === selectedAgentId);
  const agentCount = data?.agents.length ?? 0;

  /** Top sections for the selected agent, sorted by weight, with a proportion ratio vs the biggest one. */
  const topSections = useMemo(() => {
    if (!self) return [];
    const sorted = [...self.sections].sort((a, b) => b.tokens - a.tokens).slice(0, 12);
    const max = sorted[0]?.tokens ?? 1;
    return sorted.map(s => ({ ...s, ratio: max > 0 ? s.tokens / max : 0 }));
  }, [self]);

  /** Stacked-bar proportions for the selected agent's total prompt. */
  const selfBreakdown = useMemo(() => {
    if (!self || self.totalChars === 0) return null;
    const tools = self.toolsChars / self.totalChars;
    const system = self.systemPromptChars / self.totalChars;
    const other = Math.max(0, 1 - tools - system);
    return { tools, system, other };
  }, [self]);

  /**
   * Sharing partners from the POV of the selected agent: every other agent with the shared
   * prefix length and where the divergence starts. Sorted by shared tokens desc so the best
   * partners are at the top. Ratio is normalized to the selected agent's own total token
   * count, so the bar maxes out when the other agent shares essentially the whole prompt.
   */
  const partners = useMemo(() => {
    if (!data || !self) return [];
    const maxShare = self.totalTokensEst || 1;
    return data.matrix
      .filter(p => p.a === selectedAgentId || p.b === selectedAgentId)
      .map(p => ({
        id: p.a === selectedAgentId ? p.b : p.a,
        commonTokensEst: p.commonTokensEst,
        commonChars: p.commonChars,
        firstDivergenceSection: p.firstDivergenceSection,
        ratio: p.commonTokensEst / maxShare,
      }))
      .sort((a, b) => b.commonTokensEst - a.commonTokensEst);
  }, [data, self, selectedAgentId]);

  /**
   * `agent-identity` is the first per-agent divergence in a well-aligned pair — anything
   * before it (tools, platform, environment) means the shared cache is cut short.
   */
  const isIdealDivergence = (section: string) => section === 'agent-identity' || section.startsWith('agent-identity');

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-4">
      {/* Header + refresh */}
      <div className="bg-card rounded-xl border border-border/60 p-4 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Analyse cache prompt inter-agents</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Préfixe commun byte-exact entre chaque paire d'agents sur le même modèle. Plus la zone
              commune est longue, plus le KV cache de llama.cpp est partagé au switch d'agent.
            </p>
          </div>
          <button
            onClick={() => void fetchAnalysis()}
            disabled={loading}
            className="shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border hover:border-ring text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Calcul…' : 'Recharger'}
          </button>
        </div>
        {error && <p className="text-xs text-destructive">Erreur: {error}</p>}
        {/* Bypass + lazy toggles context — explicit reminder of the mechanic so an agent that
            suddenly stops sharing prefix here doesn't look like a regression. */}
        <div className="text-[11px] text-muted-foreground/80 leading-relaxed pt-2 border-t border-border/40 space-y-1.5">
          <p>
            <strong className="text-muted-foreground">By-pass unified cache</strong> (toggle dans Config agent) :
            quand activé pour un agent, son prefix devient sur-mesure (skills starred + tools cochés)
            et n'est plus partagé avec les autres agents du même modèle. Gain de tokens significatif
            (≈10-15k pour un agent avec peu de skills) mais le switch vers/depuis cet agent invalide
            le KV cache. Recommandé si l'agent tourne sur un modèle dédié, ou si tu acceptes le coût du switch.
          </p>
          <p>
            <strong className="text-muted-foreground">Lazy skills</strong> (toggle dans Config agent) :
            les skills ne sont plus injectés avec leurs schémas complets dans <code>tools</code>; à la place,
            une liste one-liner par skill est ajoutée au system prompt et l'agent récupère les schémas à la demande
            via <code>inspect_skill('&lt;id&gt;')</code>. Gain ~10-12k tokens. Indépendant du by-pass — cumulable.
            Même contrainte cache : un agent en lazy mode a un prefix différent des agents non-lazy du même modèle.
          </p>
        </div>
      </div>

      {/* Self breakdown */}
      {self && (
        <div className="bg-card rounded-xl border border-border/60 p-5 space-y-5">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-1">
                Détail agent
              </p>
              <h3 className="text-sm font-mono text-foreground">{self.id}</h3>
            </div>
            <div className="text-right">
              <p className="text-2xl font-semibold text-foreground leading-none">
                ~{fmtTokens(self.totalTokensEst)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                tokens · {self.totalChars.toLocaleString()} chars
              </p>
            </div>
          </div>

          {/* Stacked proportion bar — 3 distinct theme colors so segments stand out on the dark card */}
          {selfBreakdown && (
            <div className="space-y-2">
              <div className="flex h-3 rounded overflow-hidden bg-secondary">
                <div
                  className="bg-theme-purple"
                  style={{ width: `${selfBreakdown.tools * 100}%` }}
                  title={`Tools — ${self.toolsChars.toLocaleString()} chars`}
                />
                <div
                  className="bg-theme-green"
                  style={{ width: `${selfBreakdown.system * 100}%` }}
                  title={`System prompt — ${self.systemPromptChars.toLocaleString()} chars`}
                />
                <div
                  className="bg-muted-foreground/50"
                  style={{ width: `${selfBreakdown.other * 100}%` }}
                  title="Autre (sections diverses)"
                />
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <LegendItem
                  swatchClass="bg-theme-purple"
                  label="Tools"
                  value={`${self.toolsChars.toLocaleString()} ch`}
                  pct={selfBreakdown.tools}
                />
                <LegendItem
                  swatchClass="bg-theme-green"
                  label="System"
                  value={`${self.systemPromptChars.toLocaleString()} ch`}
                  pct={selfBreakdown.system}
                />
                <LegendItem
                  swatchClass="bg-muted-foreground/50"
                  label="Autre"
                  value={`${self.sections.length} sections`}
                  pct={selfBreakdown.other}
                />
              </div>
            </div>
          )}

          {/* Top sections as horizontal bars */}
          {topSections.length > 0 && (
            <div className="pt-4 border-t border-border space-y-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                Sections les plus lourdes
              </p>
              <div className="space-y-1.5">
                {topSections.map(s => (
                  <div key={s.key} className="flex items-center gap-3 text-xs">
                    <span className="font-mono text-foreground w-52 shrink-0 truncate" title={s.key}>
                      {s.key}
                    </span>
                    <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${s.ratio * 100}%` }}
                      />
                    </div>
                    <span className="font-mono text-muted-foreground w-16 text-right shrink-0">
                      ~{fmtTokens(s.tokens)} tok
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Partners: 1D list from the selected agent's POV */}
      {self && partners.length > 0 && (
        <div className="bg-card rounded-xl border border-border/60 p-5 space-y-3">
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-1">
              Partage avec les autres agents
            </p>
            <p className="text-xs text-muted-foreground">
              Longueur du préfixe commun entre <span className="font-mono text-foreground">{self.id}</span> et chaque autre agent.
              Barre pleine = les deux prompts sont byte-identiques presque jusqu'au bout. Flèche = section où la divergence commence.
            </p>
          </div>

          <div className="space-y-1.5">
            {partners.map(p => {
              const ideal = isIdealDivergence(p.firstDivergenceSection);
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-3 text-xs py-1.5 px-2 rounded hover:bg-secondary/40 transition-colors"
                  title={`${self.id} ↔ ${p.id}\n~${fmtTokens(p.commonTokensEst)} tokens communs (${p.commonChars.toLocaleString()} chars)\ndiverge @ ${p.firstDivergenceSection}`}
                >
                  <span className="font-mono text-foreground w-28 shrink-0 truncate">{p.id}</span>
                  <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
                    <div
                      className={`h-full rounded-full ${ideal ? 'bg-theme-green' : 'bg-primary'}`}
                      style={{ width: `${Math.min(100, p.ratio * 100)}%` }}
                    />
                  </div>
                  <span className="font-mono text-foreground w-14 text-right shrink-0">
                    ~{fmtTokens(p.commonTokensEst)}
                  </span>
                  <span
                    className={`font-mono text-[11px] w-64 shrink-0 truncate ${
                      ideal ? 'text-theme-green' : 'text-muted-foreground'
                    }`}
                  >
                    → {p.firstDivergenceSection}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="text-[11px] text-muted-foreground pt-3 border-t border-border">
            <span className="inline-block w-2 h-2 rounded-full bg-theme-green align-middle mr-1" />
            vert = divergence à <code className="bg-secondary px-1 rounded font-mono">agent-identity</code> (idéal — tools, platform et environment partagés) ·{' '}
            <span className="inline-block w-2 h-2 rounded-full bg-primary align-middle mr-1 ml-2" />
            bleu = divergence plus tôt (le cache est coupé avant)
          </p>
        </div>
      )}

      {data && agentCount === 0 && (
        <p className="text-sm text-muted-foreground">Aucun agent enabled.</p>
      )}
      </div>
    </div>
  );
}

function LegendItem({
  swatchClass,
  label,
  value,
  pct,
}: {
  swatchClass: string;
  label: string;
  value: string;
  pct: number;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className={`inline-block w-2.5 h-2.5 rounded-sm shrink-0 ${swatchClass}`} />
      <div className="min-w-0 flex-1">
        <p className="text-foreground">
          {label} <span className="text-muted-foreground">· {(pct * 100).toFixed(0)}%</span>
        </p>
        <p className="text-muted-foreground text-[11px] font-mono truncate">{value}</p>
      </div>
    </div>
  );
}
