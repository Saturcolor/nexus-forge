/**
 * Slash command parser for Mastermind agents.
 *
 * Options are PERSISTENT per session — set once, active until explicitly cleared.
 *
 * Commands:
 *   /think [off|low|med|high]   — reasoning budget (extended thinking Anthropic)
 *   /model [<id>|off]           — override model pour la session
 *   /temp [<0.0-2.0>|off]      — override température pour la session
 *   /tools [on|off]             — activer/désactiver les outils
 *   /status                     — afficher les options actives (no LLM call)
 *   /help                       — afficher les commandes (no LLM call)
 *
 * Pour effacer un réglage : utiliser "off" ou "default" comme valeur.
 * Exemple : /model off  →  revient au modèle par défaut de l'agent
 */

/** What a parsed message updates in the session options.
 *  - number|string|boolean = set this value
 *  - null                  = explicitly clear (restore agent default)
 *  - undefined             = not mentioned, don't touch
 *
 *  thinkBudget is NOT here — it's an agent-level setting (single source of truth).
 *  See SessionAgentUpdate.thinkBudget below for the directive-side payload.
 */
export interface SessionUpdate {
  modelOverride?: string | null;      // null = use agent default
  temperatureOverride?: number | null; // null = use agent default
  toolsDisabled?: boolean;            // true = no tools, false = tools on
  toolsHidden?: boolean;              // true = hide tool events in UI, false = show
  telegramStreaming?: boolean;        // true = streaming edit mode for Telegram
  telegramMercuryStatus?: boolean;    // true = show Mercury loading/processing status messages
  telegramReasoningMode?: 'full' | 'light' | 'off' | null; // full = stream content, light = "Réflexion en cours…" + timer, off = hidden. null = clear (= full default)
  telegramDraft?: boolean;            // true = use Bot API 9.5+ sendMessageDraft for native streaming animation (DM only)
  telegramFinalNotif?: boolean;       // true = at finalize, delete the streaming bubble and send the final answer as a new message (triggers a push notification; only meaningful when streaming + reasoningMode != 'off')
  telegramVoice?: boolean;            // true = reply with TTS audio via NCM
}

/** Agent-level updates extracted from directives — applied via AgentModule.setAgentThinkBudget. */
export interface AgentLevelUpdate {
  thinkBudget?: 'off' | 'low' | 'medium' | 'high' | null; // null = clear (= off)
}

export interface SessionOptions {
  modelOverride?: string;      // undefined = use agent default
  temperatureOverride?: number; // undefined = use agent default
  toolsDisabled?: boolean;     // undefined/false = tools on
  toolsHidden?: boolean;       // undefined/false = show tool events in UI
  telegramStreaming?: boolean;  // undefined/false = batch mode for Telegram
  telegramMercuryStatus?: boolean; // undefined/false = no Mercury status messages
  telegramReasoningMode?: 'full' | 'light' | 'off'; // undefined = full (default). full = stream content; light = "Réflexion en cours…" + timer; off = hidden
  telegramDraft?: boolean;      // undefined/false = edit-message streaming, true = native sendMessageDraft animation (DM only)
  telegramFinalNotif?: boolean; // undefined/false = finalize edits the streaming bubble in-place; true = at finalize delete the streaming bubble and send a fresh sendMessage (triggers push notif). No-op in batch mode, voice-only, or when nativeDraft is active (which already sends at finalize). Works in groups too but the push-notif benefit is mainly relevant for DM/light/full reasoning modes
  telegramVoice?: boolean;      // undefined/false = text only, true = reply with TTS audio via NCM
}

export interface MessageDirectives {
  /** Message content with all directives stripped */
  cleanedContent: string;
  /** True when the message had no content beyond directives */
  isCommandOnly: boolean;
  /** Direct response to broadcast without calling the LLM */
  commandResponse?: string;
  /** What to update in the session options */
  updates: SessionUpdate;
  /** Agent-level updates (e.g. /think) — applied to the agent config, not the session */
  agentUpdates: AgentLevelUpdate;
}

// /think values normalized to the canonical agent enum
const THINK_LEVELS: Record<string, 'low' | 'medium' | 'high'> = {
  low:    'low',
  med:    'medium',
  medium: 'medium',
  high:   'high',
};

const CLEAR_WORDS = new Set(['off', 'default', 'non', 'clear', 'reset', 'aucun']);

