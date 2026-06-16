import { useState } from 'react';
import { BrainCircuit, RefreshCw, Play, CheckCircle2, XCircle, Loader2, Zap } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../../lib/api';
import { cardCls, btnSecondary } from '../types';
import type { MemoryStoreStatus, OnboardResult } from '../types';

interface Props {
  msStatus: MemoryStoreStatus | null;
  msStatusLoading: boolean;
  msConfigEnabled: boolean;
  onRefresh: () => void;
  onStatusChange: () => void;
}

export function StoreStatusCard({ msStatus, msStatusLoading, msConfigEnabled: initialEnabled, onRefresh, onStatusChange }: Props) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [onboardResult, setOnboardResult] = useState<OnboardResult | null>(null);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  const [reembedding, setReembedding] = useState(false);
  const [reembedResult, setReembedResult] = useState<string | null>(null);

  // Sync external prop changes
  if (initialEnabled !== enabled && !toggling) setEnabled(initialEnabled);

  const toggleMemoryStore = async (val: boolean) => {
    setToggling(true);
    setToggleError(null);
    try {
      await api.put('/api/config', { memoryStore: { enabled: val } });
      setEnabled(val);
      onStatusChange();
    } catch (e: unknown) {
      setToggleError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  };

  const runOnboarding = async () => {
    setOnboarding(true);
    setOnboardResult(null);
    setOnboardError(null);
    try {
      const r = await api.post<OnboardResult>('/api/memory-store/onboard', {});
      setOnboardResult(r);
      onStatusChange();
    } catch (e: unknown) {
      setOnboardError(e instanceof Error ? e.message : String(e));
    } finally {
      setOnboarding(false);
    }
  };

  const runReembed = async () => {
    setReembedding(true);
    setReembedResult(null);
    try {
      const r = await api.post<{ ok: boolean; embedded: number }>('/api/memory-store/reembed', {});
      setReembedResult(`${r.embedded} entree(s) embeddees`);
      onStatusChange();
    } catch (e: unknown) {
      setReembedResult(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReembedding(false);
    }
  };

  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <BrainCircuit size={16} />
          Statut
        </h2>
        <button type="button" onClick={onRefresh} disabled={msStatusLoading} className="text-muted-foreground hover:text-foreground" title="Actualiser">
          <RefreshCw size={14} className={msStatusLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {msStatusLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> Chargement...
        </div>
      )}

      {!msStatusLoading && (
        <div className="space-y-4">
          {/* Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-foreground">Memoire vectorielle activee</p>
              <p className="text-xs text-muted-foreground mt-0.5">PostgreSQL + pgvector pour l'ecriture et la recherche semantique.</p>
            </div>
            <button
              type="button"
              disabled={toggling}
              onClick={() => void toggleMemoryStore(!enabled)}
              className={clsx(
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50',
                enabled ? 'bg-primary' : 'bg-muted',
              )}
              role="switch"
              aria-checked={enabled}
            >
              <span className={clsx('pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200', enabled ? 'translate-x-5' : 'translate-x-0')} />
            </button>
          </div>
          {toggleError && <p className="text-xs text-theme-red">{toggleError}</p>}

          {/* Onboard */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-foreground">Initialisation de la base</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Verifie pgvector, cree l'extension et les tables <code className="bg-secondary px-1 rounded-md">agent_memories</code>.
              </p>
            </div>
            <button type="button" disabled={onboarding} onClick={() => void runOnboarding()} className={btnSecondary}>
              {onboarding ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {onboarding ? 'En cours...' : 'Initialiser'}
            </button>
          </div>
          {onboardError && <p className="text-xs text-theme-red">{onboardError}</p>}

          {onboardResult && (
            <div className="bg-secondary rounded-lg p-3 space-y-1.5">
              {onboardResult.checks.map((c, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  {c.ok ? <CheckCircle2 size={13} className="text-theme-green mt-0.5 shrink-0" /> : <XCircle size={13} className="text-theme-red mt-0.5 shrink-0" />}
                  <div className="min-w-0">
                    <span className={clsx('font-medium', c.ok ? 'text-foreground' : 'text-theme-red')}>{c.step}</span>
                    <span className="text-muted-foreground ml-1.5">{c.message}</span>
                  </div>
                </div>
              ))}
              <div className={clsx('text-xs font-semibold mt-2 pt-2 border-t border-border', onboardResult.ok ? 'text-theme-green' : 'text-theme-red')}>
                {onboardResult.ok ? 'Initialisation reussie' : 'Echec'}
              </div>
            </div>
          )}

          {/* Status indicator */}
          {msStatus && !msStatus.enabled && (
            <div className="flex items-start gap-2 text-xs text-theme-orange">
              <XCircle size={14} className="mt-0.5 shrink-0" />
              <span>Memory store <strong>desactive</strong>{msStatus.reason ? ` — ${msStatus.reason}` : ''}.</span>
            </div>
          )}

          {msStatus?.enabled && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-theme-green">
                <CheckCircle2 size={14} /> Active et connecte.
              </div>
              {msStatus.error && <p className="text-xs text-theme-red">{msStatus.error}</p>}

              {/* Re-embed missing */}
              <div className="flex items-center gap-3">
                <button type="button" disabled={reembedding} onClick={() => void runReembed()} className={btnSecondary}>
                  {reembedding ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                  {reembedding ? 'Embedding en cours...' : 'Re-embed les entrees sans vecteur'}
                </button>
                {reembedResult && (
                  <span className={clsx('text-xs', reembedResult.startsWith('Erreur') ? 'text-theme-red' : 'text-theme-green')}>{reembedResult}</span>
                )}
              </div>

              {msStatus.stats && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="bg-secondary rounded-lg p-3 text-center">
                    <div className="text-lg font-semibold text-foreground">{msStatus.stats.total}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">entrees</div>
                  </div>
                  {Object.entries(msStatus.stats.perScope ?? {}).map(([scope, count]) => (
                    <div key={scope} className="bg-secondary rounded-lg p-3 text-center">
                      <div className="text-lg font-semibold text-foreground">{count}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{scope}</div>
                    </div>
                  ))}
                  {Object.keys(msStatus.stats.perDomain ?? {}).length > 0 && (
                    <div className="bg-secondary rounded-lg p-3 text-center">
                      <div className="text-lg font-semibold text-foreground">{Object.keys(msStatus.stats.perDomain).length}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">domaines</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
