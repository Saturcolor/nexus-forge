import { clsx } from 'clsx';
import { SwitchThumb } from './ui/SwitchThumb';
import type { AgentDeliveryPolicy, DeliveryTrigger } from '@mastermind/shared';

/**
 * Éditeur réutilisable de la politique de livraison agent (v3, granulaire par CANAL × TRIGGER).
 * Source de vérité du contrat : `AgentDeliveryPolicy` dans `@mastermind/shared`.
 *
 * Surface unique partagée entre :
 *  - l'onglet « Police de livraison » de la page Delivery (vue par-agent), et
 *  - la carte « Livraison & Notifications » de l'onglet Config d'un agent.
 *
 * Contrat d'usage :
 *  - `policy === null` → aucune policy (comportement legacy). Le toggle maître l'active.
 *  - Le parent REMPLACE l'objet entier à chaque `onChange` (pas de merge partiel côté backend) :
 *    ce composant calcule toujours la policy complète et la renvoie en bloc. Le parent reste
 *    responsable du pattern race-safe (ref optimiste) s'il enchaîne des toggles rapides.
 */

// Triggers exposés côté Mobile (les 4) et côté Telegram (3 — pas 'interactive', cf. note).
const MOBILE_TRIGGERS: Array<{ value: DeliveryTrigger; label: string; hint: string }> = [
  { value: 'interactive', label: 'Réponse directe (quand tu es absent)', hint: 'L\'agent répond à ton message — push seulement si personne ne regarde la session.' },
  { value: 'proactive', label: 'Alerte proactive', hint: 'Handler proactif / escalade déclenché par un watcher.' },
  { value: 'task', label: 'Tâche planifiée', hint: 'Résultat d\'un cron (kind=task).' },
  { value: 'sandbox', label: 'Job sandbox', hint: 'Résultat d\'un job async dispatché.' },
];

const TELEGRAM_TRIGGERS: Array<{ value: DeliveryTrigger; label: string; hint: string }> = [
  { value: 'proactive', label: 'Alerte proactive', hint: 'Handler proactif / escalade.' },
  { value: 'task', label: 'Tâche planifiée', hint: 'Résultat d\'un cron (kind=task).' },
  { value: 'sandbox', label: 'Job sandbox', hint: 'Résultat d\'un job async dispatché.' },
];

const ALL_TRIGGERS: DeliveryTrigger[] = ['interactive', 'proactive', 'task', 'sandbox'];

export interface DeliveryPolicyEditorProps {
  /** Policy courante (v3). `null` = legacy (pas de policy). */
  policy: AgentDeliveryPolicy | null;
  /** Renvoie la policy COMPLÈTE à persister, ou `null` pour repasser en legacy. */
  onChange: (next: AgentDeliveryPolicy | null) => void;
  /** Masque le titre / wrapper de carte (utile quand l'éditeur est déjà dans une SectionCard). */
  embedded?: boolean;
}

/** Policy de départ quand on active le toggle maître (mobile-first, TG en secours, dedup présence).
 *  triggers laissés `undefined` → état « hérité / tous » jusqu'à la première interaction. */
function defaultPolicy(): AgentDeliveryPolicy {
  return {
    mobile: { presenceDedup: true },
    telegram: { mode: 'fallback' },
    liveActivity: 'all',
    proactiveAlerts: 'all',
  };
}

