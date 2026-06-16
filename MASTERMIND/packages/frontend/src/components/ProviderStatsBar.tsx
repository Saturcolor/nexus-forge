import type { ProviderStats } from '@mastermind/shared';

interface Props {
  stats: ProviderStats;
}

function fmt(n: number, decimals = 0): string {
  return n.toFixed(decimals);
}

function ctxPercent(used?: number, max?: number): number | null {
  if (used == null || max == null || max === 0) return null;
  return Math.round((used / max) * 100);
}

function ctxColor(pct: number): string {
  if (pct >= 85) return 'text-destructive';
  if (pct >= 65) return 'text-yellow-400';
  return 'text-theme-green';
}

export default function ProviderStatsBar({ stats }: Props) {
  const pct = ctxPercent(stats.ctxUsed, stats.ctxMax);

  return (
    <div className="flex items-center gap-3 px-2 py-0.5 rounded text-[10px] font-mono bg-secondary/60 text-muted-foreground select-none">
      {/* ctx */}
      {stats.ctxMax != null && (
        <span className="flex items-center gap-1" title="Contexte utilisé / max">
          <span className="opacity-50">ctx</span>
          {stats.ctxUsed != null ? (
            <span className={pct != null ? ctxColor(pct) : ''}>
              {(stats.ctxUsed / 1000).toFixed(1)}k
            </span>
          ) : null}
          <span className="opacity-40">/</span>
          <span>{(stats.ctxMax / 1000).toFixed(0)}k</span>
          {pct != null && (
            <span className={`opacity-70 ${ctxColor(pct)}`}>({pct}%)</span>
          )}
        </span>
      )}

      {/* tok/s */}
      {stats.tokensPerSecond != null && stats.tokensPerSecond > 0 && (
        <span className="flex items-center gap-1" title="Tokens par seconde (dernière génération)">
          <span className="opacity-50">tok/s</span>
          <span className="text-foreground">{fmt(stats.tokensPerSecond, 1)}</span>
        </span>
      )}

      {/* last in+out */}
      {(stats.promptTokens != null || stats.outputTokens != null) && (
        <span className="flex items-center gap-1 opacity-60" title="Tokens prompt / sortie (dernière requête)">
          {stats.promptTokens != null && <span>{stats.promptTokens}in</span>}
          {stats.outputTokens != null && <span>{stats.outputTokens}out</span>}
        </span>
      )}
    </div>
  );
}
