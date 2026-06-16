import { useEffect, useState } from 'react';
import { BellRing, Send, Loader2, CheckCircle2, Smartphone } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Réglages du canal push mobile (APNs) — miroir UI du bloc Telegram.
 * Lit/écrit `config.push` via /api/push/config (la clé .p8 inline n'est JAMAIS renvoyée :
 * on n'affiche qu'un marqueur "clé présente"). Save → écrit mastermind.yml côté serveur
 * (configMod.save) puis reload le module à chaud. Carte autonome (pas branchée sur l'état
 * géant de SettingsPage).
 */

interface PushConfigView {
  enabled: boolean;
  apns: {
    keyId: string;
    teamId: string;
    topic: string;
    production: boolean;
    keyPath: string;
    hasInlineKey: boolean;
  };
}

interface PushStatus {
  enabled: boolean;
  configured: boolean;
  production: boolean;
  topic: string | null;
  deviceCount: number;
}

interface Draft {
  enabled: boolean;
  keyId: string;
  teamId: string;
  topic: string;
  production: boolean;
  keyPath: string;
}

const inputCls =
  'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring';
const inputMonoCls = inputCls + ' font-mono';
const labelCls = 'text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50';

const EMPTY: Draft = { enabled: false, keyId: '', teamId: '', topic: 'com.example.myapp', production: false, keyPath: '' };

