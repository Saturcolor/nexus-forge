/**
 * Advanced page — outils de debug/inspection bas-niveau pour l'opérateur.
 *
 * V1 :
 *  - Onglet "Prompt Builder" — render le system prompt complet d'un agent
 *    (web/telegram), section par section, en read-only.
 *
 * V2 (TODO) :
 *  - Edit YAML promptInjection (starredSkills, sharedStarredFiles, lazySkills…)
 *  - Edit fichiers IDENTITY.md / SOUL.md / workspace .md
 *  - Diff vs prompt courant
 */
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FlaskConical, FileCode2, FileEdit } from 'lucide-react';
import { clsx } from 'clsx';
import PromptBuilder from './advanced/PromptBuilder';
import TemplatesTab from './advanced/TemplatesTab';

type Tab = 'prompt-builder' | 'templates';

const TABS: { id: Tab; label: string; icon: React.ElementType; description: string }[] = [
  {
    id: 'prompt-builder',
    label: 'Prompt Builder',
    icon: FileCode2,
    description: "Inspecter le system prompt envoyé à chaque agent, section par section",
  },
  {
    id: 'templates',
    label: 'Templates',
    icon: FileEdit,
    description: "Éditer les sections du prompt (platform, environment, lazy summary…) avec variables protégées",
  },
];

export default function AdvancedPage() {
  const navigate = useNavigate();
  const params = useParams<{ tab?: string }>();
  const initial: Tab = (TABS.find(t => t.id === params.tab)?.id ?? 'prompt-builder');
  const [tab, setTab] = useState<Tab>(initial);

  const onSwitch = (id: Tab) => {
    setTab(id);
    navigate(`/advanced/${id}`);
  };

  const active = TABS.find(t => t.id === tab) ?? TABS[0];

  return (
    // h-full (not flex-1) — Layout's <main> is a block container with overflow-y-auto,
    // so flex-1 here is a no-op and the page natural-sizes itself → outer main scrolls.
    // With h-full we cap at main's clientHeight, then internal flex-1/min-h-0 chains work
    // and each pane (sidebar / viewer) handles its own scroll.
    <div className="h-full flex flex-col">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card/30 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-muted/60 flex items-center justify-center">
            <FlaskConical size={15} className="text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-[15px] font-bold text-foreground">Advanced</h1>
            <p className="text-[11px] text-muted-foreground/50">{active.description}</p>
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex items-center gap-1 px-6 border-b border-border bg-card/20 shrink-0">
        {TABS.map(t => {
          const Icon = t.icon;
          const isActive = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => onSwitch(t.id)}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors',
                isActive
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

      {/* ── Content ── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'prompt-builder' && <PromptBuilder />}
        {tab === 'templates' && <TemplatesTab />}
      </div>
    </div>
  );
}