export function DeliveryPolicyEditor({ policy, onChange, embedded }: DeliveryPolicyEditorProps) {
  const active = !!policy;

  // Master ON → policy recommandée. Master OFF → null (retour legacy complet).
  const toggleMaster = () => onChange(active ? null : defaultPolicy());

  // Helper : merge un patch dans la policy courante et renvoie l'objet complet.
  const patch = (p: Partial<AgentDeliveryPolicy>) => {
    onChange({ ...(policy ?? {}), ...p });
  };

  // ── Mobile ──
  const mobileTriggers = policy?.mobile?.triggers; // undefined = hérité (tous cochés visuellement)
  const mobileInherited = mobileTriggers === undefined;
  const mobileChecked = (t: DeliveryTrigger) => mobileInherited || mobileTriggers!.includes(t);
  const toggleMobileTrigger = (t: DeliveryTrigger) => {
    // Première interaction sur un état hérité → matérialise le tableau explicite « tous », puis
    // retire le trigger décoché. Sinon toggle classique sur le tableau existant.
    const base = mobileInherited ? [...ALL_TRIGGERS] : [...mobileTriggers!];
    const next = base.includes(t) ? base.filter(x => x !== t) : [...base, t];
    patch({ mobile: { ...(policy?.mobile ?? {}), triggers: next } });
  };
  const togglePresenceDedup = () => {
    patch({ mobile: { ...(policy?.mobile ?? {}), presenceDedup: !(policy?.mobile?.presenceDedup ?? false) } });
  };

  // ── Telegram ──
  const tgMode = policy?.telegram?.mode ?? 'on';
  const tgTriggers = policy?.telegram?.triggers; // undefined = aucun trigger auto (défaut legacy TG)
  const tgInherited = tgTriggers === undefined;
  const tgChecked = (t: DeliveryTrigger) => !tgInherited && tgTriggers!.includes(t);
  const setTgMode = (mode: 'on' | 'fallback' | 'off') => {
    patch({ telegram: { ...(policy?.telegram ?? {}), mode } });
  };
  const toggleTgTrigger = (t: DeliveryTrigger) => {
    const base = tgInherited ? [] : [...tgTriggers!];
    const next = base.includes(t) ? base.filter(x => x !== t) : [...base, t];
    patch({ telegram: { ...(policy?.telegram ?? {}), triggers: next } });
  };

  const body = (
    <>
      <SwitchRow
        label="Politique de livraison personnalisée"
        description="Décide QUI sonne quand l'agent te livre quelque chose (send_to_user, briefings, escalades). OFF = comportement legacy : Telegram + push mobile sur les runs proactifs, le modèle choisit le canal. ON = c'est TOI qui décides ci-dessous — le choix du modèle est filtré par cette policy."
        on={active}
        onToggle={toggleMaster}
      />

      {policy && (
        <div className="space-y-4 pl-1 pt-2 border-t border-border/50">
          {/* Hint global */}
          <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
            Policy active mais triggers <span className="font-medium text-foreground/70">non touchés</span> = comportement
            legacy par défaut (mobile : tous les triggers ; Telegram : aucun auto hors reply native). Coche/décoche pour
            matérialiser un choix explicite.
          </p>

          {/* ── Section Mobile ── */}
          <div className="space-y-2">
            <SubHeader title="Mobile (push / APNs)" />
            <TriggerGroup
              triggers={MOBILE_TRIGGERS}
              checked={mobileChecked}
              inherited={mobileInherited}
              onToggle={toggleMobileTrigger}
            />
            <SwitchRow
              label="Ne pas sonner si je regarde déjà la session"
              description="Si un client (web ou app mobile) regarde activement la session au moment de la livraison, le push APNs est supprimé — tu as le contenu sous les yeux. (Dédup par présence.)"
              on={policy.mobile?.presenceDedup ?? false}
              onToggle={togglePresenceDedup}
            />
          </div>

          {/* ── Section Telegram ── */}
          <div className="space-y-2 pt-1">
            <SubHeader title="Telegram (sortant)" />
            <FieldRow label="Mode du canal">
              <SegmentSelector
                value={tgMode}
                options={[
                  { value: 'on', label: 'on', hint: 'canal normal' },
                  { value: 'fallback', label: 'fallback', hint: 'si mobile injoignable' },
                  { value: 'off', label: 'off', hint: 'jamais en auto' },
                ]}
                onChange={setTgMode}
              />
            </FieldRow>
            <div>
              <TriggerGroup
                triggers={TELEGRAM_TRIGGERS}
                checked={tgChecked}
                inherited={false}
                disabled={tgMode === 'off'}
                onToggle={toggleTgTrigger}
              />
              <p className="text-[11px] text-muted-foreground/60 mt-1.5 leading-relaxed">
                La reply à un message reçu <span className="font-medium text-foreground/70">depuis Telegram</span> (TG-native
                interactive) repart toujours sur Telegram, hors de cette liste — c'est le bridge entrant, jamais filtré.
                {tgMode === 'off' && ' Mode off : aucun trigger auto sélectionnable.'}
              </p>
            </div>
          </div>

          {/* ── Live Activity / Dynamic Island ── */}
          <div className="pt-1">
            <FieldRow label="Live Activity / Dynamic Island">
              <SegmentSelector
                value={policy.liveActivity ?? 'all'}
                options={[
                  { value: 'all', label: 'tous les runs' },
                  { value: 'user', label: 'runs utilisateur' },
                  { value: 'off', label: 'off' },
                ]}
                onChange={(v) => patch({ liveActivity: v })}
              />
              <p className="text-[11px] text-muted-foreground/60 mt-1">
                « runs utilisateur » = l'île ne s'allume plus pour les briefings/escalades/cron — uniquement quand TU lances un run.
              </p>
            </FieldRow>
          </div>

          {/* ── Alertes proactives ── */}
          <div className="pt-1">
            <FieldRow label="Alertes proactives (toast + carte)">
              <SegmentSelector
                value={policy.proactiveAlerts ?? 'all'}
                options={[
                  { value: 'all', label: 'toast + carte' },
                  { value: 'quiet', label: 'carte silencieuse' },
                  { value: 'off', label: 'off' },
                ]}
                onChange={(v) => patch({ proactiveAlerts: v })}
              />
              <p className="text-[11px] text-muted-foreground/60 mt-1">
                "silent card" = the alert is persisted in the notification center (web + mobile) but without a toast/banner.
              </p>
            </FieldRow>
          </div>
        </div>
      )}
    </>
  );

  // `embedded` est conservé pour la sémantique d'appel (l'éditeur est déjà dans une SectionCard
  // côté Config, ou dans une carte d'accordéon côté page Delivery) ; le wrapper est identique
  // dans les deux cas — pas de titre/carte propre, juste l'empilement vertical des contrôles.
  void embedded;
  return <div className="space-y-2">{body}</div>;
}

