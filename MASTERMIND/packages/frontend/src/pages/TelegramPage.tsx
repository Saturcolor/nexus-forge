import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  Plus, RotateCw, Trash2, Key, Bot,
  CheckCircle2, XCircle, AlertCircle, Power,
  Eye, EyeOff, Settings, Activity, Mic, Loader2,
  Bell, Smartphone, ChevronRight,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAgents } from '../hooks/useAgents';
import { DeliveryPolicyEditor } from '../components/DeliveryPolicyEditor';
import type { AgentDeliveryPolicy } from '@mastermind/shared';

interface BotStatus {
  id: string;
  enabled: boolean;
  hasToken: boolean;
  running: boolean;
}

interface NewBot {
  id: string;
  token: string;
  enabled: boolean;
}

const DEFAULT_NEW: NewBot = { id: '', token: '', enabled: true };

type Tab = 'delivery' | 'mobile' | 'status' | 'bots' | 'ncm';

function StatusBadge({ running, enabled, hasToken }: { running: boolean; enabled: boolean; hasToken: boolean }) {
  if (!hasToken) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-destructive/10 text-destructive text-[10px] font-medium">
      <AlertCircle size={10} />
      Token manquant
    </span>
  );
  if (!enabled) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px] font-medium">
      <Power size={10} />
      Désactivé
    </span>
  );
  if (running) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-theme-green/10 text-theme-green text-[10px] font-medium">
      <CheckCircle2 size={10} />
      Running
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-400/10 text-orange-400 text-[10px] font-medium">
      <XCircle size={10} />
      Arrêté
    </span>
  );
}

function StateDot({ running, enabled, hasToken }: { running: boolean; enabled: boolean; hasToken: boolean }) {
  const cls = !hasToken ? 'bg-destructive' :
    !enabled ? 'bg-muted-foreground/40' :
    running ? 'bg-theme-green animate-pulse' :
    'bg-orange-400';
  return <span className={clsx('w-2 h-2 rounded-full shrink-0', cls)} />;
}

function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={clsx(
        'relative w-9 h-5 rounded-full transition-colors shrink-0',
        value ? 'bg-primary' : 'bg-muted',
      )}
    >
      <span className={clsx(
        'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all',
        value ? 'left-[18px]' : 'left-0.5',
      )} />
    </button>
  );
}