export const HELP_TEXT = `**Commandes disponibles** *(persistantes jusqu'à changement)*

**── Interface Web (inchat) ──**
\`/think [off|low|med|high]\`   niveau de raisonnement (extended thinking)
\`/model [<modelId>|off]\`       changer de modèle pour cette session
\`/temp [<0.0-2.0>|off]\`       override de température
\`/tools [on|off]\`              activer/désactiver les outils de l'agent
\`/tools [show|hide]\`           afficher/masquer les tool events dans l'UI
\`/compact\`                     sauvegarder et compacter le contexte (résumé + reset)
\`/status\`                      afficher les options actives de la session
\`/help\`                        afficher cette aide

**── Interface Telegram ──**
\`/reasoning [full|light|off]\`        affichage du raisonnement (full = streaming complet, light = "Réflexion en cours…" + timer, off = masqué). \`on\` = alias \`full\`
\`/streaming [on|off]\`               activer/désactiver le streaming progressif des réponses
\`/voice [on|off]\`                    activer/désactiver les réponses vocales (TTS via NCM)
\`/think\`, \`/model\`, \`/temp\`, \`/tools\`, \`/status\`, \`/help\` — identiques à l'interface web

**Outils** *(si configurés côté serveur)* : \`codebase_search\` (recherche sémantique LanceDB), \`codebase_search_read\` (lecture d'un fichier indexé, range \`lines\` supporté), \`codebase_search_list\` (listing d'un dossier indexé) — sandboxés à la racine source de l'index, à préférer à \`bash\`+grep / \`read_file\` pour explorer une codebase indexée.

**Exemples**
\`/think high\`                        active le reasoning étendu (15k tokens)
\`/think off\`                         désactive le reasoning
\`/model anthropic/claude-opus-4-5\`   change de modèle
\`/model off\`                         revient au modèle par défaut
\`/temp 0.1\`                          réponses précises
\`/tools off\`                         désactive tous les outils
\`/tools hide\`                        masque les tool events dans l'UI
\`/streaming on\`                      active le streaming Telegram (edit progressif)
\`/processing on\`                     active les messages de statut Mercury (chargement, prompt)
\`/think high Explique le kv cache\`   directive + message simultanément`;

/** Extract a directive: /name [value] — returns the value token and the remaining body */
function extract(
  body: string,
  names: string[],
): { found: true; value: string | null; remaining: string } | { found: false; remaining: string } {
  for (const name of names) {
    const re = new RegExp(`(?:^|(?<=\\s))\\/${name}(?:\\s+(\\S+))?(?=\\s|$)`, 'i');
    const m = re.exec(body);
    if (m) {
      return {
        found: true,
        value: m[1]?.trim() ?? null,
        remaining: body.slice(0, m.index) + body.slice(m.index + m[0].length),
      };
    }
  }
  return { found: false, remaining: body };
}

/** Extract a flag with no value: /name */
function extractFlag(body: string, names: string[]): { found: boolean; remaining: string } {
  for (const name of names) {
    const re = new RegExp(`(?:^|(?<=\\s))\\/${name}(?=\\s|$)`, 'i');
    const m = re.exec(body);
    if (m) {
      return {
        found: true,
        remaining: body.slice(0, m.index) + body.slice(m.index + m[0].length),
      };
    }
  }
  return { found: false, remaining: body };
}

// Normalize ONLY the seams left by stripped directives — collapse runs of
// spaces/tabs and drop trailing spaces/tabs before a newline — but PRESERVE
// newlines, blank lines and indentation so multi-line user messages (code
// pastes, logs, markdown lists, multi-paragraph prose) reach the LLM and DB
// with their real formatting intact. Sole caller is parseDirectives (line ~263)
// where `s` is the message body after directive removal, so this never collapses
// inter-line structure of user content.
function clean(s: string): string {
  // Per-line and procedural (NOT a global `/[ \t]+\n/` or `/[ \t]+$/` replace): those
  // patterns backtrack O(n²) on a long contiguous whitespace run and would stall the
  // single-threaded event loop on a large paste — the exact bug-class H2 fixes. Here every
  // regex is a bare `[ \t]{2,}` / `[ \t]+$` over a single line's body (leading indent sliced
  // off first), so the work stays O(n) and each line's leading indentation is preserved.
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let j = 0;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
    const body = line.slice(j).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '');
    lines[i] = body === '' ? '' : line.slice(0, j) + body;
  }
  return lines.join('\n').trim();
}