// ── Sous-composants locaux (même style que AgentConfigTab) ──

function SubHeader({ title }: { title: string }) {
  return (
    <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">{title}</h4>
  );
}

function TriggerGroup({ triggers, checked, inherited, disabled, onToggle }: {
  triggers: Array<{ value: DeliveryTrigger; label: string; hint: string }>;
  checked: (t: DeliveryTrigger) => boolean;
  /** true → cases cochées affichées en mode « hérité / par défaut » (visuellement atténué). */
  inherited: boolean;
  disabled?: boolean;
  onToggle: (t: DeliveryTrigger) => void;
}) {
  return (
    <div className={clsx('grid grid-cols-1 sm:grid-cols-2 gap-1', disabled && 'opacity-40 pointer-events-none')}>
      {triggers.map(t => {
        const on = checked(t.value);
        return (
          <label
            key={t.value}
            title={t.hint}
            className="flex items-start gap-2 cursor-pointer text-xs text-foreground hover:bg-secondary/40 px-2 py-1.5 rounded transition-colors"
          >
            <input
              type="checkbox"
              checked={on}
              disabled={disabled}
              onChange={() => onToggle(t.value)}
              className="mt-0.5 cursor-pointer accent-primary"
            />
            <span className={clsx('leading-snug', on && inherited && 'text-muted-foreground/70 italic')}>
              {t.label}
              {on && inherited && <span className="text-[10px] text-muted-foreground/50"> (hérité)</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider block">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function SwitchRow({ label, description, on, onToggle, disabled }: {
  label: string;
  description?: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={clsx(
        'w-full flex items-center justify-between gap-3 py-1 rounded px-1 -mx-1 transition-colors text-left',
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-secondary/40',
      )}
    >
      <div>
        <span className="text-[12px] text-foreground block">{label}</span>
        {description && <p className="text-[11px] text-muted-foreground/60 mt-0.5">{description}</p>}
      </div>
      <SwitchThumb on={on} />
    </button>
  );
}

/** Sélecteur segmenté générique (même style que AgentConfigTab). */
function SegmentSelector<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ value: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map(opt => {
        const isActive = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.hint}
            onClick={() => onChange(opt.value)}
            className={clsx(
              'flex-1 px-2 py-1 rounded text-[11px] font-mono border transition-colors',
              isActive
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-secondary text-muted-foreground border-border hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