export default function TelegramPage() {
  const [bots, setBots] = useState<BotStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('delivery');

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ token: string; enabled: boolean }>({ token: '', enabled: true });
  const [showToken, setShowToken] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [restartingId, setRestartingId] = useState<string | null>(null);

  // Create state
  const [showCreate, setShowCreate] = useState(false);
  const [newBot, setNewBot] = useState<NewBot>(DEFAULT_NEW);
  const [creating, setCreating] = useState(false);
  const [showNewToken, setShowNewToken] = useState(false);

  const load = () =>
    api.get<BotStatus[]>('/api/telegram').then(setBots).finally(() => setLoading(false));

  useEffect(() => { void load(); }, []);

  const handleRestart = async (id?: string) => {
    if (id) {
      setRestartingId(id);
      try { await api.post(`/api/telegram/${id}/restart`); } finally { setRestartingId(null); }
    } else {
      await api.post('/api/telegram/restart');
    }
    void load();
  };

  const handleSave = async (id: string) => {
    setSavingId(id);
    try {
      await api.put(`/api/telegram/${id}`, editDraft);
      setEditingId(null);
      await load();
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Supprimer le bot "${id}" ?`)) return;
    await api.delete(`/api/telegram/${id}`);
    void load();
  };

  const handleCreate = async () => {
    if (!newBot.id || !newBot.token) return;
    setCreating(true);
    try {
      await api.post('/api/telegram', newBot);
      setShowCreate(false);
      setNewBot(DEFAULT_NEW);
      void load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  // NCM config state
  const [ncmUrl, setNcmUrl] = useState('');
  const [ncmLoaded, setNcmLoaded] = useState(false);
  const [ncmSaving, setNcmSaving] = useState(false);
  const [ncmTesting, setNcmTesting] = useState(false);
  const [ncmTestResult, setNcmTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Load NCM config on mount
  useEffect(() => {
    api.get<{ ncm?: { baseUrl?: string } }>('/api/config')
      .then(cfg => {
        setNcmUrl(cfg.ncm?.baseUrl ?? '');
        setNcmLoaded(true);
      })
      .catch(() => setNcmLoaded(true));
  }, []);

  const handleNcmSave = async () => {
    setNcmSaving(true);
    setNcmTestResult(null);
    try {
      await api.put('/api/config', { ncm: { baseUrl: ncmUrl.trim() } });
      setNcmTestResult({ ok: true, message: 'Config sauvegardée' });
    } catch (err) {
      setNcmTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setNcmSaving(false);
    }
  };

  const handleNcmTest = async () => {
    if (!ncmUrl.trim()) { setNcmTestResult({ ok: false, message: 'URL vide' }); return; }
    setNcmTesting(true);
    setNcmTestResult(null);
    try {
      // Save first so the backend uses the latest URL, then test server-side
      await api.put('/api/config', { ncm: { baseUrl: ncmUrl.trim() } });
      const result = await api.get<{ ok: boolean; message: string }>('/api/config/ncm/test');
      setNcmTestResult(result);
    } catch (err) {
      setNcmTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'NCM injoignable',
      });
    } finally {
      setNcmTesting(false);
    }
  };

  const TABS: { id: Tab; label: string; icon: typeof Activity }[] = [
    { id: 'delivery', label: 'Police de livraison', icon: Bell        },
    { id: 'mobile',   label: 'Mobile',              icon: Smartphone  },
    { id: 'status',   label: 'Statut TG',           icon: Activity    },
    { id: 'bots',     label: 'Bots',                icon: Settings    },
    { id: 'ncm',      label: 'NCM',                 icon: Mic         },
  ];

  // Note : on ne bloque PLUS toute la page sur `loading` (data bots Telegram). Les onglets
  // Delivery/Mobile sont indépendants du chargement des bots — chaque onglet TG gère son propre
  // état de chargement plus bas.

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header — labels des boutons cachés sous sm pour éviter le wrap moche
          en mobile ("Nouveau\nbot"). L'icône + tooltip restent. */}
      <div className="flex items-center justify-between gap-2 px-3 sm:px-6 py-4 border-b border-border bg-card/30 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
            <Bell size={15} className="text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[15px] font-bold text-foreground">Delivery</h1>
            <p className="text-[11px] text-muted-foreground/50 truncate">
              Réveils &amp; notifications — mobile, Telegram, alertes
              {bots.filter(b => b.running).length > 0 && ` · ${bots.filter(b => b.running).length} bot${bots.filter(b => b.running).length !== 1 ? 's' : ''} TG actif${bots.filter(b => b.running).length !== 1 ? 's' : ''}`}
            </p>
          </div>
        </div>
        {/* Boutons header — réservés aux onglets Telegram (Statut/Bots). Labels raccourcis sur
            mobile (au lieu d'icon-only) pour garder l'action explicite, et padding bumped à
            py-2.5 (~40px de hit area) sous sm pour respecter les recos Apple HIG / Material
            (≥44/48px). Desktop conserve px-3 py-1.5 compact. */}
        {(tab === 'status' || tab === 'bots') && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleRestart()}
              aria-label="Restart all bots"
              className="flex items-center gap-1.5 px-3 py-2.5 sm:py-1.5 text-xs text-muted-foreground bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
            >
              <RotateCw size={12} />
              <span className="sm:hidden">Restart</span>
              <span className="hidden sm:inline">Restart all</span>
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              aria-label="Nouveau bot"
              className="flex items-center gap-1.5 px-3 py-2.5 sm:py-1.5 text-xs text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg transition-colors font-medium"
            >
              <Plus size={12} />
              <span className="sm:hidden">Bot</span>
              <span className="hidden sm:inline">Nouveau bot</span>
            </button>
          </div>
        )}
      </div>

      {/* Tabs — scrollable horizontalement sur narrow */}
      <div className="px-6 border-b border-border bg-card/20 shrink-0 overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-1 min-w-max">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={clsx(
                'whitespace-nowrap flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors',
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon size={12} />
              {t.label}
            </button>
          );
        })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">

        {/* ── DELIVERY TAB (police de livraison par agent) ── */}
        {tab === 'delivery' && <DeliveryTab />}

        {/* ── MOBILE TAB (appareils push + état du canal APNs) ── */}
        {tab === 'mobile' && <MobileTab />}

        {/* ── STATUS TAB ── */}
        {tab === 'status' && (
          <div className="p-6 space-y-3 max-w-2xl mx-auto w-full">
            {bots.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                <Bot size={36} className="text-muted-foreground/15" />
                <p className="text-sm text-muted-foreground/40">Aucun bot configuré</p>
                <button
                  onClick={() => { setTab('bots'); setShowCreate(true); }}
                  className="text-xs text-primary hover:text-primary/80"
                >
                  + Ajouter un bot
                </button>
              </div>
            ) : (
              <>
                {/* Summary row */}
                <div className="grid grid-cols-3 gap-3 mb-5">
                  {[
                    { label: 'Total', value: bots.length, color: 'text-foreground' },
                    { label: 'Running', value: bots.filter(b => b.running).length, color: 'text-theme-green' },
                    { label: 'Arrêtés / inactifs', value: bots.filter(b => !b.running).length, color: 'text-muted-foreground' },
                  ].map(s => (
                    <div key={s.label} className="bg-card/60 rounded-xl p-3 border border-border/50">
                      <p className={clsx('text-2xl font-bold', s.color)}>{s.value}</p>
                      <p className="text-[11px] text-muted-foreground/60 mt-0.5">{s.label}</p>
                    </div>
                  ))}
                </div>

                {/* Bot status cards */}
                {bots.map(bot => (
                  <div key={bot.id} className="bg-card rounded-xl border border-border/50 p-4 flex items-center gap-4">
                    {/* Avatar */}
                    <div className="relative shrink-0">
                      <div className="w-10 h-10 rounded-xl bg-sky-500/10 flex items-center justify-center">
                        <Bot size={18} className="text-sky-400/70" />
                      </div>
                      <StateDot running={bot.running} enabled={bot.enabled} hasToken={bot.hasToken} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-[13px] font-semibold text-foreground">{bot.id}</p>
                        <StatusBadge running={bot.running} enabled={bot.enabled} hasToken={bot.hasToken} />
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className={clsx(
                          'inline-flex items-center gap-1 text-[10px]',
                          bot.hasToken ? 'text-muted-foreground/50' : 'text-destructive/70',
                        )}>
                          <Key size={9} />
                          {bot.hasToken ? 'Token configuré' : 'Token manquant'}
                        </span>
                        <span className={clsx(
                          'text-[10px]',
                          bot.enabled ? 'text-muted-foreground/50' : 'text-muted-foreground/30',
                        )}>
                          {bot.enabled ? 'Activé' : 'Désactivé'}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => void handleRestart(bot.id)}
                        disabled={restartingId === bot.id}
                        title="Restart"
                        className="p-1.5 text-muted-foreground/50 hover:text-foreground hover:bg-secondary rounded-lg transition-colors disabled:opacity-40"
                      >
                        <RotateCw size={13} className={restartingId === bot.id ? 'animate-spin' : ''} />
                      </button>
                      <button
                        onClick={() => { setTab('bots'); setEditingId(bot.id); setEditDraft({ token: '', enabled: bot.enabled }); setShowToken(false); }}
                        title="Éditer"
                        className="p-1.5 text-muted-foreground/50 hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
                      >
                        <Settings size={13} />
                      </button>
                    </div>
                  </div>
                ))}

                {/* Env note */}
                <div className="mt-4 bg-card/40 rounded-xl p-3 border border-border/30">
                  <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                    Tokens via variables d'env :{' '}
                    <code className="text-sky-400/70 bg-sky-500/5 px-1 rounded">TELEGRAM_BOT_TOKEN</code>,{' '}
                    <code className="text-sky-400/70 bg-sky-500/5 px-1 rounded">TELEGRAM_BOT_TOKEN_2</code>…
                    Routage chatId → agent via{' '}
                    <strong className="text-muted-foreground/70">Agents › Config › Telegram</strong>.
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── BOTS TAB ── */}
        {tab === 'bots' && (
          <div className="p-6 space-y-3 max-w-2xl mx-auto w-full">
            {bots.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                <Bot size={36} className="text-muted-foreground/15" />
                <p className="text-sm text-muted-foreground/40">Aucun bot configuré</p>
                <button
                  onClick={() => setShowCreate(true)}
                  className="text-xs text-primary hover:text-primary/80"
                >
                  + Ajouter un bot
                </button>
              </div>
            ) : (
              bots.map(bot => (
                <div key={bot.id} className="bg-card rounded-xl border border-border/50 overflow-hidden">
                  {/* Bot header row */}
                  <div className="flex items-center gap-3 p-4">
                    <div className="relative shrink-0">
                      <div className="w-9 h-9 rounded-xl bg-sky-500/10 flex items-center justify-center">
                        <Bot size={16} className="text-sky-400/70" />
                      </div>
                      <StateDot running={bot.running} enabled={bot.enabled} hasToken={bot.hasToken} />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-[13px] font-semibold text-foreground">{bot.id}</p>
                        <StatusBadge running={bot.running} enabled={bot.enabled} hasToken={bot.hasToken} />
                      </div>
                    </div>

                    {editingId === bot.id ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => { setEditingId(null); setShowToken(false); }}
                          className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          Annuler
                        </button>
                        <button
                          onClick={() => void handleSave(bot.id)}
                          disabled={savingId === bot.id}
                          className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors font-medium"
                        >
                          {savingId === bot.id ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => void handleRestart(bot.id)}
                          disabled={restartingId === bot.id}
                          title="Restart"
                          className="p-1.5 text-muted-foreground/40 hover:text-foreground hover:bg-secondary rounded-lg transition-colors disabled:opacity-40"
                        >
                          <RotateCw size={13} className={restartingId === bot.id ? 'animate-spin' : ''} />
                        </button>
                        <button
                          onClick={() => { setEditingId(bot.id); setEditDraft({ token: '', enabled: bot.enabled }); setShowToken(false); }}
                          title="Éditer"
                          className="p-1.5 text-muted-foreground/40 hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
                        >
                          <Settings size={13} />
                        </button>
                        <button
                          onClick={() => void handleDelete(bot.id)}
                          title="Supprimer"
                          className="p-1.5 text-destructive/40 hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Edit form */}
                  {editingId === bot.id && (
                    <div className="border-t border-border/50 px-4 pb-4 pt-3 space-y-3 bg-card/50">
                      <div>
                        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">
                          Token
                        </label>
                        <div className="mt-1 relative">
                          <input
                            type={showToken ? 'text' : 'password'}
                            value={editDraft.token}
                            onChange={e => setEditDraft(d => ({ ...d, token: e.target.value }))}
                            placeholder="Laisser vide pour ne pas changer"
                            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 pr-9 text-sm font-mono text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
                          />
                          <button
                            type="button"
                            onClick={() => setShowToken(v => !v)}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                          >
                            {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-foreground/80">Activé</p>
                          <p className="text-[11px] text-muted-foreground/40">Le bot répond aux messages entrants</p>
                        </div>
                        <Toggle value={editDraft.enabled} onChange={() => setEditDraft(d => ({ ...d, enabled: !d.enabled }))} />
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}

            {/* Env note */}
            <div className="mt-2 bg-card/40 rounded-xl p-3 border border-border/30">
              <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                Tokens via variables d'env :{' '}
                <code className="text-sky-400/70 bg-sky-500/5 px-1 rounded">TELEGRAM_BOT_TOKEN</code>,{' '}
                <code className="text-sky-400/70 bg-sky-500/5 px-1 rounded">TELEGRAM_BOT_TOKEN_2</code>…
                Routage chatId → agent via{' '}
                <strong className="text-muted-foreground/70">Agents › Config › Telegram</strong>.
              </p>
            </div>
          </div>
        )}

        {/* ── NCM TAB ── */}
        {tab === 'ncm' && (
          <div className="p-6 space-y-4 max-w-2xl mx-auto w-full">
            <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
              {/* Header */}
              <div className="px-4 py-3 border-b border-border/50">
                <div className="flex items-center gap-2">
                  <Mic size={14} className="text-purple-400" />
                  <h3 className="text-[13px] font-semibold text-foreground">NCM — Voice Service</h3>
                </div>
                <p className="text-[11px] text-muted-foreground/50 mt-1">
                  Connexion au service vocal NCM pour le support STT/TTS dans Telegram.
                </p>
              </div>

              {/* Body */}
              <div className="px-4 py-4 space-y-4">
                <div>
                  <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">
                    URL de base NCM
                  </label>
                  <input
                    value={ncmUrl}
                    onChange={e => { setNcmUrl(e.target.value); setNcmTestResult(null); }}
                    placeholder="http://127.0.0.1:7600"
                    disabled={!ncmLoaded}
                    className="mt-1 w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/30 disabled:opacity-50"
                  />
                </div>

                {/* Test result */}
                {ncmTestResult && (
                  <div className={clsx(
                    'flex items-start gap-2 px-3 py-2 rounded-lg text-xs',
                    ncmTestResult.ok
                      ? 'bg-theme-green/10 text-theme-green'
                      : 'bg-destructive/10 text-destructive',
                  )}>
                    {ncmTestResult.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> : <XCircle size={13} className="mt-0.5 shrink-0" />}
                    <span>{ncmTestResult.message}</span>
                  </div>
                )}

                {/* Buttons */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void handleNcmSave()}
                    disabled={ncmSaving || !ncmLoaded}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg transition-colors font-medium disabled:opacity-40"
                  >
                    {ncmSaving ? <Loader2 size={12} className="animate-spin" /> : null}
                    Sauvegarder
                  </button>
                  <button
                    onClick={() => void handleNcmTest()}
                    disabled={ncmTesting || !ncmUrl.trim()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground bg-secondary hover:bg-secondary/80 rounded-lg transition-colors disabled:opacity-40"
                  >
                    {ncmTesting ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
                    Sauvegarder & Tester
                  </button>
                </div>
              </div>
            </div>

            {/* Info */}
            <div className="bg-card/40 rounded-xl p-3 border border-border/30">
              <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                NCM gère la transcription vocale (STT) et la synthèse vocale (TTS) via Mercury.
                Activez le mode vocal par chat avec{' '}
                <code className="text-purple-400/70 bg-purple-500/5 px-1 rounded">/voice on</code>{' '}
                ou via le menu inline du bot. La config voix par agent (modèle TTS/STT, voix) se fait dans l'interface NCM.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl w-full max-w-md shadow-2xl border border-border/50 overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
              <div className="w-8 h-8 rounded-xl bg-sky-500/15 flex items-center justify-center">
                <Bot size={15} className="text-sky-400" />
              </div>
              <h2 className="text-[14px] font-semibold text-foreground">Nouveau bot Telegram</h2>
            </div>

            {/* Modal body */}
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">
                  Identifiant
                </label>
                <input
                  value={newBot.id}
                  onChange={e => setNewBot(p => ({ ...p, id: e.target.value.toLowerCase().replace(/\s+/g, '-') }))}
                  placeholder="mon-bot"
                  className="mt-1 w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">
                  Token BotFather
                </label>
                <div className="mt-1 relative">
                  <input
                    type={showNewToken ? 'text' : 'password'}
                    value={newBot.token}
                    onChange={e => setNewBot(p => ({ ...p, token: e.target.value }))}
                    placeholder="1234567890:AAF…"
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 pr-9 text-sm font-mono text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewToken(v => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                  >
                    {showNewToken ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <div>
                  <p className="text-sm text-foreground/80">Activer maintenant</p>
                  <p className="text-[11px] text-muted-foreground/40">Le bot démarre immédiatement</p>
                </div>
                <Toggle value={newBot.enabled} onChange={() => setNewBot(p => ({ ...p, enabled: !p.enabled }))} />
              </div>
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/50 bg-card/50">
              <button
                onClick={() => { setShowCreate(false); setNewBot(DEFAULT_NEW); setShowNewToken(false); }}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Annuler
              </button>
              <button
                onClick={() => void handleCreate()}
                disabled={creating || !newBot.id || !newBot.token}
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors font-medium"
              >
                {creating ? 'Création…' : 'Créer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Onglet « Police de livraison » — vue par-agent de la policy v3 (granulaire).
// Accordéon : un agent ouvert à la fois ; on charge sa config complète (delivery)
// à l'ouverture (le hook useAgents ne porte pas le champ delivery). L'édition réutilise
// le composant partagé DeliveryPolicyEditor, exactement comme l'onglet Config d'un agent.
// ════════════════════════════════════════════════════════════════════════════

/** Réponse partielle de /api/agents/:id — on n'a besoin que de delivery + identité ici. */
interface AgentDeliveryDetail {
  identity: { id: string; name: string; emoji: string };
  delivery?: AgentDeliveryPolicy | null;
}

function DeliveryTab() {
  const { agents, loading } = useAgents();
  // On ne pilote que les agents principaux (les sub-agents n'ont ni chat direct ni delivery).
  const mainAgents = agents.filter(a => a.kind !== 'subagent');
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="p-6 space-y-3 max-w-2xl mx-auto w-full">
      <div className="bg-card/40 rounded-xl p-3 border border-border/30">
        <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
          Pour chaque agent : qui sonne quand il te livre quelque chose, et sur quelle surface.
          La même policy est éditable depuis <strong className="text-muted-foreground/80">Agents › Config › Livraison</strong>.
          Un override par-tâche (<Link to="/scheduler" className="text-primary hover:underline">Tâches</Link>) reste prioritaire sur cette policy.
        </p>
      </div>

      {loading && mainAgents.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground/40">Chargement…</div>
      ) : mainAgents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Bell size={36} className="text-muted-foreground/15" />
          <p className="text-sm text-muted-foreground/40">Aucun agent principal</p>
        </div>
      ) : (
        mainAgents.map(a => (
          <DeliveryAgentRow
            key={a.identity.id}
            agentId={a.identity.id}
            name={a.identity.name}
            emoji={a.identity.emoji}
            open={openId === a.identity.id}
            onToggleOpen={() => setOpenId(prev => (prev === a.identity.id ? null : a.identity.id))}
          />
        ))
      )}
    </div>
  );
}

function DeliveryAgentRow({ agentId, name, emoji, open, onToggleOpen }: {
  agentId: string;
  name: string;
  emoji: string;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const [detail, setDetail] = useState<AgentDeliveryDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  // Ref race-safe : l'éditeur renvoie la policy complète, on persiste tel quel et on tient à jour
  // la ref pour qu'un enchaînement rapide de toggles parte de la dernière intention (même logique
  // que delRef dans AgentConfigTab). Le backend REMPLACE l'objet entier à chaque PUT.
  const delRef = useRef<AgentDeliveryPolicy | null>(null);

  const fetchDetail = useCallback(() => {
    api.get<AgentDeliveryDetail>(`/api/agents/${agentId}`)
      .then(d => {
        setDetail(d);
        delRef.current = d.delivery ?? null;
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [agentId]);

  // Charge la config (delivery) à la première ouverture seulement.
  useEffect(() => {
    if (open && !loaded) fetchDetail();
  }, [open, loaded, fetchDetail]);

  const onChange = async (next: AgentDeliveryPolicy | null) => {
    delRef.current = next;
    // Si le fetch initial a échoué (detail=null mais loaded=true), `prev ? … : prev` laissait
    // un no-op → les badges restaient 'legacy' malgré un PUT réussi. On construit un detail minimal
    // pour que le résumé reflète la policy sauvegardée (bug hunt 2026-06-13).
    setDetail(prev =>
      prev ? { ...prev, delivery: next } : { identity: { id: agentId, name: agentId, emoji: '' }, delivery: next },
    );
    setSaving(true);
    try {
      await api.put(`/api/agents/${agentId}/config`, { delivery: next });
    } finally {
      setSaving(false);
    }
  };

  // Résumé compact (badges) lisible plié, dérivé de la policy chargée.
  const policy = detail?.delivery ?? null;
  const summary = !loaded
    ? null
    : policy
      ? policyBadges(policy)
      : ['legacy'];

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      <button
        type="button"
        onClick={onToggleOpen}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-secondary/20 transition-colors"
      >
        <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center text-lg shrink-0">
          {emoji || '🤖'}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-foreground">{name}</p>
          <p className="text-[11px] font-mono text-muted-foreground/50 truncate">{agentId}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {summary?.map(s => (
            <span key={s} className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground/70 border border-border/50">
              {s}
            </span>
          ))}
          {saving && <Loader2 size={12} className="animate-spin text-muted-foreground/50" />}
          <ChevronRight size={14} className={clsx('text-muted-foreground/40 transition-transform', open && 'rotate-90')} />
        </div>
      </button>

      {open && (
        <div className="border-t border-border/50 px-4 pb-4 pt-3 bg-card/50">
          {!loaded ? (
            <div className="py-6 text-center text-xs text-muted-foreground/40">Chargement de la config…</div>
          ) : (
            <DeliveryPolicyEditor policy={policy} onChange={(next) => void onChange(next)} embedded />
          )}
        </div>
      )}
    </div>
  );
}

/** Badges résumé d'une policy v3 (vue pliée). */
function policyBadges(p: AgentDeliveryPolicy): string[] {
  const out: string[] = [];
  const mob = p.mobile?.triggers;
  out.push(`mobile: ${mob === undefined ? 'tous' : mob.length === 0 ? 'aucun' : `${mob.length}`}`);
  out.push(`tg: ${p.telegram?.mode ?? 'on'}`);
  if (p.mobile?.presenceDedup) out.push('dedup');
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// Onglet « Mobile » — appareils push enregistrés (registry APNs) + état du canal.
// Endpoints backend (read-only, routes/push.ts) :
//   GET /api/push/         → { enabled, configured, devices } (statut du canal)
//   GET /api/push/devices  → [{ tokenTail, platform, agentId, createdAt, lastSeenAt }]
// ════════════════════════════════════════════════════════════════════════════

interface PushStatus {
  enabled?: boolean;
  configured?: boolean;
  production?: boolean;
  topic?: string;
  deviceCount?: number;
}
interface PushDevice {
  tokenTail: string;
  platform: string;
  agentId: string | null;
  createdAt?: string | number;
  lastSeenAt?: string | number;
}

function MobileTab() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Statut + liste appareils en parallèle. Tolérant : un échec sur l'un n'efface pas l'autre.
      const [st, dv] = await Promise.allSettled([
        api.get<PushStatus>('/api/push'),
        api.get<PushDevice[]>('/api/push/devices'),
      ]);
      if (st.status === 'fulfilled') setStatus(st.value);
      if (dv.status === 'fulfilled') setDevices(Array.isArray(dv.value) ? dv.value : []);
      if (st.status === 'rejected' && dv.status === 'rejected') {
        setError('Canal push injoignable (push non configuré ?)');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const fmtDate = (v?: string | number) => {
    if (v == null) return '—';
    const d = new Date(typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : v);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  const enabled = status?.enabled ?? false;
  const configured = status?.configured ?? false;

  return (
    <div className="p-6 space-y-4 max-w-2xl mx-auto w-full">
      {/* État du canal */}
      <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-border/50 flex items-center gap-2">
          <Smartphone size={14} className="text-primary" />
          <h3 className="text-[13px] font-semibold text-foreground">Mobile push channel (APNs)</h3>
          {loading && <Loader2 size={12} className="animate-spin text-muted-foreground/40 ml-auto" />}
        </div>
        <div className="px-4 py-4">
          {error ? (
            <p className="text-xs text-destructive/80">{error}</p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <PushStat label="Canal" value={enabled ? 'Activé' : 'Désactivé'} ok={enabled} />
              <PushStat label="APNs configuré" value={configured ? 'Oui' : 'Non'} ok={configured} />
              <PushStat label="Appareils" value={String(status?.deviceCount ?? devices.length)} ok={(status?.deviceCount ?? devices.length) > 0} />
            </div>
          )}
          <p className="text-[11px] text-muted-foreground/50 mt-3 leading-relaxed">
            La config APNs (clé .p8, keyId, topic) se règle dans{' '}
            <Link to="/settings" className="text-primary hover:underline">Settings</Link>. Les appareils s'enregistrent
            automatically from the mobile app each time an APNs token is obtained.
          </p>
        </div>
      </div>

      {/* Appareils enregistrés */}
      <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-foreground">Appareils enregistrés</h3>
          <button
            type="button"
            onClick={() => void load()}
            className="p-1.5 text-muted-foreground/50 hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
            title="Rafraîchir"
            aria-label="Rafraîchir"
          >
            <RotateCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="divide-y divide-border/40">
          {devices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
              <Smartphone size={32} className="text-muted-foreground/15" />
              <p className="text-sm text-muted-foreground/40">
                {loading ? 'Chargement…' : 'Aucun appareil enregistré'}
              </p>
              {!loading && (
                <p className="text-[11px] text-muted-foreground/30 max-w-xs">
                  Open the mobile app on your phone and allow notifications to register a device.
                </p>
              )}
            </div>
          ) : (
            devices.map((d, i) => (
              <div key={`${d.tokenTail}-${i}`} className="flex items-center gap-3 px-4 py-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Smartphone size={15} className="text-primary/70" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-mono text-foreground">…{d.tokenTail}</p>
                  <p className="text-[10px] text-muted-foreground/50">
                    {d.platform}{d.agentId ? ` · ${d.agentId}` : ''} · vu {fmtDate(d.lastSeenAt)}
                  </p>
                </div>
                <span className="text-[10px] text-muted-foreground/40 shrink-0">{fmtDate(d.createdAt)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function PushStat({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="bg-card/60 rounded-xl p-3 border border-border/50">
      <p className={clsx('text-base font-bold', ok ? 'text-theme-green' : 'text-muted-foreground')}>{value}</p>
      <p className="text-[11px] text-muted-foreground/60 mt-0.5">{label}</p>
    </div>
  );
}