export function PushSettingsCard() {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [keyP8, setKeyP8] = useState(''); // jamais préchargé — uniquement pour coller une nouvelle clé
  const [hasInlineKey, setHasInlineKey] = useState(false);
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const loadAll = async () => {
    const cfg = await api.get<PushConfigView>('/api/push/config');
    setDraft({
      enabled: cfg.enabled,
      keyId: cfg.apns.keyId,
      teamId: cfg.apns.teamId,
      topic: cfg.apns.topic || 'com.example.myapp',
      production: cfg.apns.production,
      keyPath: cfg.apns.keyPath,
    });
    setHasInlineKey(cfg.apns.hasInlineKey);
    setKeyP8('');
    try {
      setStatus(await api.get<PushStatus>('/api/push'));
    } catch {
      /* statut best-effort */
    }
  };

  useEffect(() => {
    loadAll().catch(e => setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const apns: Record<string, unknown> = {
        keyId: draft.keyId.trim(),
        teamId: draft.teamId.trim(),
        topic: draft.topic.trim(),
        production: draft.production,
        keyPath: draft.keyPath.trim(),
      };
      // N'envoie keyP8 que si l'utilisateur a collé une nouvelle clé (sinon le serveur conserve l'existante).
      if (keyP8.trim()) apns.keyP8 = keyP8.trim();
      const res = await api.put<PushConfigView & { active: boolean }>('/api/push/config', { enabled: draft.enabled, apns });
      setMsg({
        kind: res.active ? 'ok' : 'err',
        text: res.active
          ? 'Enregistré — canal push actif ✓ (propagé dans mastermind.yml)'
          : 'Enregistré dans mastermind.yml, mais push INACTIF (vérifie enabled + clé .p8 + keyId/teamId/topic).',
      });
      await loadAll();
    } catch (e) {
      setMsg({ kind: 'err', text: 'Erreur : ' + (e instanceof Error ? e.message : String(e)) });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setMsg(null);
    try {
      const r = await api.post<{ attempted: number; delivered: number; pruned: number; errors: string[] }>('/api/push/test');
      setMsg({
        kind: r.delivered > 0 ? 'ok' : 'err',
        text: `Test : ${r.delivered}/${r.attempted} appareil(s) atteint(s)${r.errors.length ? ' — ' + r.errors.join(' · ') : ''}`,
      });
    } catch (e) {
      setMsg({ kind: 'err', text: 'Test échoué : ' + (e instanceof Error ? e.message : String(e)) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
              <BellRing size={15} className="text-emerald-400/70" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Mobile push notifications (APNs)</h3>
              <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                Push to the mobile app — mirrors the Telegram channel. Wakes the phone on send_to_user,
                proactive, and auto-deliver. Save → writes to <code className="text-[10px]">mastermind.yml</code> and hot-reloads.
              </p>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))}
              className="rounded"
            />
            Activé
          </label>
        </div>

        {/* Statut */}
        {!loading && status && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground/70">
            <span className="flex items-center gap-1">
              {status.enabled ? (
                <CheckCircle2 size={12} className="text-emerald-400/80" />
              ) : (
                <span className="w-2 h-2 rounded-full bg-muted-foreground/40 inline-block" />
              )}
              {status.enabled ? 'Actif (clé chargée)' : 'Inactif'}
            </span>
            <span className="flex items-center gap-1">
              <Smartphone size={12} /> {status.deviceCount} appareil(s) enregistré(s)
            </span>
            <span>{status.production ? 'APNs production' : 'APNs sandbox'}</span>
          </div>
        )}

        {/* Form */}
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Team ID</label>
              <input
                value={draft.teamId}
                onChange={e => setDraft(d => ({ ...d, teamId: e.target.value }))}
                className={inputMonoCls + ' mt-1'}
                placeholder="Z668A829MQ"
              />
            </div>
            <div>
              <label className={labelCls}>Key ID (.p8)</label>
              <input
                value={draft.keyId}
                onChange={e => setDraft(d => ({ ...d, keyId: e.target.value }))}
                className={inputMonoCls + ' mt-1'}
                placeholder="ABCDE12345"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Topic (bundle id)</label>
              <input
                value={draft.topic}
                onChange={e => setDraft(d => ({ ...d, topic: e.target.value }))}
                className={inputMonoCls + ' mt-1'}
                placeholder="com.example.myapp"
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.production}
                  onChange={e => setDraft(d => ({ ...d, production: e.target.checked }))}
                  className="rounded"
                />
                Production (TestFlight/App&nbsp;Store)
              </label>
            </div>
          </div>

          <div>
            <label className={labelCls}>Chemin de la clé .p8 (sur le serveur)</label>
            <input
              value={draft.keyPath}
              onChange={e => setDraft(d => ({ ...d, keyPath: e.target.value }))}
              className={inputMonoCls + ' mt-1'}
              placeholder="/opt/mastermind/secrets/AuthKey_ABCDE12345.p8"
            />
          </div>

          <div>
            <label className={labelCls}>
              … ou colle le contenu .p8 {hasInlineKey && <span className="text-emerald-400/70 normal-case">(une clé est déjà enregistrée — laisse vide pour la garder)</span>}
            </label>
            <textarea
              value={keyP8}
              onChange={e => setKeyP8(e.target.value)}
              className={inputMonoCls + ' mt-1 h-20 resize-y'}
              placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
              spellCheck={false}
            />
            <p className="text-[10px] text-muted-foreground/40 mt-1">
              Recommandé : utiliser un <span className="font-mono">keyPath</span> plutôt que coller la clé (évite de
              stocker la clé privée dans le YAML synchronisé). production=false pour un build Xcode (token sandbox).
            </p>
          </div>
        </div>

        {/* Message */}
        {msg && (
          <p className={msg.kind === 'ok' ? 'text-[12px] text-emerald-400/90' : 'text-[12px] text-red-400/90'}>{msg.text}</p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => void save()}
            disabled={saving || loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
            Enregistrer
          </button>
          <button
            onClick={() => void test()}
            disabled={testing || loading || !status?.enabled}
            title={status?.enabled ? 'Envoyer un push de test à tous les appareils' : 'Push inactif — enregistre une config valide d’abord'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground bg-secondary hover:bg-secondary/80 rounded-lg transition disabled:opacity-50"
          >
            {testing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            Tester
          </button>
        </div>
      </div>
    </div>
  );
}
