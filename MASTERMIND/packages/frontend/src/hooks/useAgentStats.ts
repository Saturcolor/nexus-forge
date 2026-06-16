import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import type { ProviderStats } from '@mastermind/shared';

const POLL_INTERVAL_MS = 6000;

/** Champs transitoires gérés exclusivement par le WS (SSE Mercury) — jamais écrasés par le poll HTTP */
const TRANSIENT_KEYS: (keyof ProviderStats)[] = [
  'isPromptProcessing',
  'isLoading',
  'promptProcessingProgress',
  'promptProcessingTokens',
];

/**
 * Polls GET /api/agents/:agentId/stats every 6s for baseline stats.
 * Also subscribes to 'provider.stats' WebSocket events for real-time
 * loading/prompt-processing updates during active runs.
 * Returns null if stats are unavailable (no statsUrl configured, etc.)
 */
export function useAgentStats(agentId: string | null, modelOverride?: string): ProviderStats | null {
  const [stats, setStats] = useState<ProviderStats | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseStatsRef = useRef<ProviderStats | null>(null);
  /** Tracks current transient state from WS (source of truth for isPromptProcessing, isLoading) */
  const transientRef = useRef<Partial<ProviderStats>>({});

  // HTTP polling for baseline stats (ctx, tok/s, etc.)
  useEffect(() => {
    if (!agentId) { setStats(null); return; }

    let cancelled = false;

    const fetchStats = async () => {
      let unavailable = false;
      try {
        const qs = modelOverride ? `?model=${encodeURIComponent(modelOverride)}` : '';
        const data = await api.get<ProviderStats | null>(`/api/agents/${agentId}/stats${qs}`);
        if (!cancelled) {
          if (data === null) {
            // Backend a renvoyé 204 : pas de live stats pour ce backend (LLM cloud,
            // pas de statsUrl configuré, etc.). On stoppe le poll pour ne pas
            // marteler la route toutes les 6s sans bénéfice.
            unavailable = true;
            baseStatsRef.current = null;
          } else {
            baseStatsRef.current = data;
            // Merge: stable fields from HTTP, transient fields preserved from WS
            setStats(prev => ({ ...data, ...transientRef.current }));
          }
        }
      } catch (err) {
        // DON'T reset stats on transient HTTP errors. The poll hits the same upstream
        // chain (Mastermind → Mercury → brain-daemon /mgmt/slots) that times out during
        // active inference and returns 502 every ~3s. Resetting to null here causes the
        // prompt-processing indicator to flicker (disappear 1-2s, then reappear when the
        // SSE pushes the next update). The SSE stream is the live source of truth — the
        // HTTP poll is only a fallback baseline. Just skip this tick on error.
        // The first-ever fetch failure leaves stats at its initial null naturally.
        console.debug(`[useAgentStats] poll failed agent=${agentId} (keeping previous state): ${err instanceof Error ? err.message : err}`);
      }
      if (!cancelled && !unavailable) {
        timerRef.current = setTimeout(fetchStats, POLL_INTERVAL_MS);
      }
    };

    fetchStats();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [agentId, modelOverride]);

  // Real-time WS subscription for provider.stats events (loading, prompt processing)
  // PLUS a redundant clear path on agent.state=idle/warm.done/error: if a `provider.stats`
  // SSE update gets stuck mid-flight when the run ends abruptly (network blip, abort,
  // backend restart), the gauge would otherwise stay frozen on the last reported state.
  // Watching agent.state guarantees we always reset transient flags when the agent goes
  // back to idle, regardless of whether the final provider.stats broadcast made it through.
  useEffect(() => {
    if (!agentId) return;

    const unsubscribe = wsClient.subscribe((msg) => {
      // Final-clear redundancy: any terminal agent.state for our agent → drop transient flags.
      if (msg.type === 'agent.state' && msg.agentId === agentId) {
        const terminal = msg.state === 'idle' || msg.state === 'warm.done' || msg.state === 'error';
        if (terminal) {
          transientRef.current = {};
          setStats(prev => prev ? { ...prev, isPromptProcessing: false, isLoading: false } : prev);
        }
        // Nouveau tour : on purge les vieilles métriques d'usage (promptTokens, cachedTokens,
        // outputTokens, tokensPerSecond) AVANT que le run émette sa première provider.stats.
        // Sinon l'utilisateur voit le "Cache hit: 1234" du run OpenRouter précédent persister
        // pendant tout un nouveau run local (qui réémet promptTokens mais jamais cachedTokens=0).
        // CRITIQUE : on purge AUSSI baseStatsRef.current — sinon le poll HTTP /stats qui tick
        // toutes les 6s ré-injecte instantanément `proxy_metrics.last_*` (= mêmes anciennes
        // valeurs) via `setStats(prev => ({ ...data, ...transientRef.current }))` ci-dessus.
        if (msg.state === 'thinking' || msg.state === 'streaming') {
          if (baseStatsRef.current) {
            const cleanedBase = { ...baseStatsRef.current };
            delete cleanedBase.promptTokens;
            delete cleanedBase.outputTokens;
            delete cleanedBase.cachedTokens;
            delete cleanedBase.tokensPerSecond;
            baseStatsRef.current = cleanedBase;
          }
          setStats(prev => {
            if (!prev) return prev;
            const next = { ...prev };
            delete next.promptTokens;
            delete next.outputTokens;
            delete next.cachedTokens;
            delete next.tokensPerSecond;
            return next;
          });
        }
        return;
      }

      if (msg.type !== 'provider.stats' || msg.agentId !== agentId) return;
      const incoming = msg.stats as Partial<ProviderStats>;

      // Update transient ref so HTTP polls don't overwrite these values
      const transient: Partial<ProviderStats> = {};
      for (const key of TRANSIENT_KEYS) {
        if (key in incoming) {
          (transient as any)[key] = (incoming as any)[key];
        }
      }
      // If WS explicitly sets isPromptProcessing=false and isLoading=false, clear transient state
      if (incoming.isPromptProcessing === false && incoming.isLoading === false) {
        transientRef.current = {};
      } else {
        transientRef.current = { ...transientRef.current, ...transient };
      }

      setStats(prev => {
        const base = baseStatsRef.current ?? prev ?? { ts: new Date().toISOString() };
        return { ...base, ...incoming };
      });
    });

    return unsubscribe;
  }, [agentId]);

  return stats;
}