export function parseDirectives(rawContent: string): MessageDirectives {
  let body = rawContent.trim();
  const updates: SessionUpdate = {};
  const agentUpdates: AgentLevelUpdate = {};
  let commandResponse: string | undefined;

  // /help
  const helpR = extractFlag(body, ['help', 'aide']);
  if (helpR.found) {
    body = helpR.remaining;
    commandResponse = HELP_TEXT;
  }

  // /compact — handled by caller (needs access to session + LLM for summarization)
  const compactR = extractFlag(body, ['compact', 'compacter', 'reset']);
  if (compactR.found) {
    body = compactR.remaining;
    if (!commandResponse) commandResponse = '__compact__';
  }

  // /status — handled by caller (needs access to current session options)
  const statusR = extractFlag(body, ['status']);
  if (statusR.found) {
    body = statusR.remaining;
    // Mark with a special sentinel so the caller can inject the status text
    if (!commandResponse) commandResponse = '__status__';
  }

  // /think [off|low|med|high] — agent-level (single source of truth across chat / Telegram / scheduler)
  const thinkR = extract(body, ['think', 'pense', 'reason']);
  if (thinkR.found) {
    body = thinkR.remaining;
    const val = thinkR.value?.toLowerCase();
    if (!val || CLEAR_WORDS.has(val)) {
      agentUpdates.thinkBudget = null; // clear → off
    } else {
      agentUpdates.thinkBudget = THINK_LEVELS[val] ?? 'medium';
    }
  }

  // /model [<id>|off]
  const modelR = extract(body, ['model', 'modele', 'modèle']);
  if (modelR.found) {
    body = modelR.remaining;
    const val = modelR.value?.toLowerCase();
    if (!val || CLEAR_WORDS.has(val)) {
      updates.modelOverride = null; // clear
    } else {
      updates.modelOverride = modelR.value!; // preserve original case
    }
  }

  // /temp [<value>|off]
  const tempR = extract(body, ['temp', 'temperature', 'température']);
  if (tempR.found) {
    body = tempR.remaining;
    const val = tempR.value?.toLowerCase();
    if (!val || CLEAR_WORDS.has(val)) {
      updates.temperatureOverride = null; // clear
    } else {
      const n = parseFloat(val);
      if (!isNaN(n) && n >= 0 && n <= 2) updates.temperatureOverride = n;
    }
  }

  // /tools [on|off|show|hide]
  const toolsR = extract(body, ['tools', 'outils']);
  if (toolsR.found) {
    body = toolsR.remaining;
    const val = toolsR.value?.toLowerCase();
    if (val === 'show') {
      updates.toolsHidden = false;
    } else if (val === 'hide') {
      updates.toolsHidden = true;
    } else {
      updates.toolsDisabled = !val || val === 'off';
    }
  }

  // /streaming [on|off]
  const streamingR = extract(body, ['streaming']);
  if (streamingR.found) {
    body = streamingR.remaining;
    const val = streamingR.value?.toLowerCase();
    updates.telegramStreaming = !val || val === 'on';
  }

  // /processing [on|off]
  const processingR = extract(body, ['processing']);
  if (processingR.found) {
    body = processingR.remaining;
    const val = processingR.value?.toLowerCase();
    updates.telegramMercuryStatus = !val || val === 'on';
  }

  // /reasoning [full|light|off|on]   (on = alias full, default = full)
  const reasoningR = extract(body, ['reasoning']);
  if (reasoningR.found) {
    body = reasoningR.remaining;
    const val = reasoningR.value?.toLowerCase();
    if (val === 'off') updates.telegramReasoningMode = 'off';
    else if (val === 'light') updates.telegramReasoningMode = 'light';
    else updates.telegramReasoningMode = 'full'; // 'full', 'on', no value → full
  }

  // /voice [on|off]
  const voiceR = extract(body, ['voice', 'vocal']);
  if (voiceR.found) {
    body = voiceR.remaining;
    const val = voiceR.value?.toLowerCase();
    updates.telegramVoice = !val || val === 'on';
  }

  const cleanedContent = clean(body);
  const hasUpdates = Object.keys(updates).length > 0;
  const hasAgentUpdates = Object.keys(agentUpdates).length > 0;
  const isCommandOnly = cleanedContent === '' && (!!commandResponse || hasUpdates || hasAgentUpdates);

  if (hasUpdates || hasAgentUpdates || commandResponse) {
    console.debug(`[directives] parsed: isCommandOnly=${isCommandOnly} command=${commandResponse ?? 'none'} updates=${JSON.stringify(updates)} agentUpdates=${JSON.stringify(agentUpdates)}`);
  }

  return {
    cleanedContent,
    isCommandOnly,
    commandResponse,
    updates,
    agentUpdates,
  };
}

/** Apply a session update to existing session options */
export function applyUpdate(current: SessionOptions, update: SessionUpdate): SessionOptions {
  console.debug(`[directives] applyUpdate current=${JSON.stringify(current)} update=${JSON.stringify(update)}`);
  const next = { ...current };

  if ('modelOverride' in update) {
    if (update.modelOverride === null) delete next.modelOverride;
    else if (update.modelOverride !== undefined) next.modelOverride = update.modelOverride;
  }
  if ('temperatureOverride' in update) {
    if (update.temperatureOverride === null) delete next.temperatureOverride;
    else if (update.temperatureOverride !== undefined) next.temperatureOverride = update.temperatureOverride;
  }
  if ('toolsDisabled' in update) {
    if (update.toolsDisabled === false || update.toolsDisabled === undefined) delete next.toolsDisabled;
    else next.toolsDisabled = update.toolsDisabled;
  }
  if ('toolsHidden' in update) {
    if (update.toolsHidden === false || update.toolsHidden === undefined) delete next.toolsHidden;
    else next.toolsHidden = update.toolsHidden;
  }
  if ('telegramStreaming' in update) {
    if (update.telegramStreaming === false || update.telegramStreaming === undefined) delete next.telegramStreaming;
    else next.telegramStreaming = update.telegramStreaming;
  }
  if ('telegramMercuryStatus' in update) {
    if (update.telegramMercuryStatus === false || update.telegramMercuryStatus === undefined) delete next.telegramMercuryStatus;
    else next.telegramMercuryStatus = update.telegramMercuryStatus;
  }
  if ('telegramReasoningMode' in update) {
    // Default is 'full' (show full reasoning), so 'full'/null = clear, 'light'/'off' = stored.
    if (update.telegramReasoningMode === 'full' || update.telegramReasoningMode === null || update.telegramReasoningMode === undefined) {
      delete next.telegramReasoningMode;
    } else {
      next.telegramReasoningMode = update.telegramReasoningMode;
    }
  }
  if ('telegramDraft' in update) {
    if (update.telegramDraft === false || update.telegramDraft === undefined) delete next.telegramDraft;
    else next.telegramDraft = update.telegramDraft;
  }
  if ('telegramFinalNotif' in update) {
    if (update.telegramFinalNotif === false || update.telegramFinalNotif === undefined) delete next.telegramFinalNotif;
    else next.telegramFinalNotif = update.telegramFinalNotif;
  }
  if ('telegramVoice' in update) {
    if (update.telegramVoice === false || update.telegramVoice === undefined) delete next.telegramVoice;
    else next.telegramVoice = update.telegramVoice;
  }

  return next;
}

/** Format current session options as a compact code block (no header — caller adds it).
 *  thinkBudget est agent-level désormais — passer la valeur en paramètre pour l'afficher. */
export function formatSessionOptions(
  opts: SessionOptions,
  agentThink: 'off' | 'low' | 'medium' | 'high' = 'off',
): string {
  const toolsStr = (opts.toolsDisabled ? 'off' : 'on')
    + '  ' + (opts.toolsHidden ? '· masqué' : '· visible');

  const lines = [
    `Think    ${agentThink} (agent)`,
    `Modele   ${opts.modelOverride ?? 'defaut agent'}`,
    `Temp     ${opts.temperatureOverride !== undefined ? String(opts.temperatureOverride) : 'defaut'}  .  Tools ${toolsStr}`,
    `Stream   ${opts.telegramStreaming ? 'on' : 'off'}   Draft ${opts.telegramDraft ? 'on' : 'off'}   Perf ${opts.telegramMercuryStatus ? 'on' : 'off'}`,
    `Reason   ${opts.telegramReasoningMode ?? 'full'}   Voice ${opts.telegramVoice ? 'on' : 'off'}   Notif ${opts.telegramFinalNotif ? 'on' : 'off'}`,
  ];

  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}
