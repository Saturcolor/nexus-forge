/**
 * Dev-only fetch mock pour tester le SchedulerPage sans backend.
 * Activé via VITE_MOCK_API=1 dans .env.development.local. Ne s'embarque jamais
 * en build prod (l'import est gardé par `import.meta.env.DEV` côté main.tsx).
 *
 * Couvre uniquement les endpoints lus par TasksTab : /api/scheduler/tasks,
 * /api/agents, /api/status. Les autres endpoints retombent sur le fetch original
 * (et échoueront, ce qui est OK pour notre vérif visuelle ciblée).
 */

interface MockTask {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  scheduleKind: 'once' | 'cron';
  scheduledAt?: string;
  cronExpression?: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  createdBy: 'user' | 'agent';
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunStatus?: string;
  createdAt: string;
  updatedAt: string;
  kind: 'task' | 'proactive';
  autoDeliver?: boolean;
}

function isoIn(hours: number, minutes = 0): string {
  const d = new Date();
  d.setHours(d.getHours() + hours, d.getMinutes() + minutes, 0, 0);
  return d.toISOString();
}

function isoDays(days: number, h = 6): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
}

const now = new Date().toISOString();

// Watchers proactifs (kind=proactive) — pour vérifier l'onglet Proactif.
const MOCK_PROACTIVE: (MockTask & { escalationAgentId?: string; severityThreshold?: string })[] = [
  {
    id: 'p1', name: 'Monitor important emails', agentId: 'researcher',
    prompt: 'Watch inbox for important messages', scheduleKind: 'cron',
    cronExpression: '*/15 * * * *', enabled: true, deleteAfterRun: false,
    createdBy: 'user', nextRunAt: isoIn(0, 10), lastRunStatus: 'completed',
    kind: 'proactive', escalationAgentId: 'assistant', severityThreshold: 'medium',
    createdAt: now, updatedAt: now,
  },
  {
    id: 'p2', name: 'Calendar slot check', agentId: 'planner',
    prompt: 'Watch agenda for next available slot', scheduleKind: 'cron',
    cronExpression: '0 8 * * 1-5', enabled: true, deleteAfterRun: false,
    createdBy: 'user', nextRunAt: isoDays(1, 8), lastRunStatus: 'completed',
    kind: 'proactive', escalationAgentId: 'researcher', severityThreshold: 'high',
    createdAt: now, updatedAt: now,
  },
  {
    id: 'p3', name: 'Infrastructure health check', agentId: 'assistant',
    prompt: 'Watch service deployments and alert on errors', scheduleKind: 'cron',
    cronExpression: '0 */2 * * *', enabled: false, deleteAfterRun: false,
    createdBy: 'agent', nextRunAt: isoIn(2, 0), lastRunStatus: 'completed',
    kind: 'proactive', escalationAgentId: 'assistant', severityThreshold: 'medium',
    createdAt: now, updatedAt: now,
  },
];

// Demo scheduled tasks (7 tasks, 3 agents).
const MOCK_TASKS: MockTask[] = [
  {
    id: 't1', name: 'Monday strategic briefing', agentId: 'assistant',
    prompt: 'Weekly summary and priorities', scheduleKind: 'cron',
    cronExpression: '0 6 * * 1', enabled: true, deleteAfterRun: false,
    createdBy: 'agent', nextRunAt: isoDays(3, 6), kind: 'task',
    createdAt: now, updatedAt: now,
  },
  {
    id: 't2', name: 'Daily search signal digest', agentId: 'assistant',
    prompt: 'Evaluate daily search signals and summarize', scheduleKind: 'cron',
    cronExpression: '10 22 * * *', enabled: true, deleteAfterRun: false,
    createdBy: 'agent', nextRunAt: isoIn(8), lastRunStatus: 'completed',
    kind: 'task', createdAt: now, updatedAt: now,
  },
  {
    id: 't3', name: 'One-time reminder', agentId: 'researcher',
    prompt: 'Send reminder', scheduleKind: 'once',
    scheduledAt: isoDays(26, 8), enabled: true, deleteAfterRun: true,
    createdBy: 'agent', nextRunAt: isoDays(26, 8), kind: 'task',
    createdAt: now, updatedAt: now,
  },
  {
    id: 't4', name: 'Daily agenda', agentId: 'planner',
    prompt: 'Summarize today\'s schedule', scheduleKind: 'cron',
    cronExpression: '15 6 * * *', enabled: true, deleteAfterRun: false,
    createdBy: 'user', nextRunAt: isoDays(1, 6), lastRunStatus: 'completed',
    kind: 'task', createdAt: now, updatedAt: now,
  },
  {
    id: 't5', name: 'Morning briefing', agentId: 'researcher',
    prompt: 'Morning summary of news and tasks', scheduleKind: 'cron',
    cronExpression: '35 6 * * *', enabled: true, deleteAfterRun: false,
    createdBy: 'agent', nextRunAt: isoDays(1, 6), lastRunStatus: 'completed',
    kind: 'task', createdAt: now, updatedAt: now,
  },
  {
    id: 't6', name: 'Important emails check', agentId: 'planner',
    prompt: 'Watch inbox for high-priority messages', scheduleKind: 'cron',
    cronExpression: '0 9,12,18 * * *', enabled: true, deleteAfterRun: false,
    createdBy: 'agent', nextRunAt: isoIn(2), lastRunStatus: 'completed',
    kind: 'task', createdAt: now, updatedAt: now,
  },
  {
    id: 't7', name: 'Daily weather alert', agentId: 'planner',
    prompt: 'Check weather and alert if severe', scheduleKind: 'cron',
    cronExpression: '0 21 * * *', enabled: true, deleteAfterRun: false,
    createdBy: 'user', nextRunAt: isoIn(7), lastRunStatus: 'completed',
    kind: 'task', createdAt: now, updatedAt: now,
  },
];

// Shape pour `/api/agents` (pas de query). Type explicite pour permettre `lazySkills` (et
// futurs flags) sur certains agents sans casser l'inférence stricte de Record<…>.
interface MockAgent {
  identity: { id: string; name: string; emoji: string; creature: string; vibe: string };
  workspacePath: string;
  model: string;
  enabled: boolean;
  kind: 'agent';
  lazySkills?: boolean;
  bypassUnifiedCache?: boolean;
  skillCallMode?: 'stub' | 'wildcard';
  excludeSharedMemory?: boolean;
  unifiedSession?: boolean;
  loraScales?: number[];
  // Policy de livraison v3 (granulaire par CANAL × TRIGGER) — miroir du shape shared.
  delivery?: {
    mobile?: { triggers?: Array<'interactive' | 'proactive' | 'task' | 'sandbox'>; presenceDedup?: boolean };
    telegram?: { mode?: 'on' | 'fallback' | 'off'; triggers?: Array<'interactive' | 'proactive' | 'task' | 'sandbox'> };
    liveActivity?: 'all' | 'user' | 'off';
    proactiveAlerts?: 'all' | 'quiet' | 'off';
  } | null;
}
const MOCK_AGENTS: Record<string, MockAgent> = {
  assistant: {
    identity: { id: 'assistant', name: 'Assistant', emoji: '🤖', creature: 'agent', vibe: 'generalist' },
    workspacePath: '/workspace/assistant',
    model: 'provider/model-large',
    enabled: true,
    kind: 'agent',
    // Mock prompt-render assumes assistant runs in lazy=true — aligning the shape here
    // so the "Wildcard skill dispatch" toggle is clickable in Agent Settings.
    lazySkills: true,
  },
  researcher: {
    identity: { id: 'researcher', name: 'Researcher', emoji: '🔍', creature: 'agent', vibe: 'analyst' },
    workspacePath: '/workspace/researcher',
    model: 'provider/model-medium',
    enabled: true,
    kind: 'agent',
    // Demo multi-LoRA config — tests the LoRA shuffle editor.
    loraScales: [0.5, 1.0],
    // Demo delivery policy v3 — tests the granular delivery editor (mobile push on
    // proactive/task only, presence dedup, Telegram as fallback).
    delivery: {
      mobile: { triggers: ['proactive', 'task'], presenceDedup: true },
      telegram: { mode: 'fallback', triggers: ['proactive'] },
      liveActivity: 'user',
      proactiveAlerts: 'quiet',
    },
  },
  planner: {
    identity: { id: 'planner', name: 'Planner', emoji: '📅', creature: 'agent', vibe: 'scheduler' },
    workspacePath: '/workspace/planner',
    model: 'provider/model-small',
    enabled: true,
    kind: 'agent',
  },
};

// Shape AgentConfig[] pour `/api/agents?kind=all` (consommé par useAgents.ts)
const MOCK_AGENTS_LIST = Object.values(MOCK_AGENTS);

/**
 * In-memory mock store for fields persisted via PUT /api/agents/:id/config.
 * Survives only within the SPA session — refresh resets to defaults. C'est OK
 * pour un mock dev mode, le vrai backend persiste dans mastermind.yml.
 *
 * On capte ici TOUS les flags toggle-ables depuis Agent Settings (sinon un PUT
 * { lazySkills: false } est silencieusement ignoré au prochain refetch parce
 * que MOCK_AGENTS hardcoded l'écrase). Pas exhaustif (model/temperature/etc.
 * pas captés — pas testés en mock pour l'instant).
 */
interface MockAgentOverride {
  skillCallMode?: 'stub' | 'wildcard';
  lazySkills?: boolean;
  bypassUnifiedCache?: boolean;
  excludeSharedMemory?: boolean;
  delivery?: MockAgent['delivery'];
  unifiedSession?: boolean;
  captureReasoningTraces?: boolean;
  dailyCompact?: {
    enabled: boolean;
    time?: string;
    skipWarmup?: boolean;
    loraShuffle?: { enabled: boolean; ranges?: Array<{ index: number; min: number; max: number; step?: number }> };
  } | null;
  thinkBudget?: 'off' | 'low' | 'medium' | 'high' | null;
  loraScales?: number[] | null;
}
const MOCK_AGENT_OVERRIDES: Record<string, MockAgentOverride> = {};

// ──────── Templates mock ────────
interface MockTemplateSpec {
  key: string;
  defaultContent: string;
  variables: Array<{ name: string; required: boolean; description: string; example?: string }>;
}
const MOCK_TEMPLATE_LIST: MockTemplateSpec[] = [
  {
    key: 'platform',
    defaultContent: `# Mastermind Platform\n\nYou are an AI agent running inside Mastermind, a multi-agent orchestration platform. The user is {{userName}} ({{userLocale}}).\n{{fleetRosterBlock}}\n\n## Shared resources\n- **Shared memory** — persistent files\n- **Board** — ephemeral shared notes\n- **Escalation** — hand off via \`escalate_to_agent\`\n\n## Skills\nReusable tool packages (actions.yml). Executable skills appear as callable tools.`,
    variables: [
      { name: 'userName', required: false, description: 'Nom de l\'utilisateur principal', example: 'Alice' },
      { name: 'userLocale', required: false, description: 'Code locale courte', example: 'FR' },
      { name: 'fleetRosterBlock', required: true, description: 'Bloc complet "## Fleet roster" + listes standard + sub-agents' },
    ],
  },
  {
    key: 'subagent-harness',
    defaultContent: `# Sub-agent harness (Mastermind)\n\n## Preset identity (IDENTITY.md)\n{{presetIdentity}}\n\nYou are a **one-shot cloud worker** (preset \`{{presetId}}\`).\n\n{{deliveryBlock}}`,
    variables: [
      { name: 'presetIdentity', required: true, description: 'Identité parsée d\'IDENTITY.md' },
      { name: 'presetId', required: true, description: 'ID du preset sub-agent', example: 'morpheus' },
      { name: 'deliveryBlock', required: true, description: 'Bloc "## Delivery contract" expliquant submit_subagent_report' },
    ],
  },
  {
    key: 'environment',
    defaultContent: `# Environment\n- Agents directory: {{agentsRoot}}\n- Shared memory: {{sharedMemory}}\n- User images: {{userImagesDir}}{{skillsDirLine}}\n\n## Tool Call Style\n\n**Do not narrate tool calls.** When a tool exists for the action, call it directly.\n\n## Mandatory tool usage triggers\n\n- User says "remember" → call \`memory_write\`{{memoryStoreTrigger}}\n- User asks to modify a file → call \`edit_file\` or \`write_file\`{{schedulerTriggers}}`,
    variables: [
      { name: 'agentsRoot', required: true, description: 'Chemin absolu agents dir', example: '/workspace/agents' },
      { name: 'sharedMemory', required: true, description: 'Shared memory dir', example: '/workspace/memory/shared' },
      { name: 'userImagesDir', required: true, description: 'User uploads dir', example: '/workspace/memory/shared/user-images' },
      { name: 'skillsDirLine', required: false, description: 'Ligne "\\n- Skills directory: ..." ou vide' },
      { name: 'memoryStoreTrigger', required: false, description: 'Trigger memory_search (conditionnel)' },
      { name: 'schedulerTriggers', required: false, description: 'Bloc scheduler triggers (4 lignes ou vide)' },
    ],
  },
  {
    key: 'memory-stub',
    defaultContent: 'Dynamic memory stored in PostgreSQL — use `memory_search` to query, `memory_write` to store.',
    variables: [],
  },
  {
    key: 'lazy-skills-summary.stub',
    defaultContent: `## Available skills (lazy mode)\nEach skill is summarised below. To use any action of a skill, FIRST call \`inspect_skill(skill_id="<id>")\` to fetch its parameter schemas — THEN call the action tool by its \`toolName\` (returned by inspect_skill) like any other tool.\n\n{{skillsList}}`,
    variables: [
      { name: 'skillsList', required: true, description: 'Liste markdown des skills (généré depuis skillActionsMod)' },
    ],
  },
  {
    key: 'lazy-skills-summary.wildcard',
    defaultContent: `## Available skills (lazy mode)\nEach skill is summarised below. To use any action of a skill, FIRST call \`inspect_skill(skill_id="<id>")\` to fetch its parameter schemas — THEN call \`call_skill_action(toolName="<returned toolName>", args={...})\` to invoke it. Direct \`skill_*\` invocations are NOT available in wildcard mode.\n\n{{skillsList}}`,
    variables: [
      { name: 'skillsList', required: true, description: 'Liste markdown des skills (généré depuis skillActionsMod)' },
    ],
  },
];
const MOCK_TEMPLATE_OVERRIDES: Record<string, string> = {};
function buildMockTemplateInfo(spec: MockTemplateSpec) {
  const override = MOCK_TEMPLATE_OVERRIDES[spec.key];
  const content = override !== undefined ? override : spec.defaultContent;
  const re = /\{\{([\w.]+)\}\}/g;
  const used = new Set<string>();
  let m;
  while ((m = re.exec(content)) !== null) used.add(m[1]);
  const required = spec.variables.filter(v => v.required).map(v => v.name);
  const missingRequired = required.filter(r => !used.has(r));
  return {
    key: spec.key,
    source: override !== undefined ? 'override' : 'default',
    content,
    chars: content.length,
    estimatedTokens: Math.max(1, Math.round(content.length / 4)),
    variables: spec.variables,
    usedVariables: [...used],
    missingRequired,
  };
}

// /api/config : shape complète requise par SettingsPage (Config interface).
const MOCK_CONFIG = {
  server: { host: 'localhost', port: 3443, apiKey: 'mm-dev-key' },
  paths: {
    agentsDir: '/workspace/agents',
    sharedMemoryDir: '/workspace/memory/shared',
    compactArchivesDir: '/workspace/archives',
    skillsDir: '/workspace/skills',
    userImagesDir: '/workspace/images',
    subagentReportsDir: '/workspace/subagent-reports',
  },
  subagentDefaults: { reportInjectionMaxChars: 12000 },
  defaults: {
    model: 'provider/model-medium',
    temperature: 0.7,
    maxContextTokens: 200000,
    promptCacheTtl: 30,
    toolDefaults: {
      bashTimeoutMs: 120000,
      webFetchMaxChars: 50000,
      maxToolTurns: 50,
      maxReasoningCalls: 5,
      maxReasoningInputChars: 100000,
      maxIdenticalToolCalls: 3,
      autoAbortOnLoopGuard: true,
    },
    autoWarmup: {
      enabled: true,
      globalWarmupIdleMinutes: 25,
      fileDebounceSeconds: 3,
      recentActivityHours: 24,
    },
    autoUnloadOnSwitch: false,
    cacheOptimized: true,
  },
  database: { host: 'localhost', port: 5432, database: 'mastermind', password: '••••••' },
  telegram: { enabled: false, botToken: '' },
  search: { braveApiKey: '' },
  logging: {
    level: 'INFO' as const,
    file: '/var/log/mastermind/app.log',
    maxFileSizeMb: 50,
    maxFiles: 5,
  },
  openingHours: { enabled: false, closedStart: 23, closedEnd: 7, overrideOpen: false },
  consolidation: {
    chat: { enabled: true, cronHour: 4, model: 'provider/model-small', validateSummaries: true, minSummaryChars: 40 },
    memory: {
      enabled: true,
      cronSchedule: 'weekly',
      cronHour: 3,
      mergeModel: 'provider/model-small',
      scoring: { recencyWeight: 0.4, frequencyWeight: 0.3, ageWeight: 0.3, recencyHalfLifeDays: 14, maxAgeDays: 365 },
      clustering: { mergeThreshold: 0.85, maxPairsPerRun: 50, maxClusterSize: 5 },
      archival: { scoreThreshold: 0.2, minAgeDays: 30 },
      delayBetweenMergesMs: 200,
    },
  },
};

// /api/providers : un provider local minimal pour pas crasher les pickers.
const MOCK_PROVIDERS = [
  { id: 'local', type: 'mercury', reachable: true, baseUrl: 'http://localhost:8000', enabled: true },
];

// /api/sessions?agentId=X — historique de conversations par agent.
const MOCK_SESSIONS = [
  { id: 's-assistant-1', agentId: 'assistant', title: 'Product brainstorm', updatedAt: new Date(Date.now() - 3600_000).toISOString(), messageCount: 12 },
  { id: 's-assistant-2', agentId: 'assistant', title: 'Code review audit', updatedAt: new Date(Date.now() - 86400_000).toISOString(), messageCount: 27 },
  { id: 's-researcher-1', agentId: 'researcher', title: 'Research session', updatedAt: new Date(Date.now() - 7200_000).toISOString(), messageCount: 8 },
  { id: 'researcher-mobile', agentId: 'researcher', title: 'Mobile session', updatedAt: new Date(Date.now() - 1800_000).toISOString(), messageCount: 4 },
];

/**
 * Mock prompt sections — données crédibles pour valider visuellement le Prompt Builder
 * sans backend. On reproduit l'ordre réel + des contenus représentatifs (extraits raccourcis
 * des vrais prompts), avec quelques sections conditionnelles pour tester les groupes.
 */
function buildMockPromptSections(agentId: string, variant: 'web' | 'telegram') {
  const agent = MOCK_AGENTS[agentId] ?? MOCK_AGENTS.assistant;
  const isTg = variant === 'telegram';
  const sections: { key: string; content: string; chars: number; estimatedTokens: number }[] = [];
  const push = (key: string, content: string) => {
    sections.push({ key, content, chars: content.length, estimatedTokens: Math.max(1, Math.round(content.length / 4)) });
  };

  push('platform',
`# Mastermind Platform

You are an AI agent running inside Mastermind, a multi-agent orchestration platform.

Mastermind runs **locally** on the user's machine (self-hosted, single operator). Each agent has a specialized role/vibe and can reach external services through skills. Favor local-first, privacy-preserving solutions; assume a single trusted human-in-the-loop. The user is Alice (EN).

## Fleet roster (who is who)

There are two kinds of registered agents — do not confuse them:
- **Standard agents** — interactive personas with a workspace, chat sessions (web/Telegram), Board, escalation, and scheduler.
- **Sub-agent presets** — one-shot cloud workers with their own workspace.

### Standard agents
- 🤖 **assistant** — generalist (provider/model-large)
- 🔍 **researcher** — analyst (provider/model-medium)
- 📅 **planner** — scheduler (provider/model-small)

## Shared resources
- **Shared memory** — persistent files readable/writable by all agents
- **Board** — ephemeral shared notes (auto-purged 24h)
- **Escalation** — hand off via \`escalate_to_agent\`

## Scheduler
Schedule one-time or recurring tasks (cron). When a task fires, you are woken up automatically.

[...mock excerpt — ~5000 chars dans le vrai prompt]`);

  push('environment',
`# Environment

## Paths (absolute)
- Agents root: /workspace/agents
- Workspace:   ${agent.workspacePath}
- Shared mem:  /workspace/memory/shared
- Skills:      /workspace/skills
- User images: /workspace/memory/shared/user-images

## Tool call rules

Do NOT narrate tool calls ("je vais utiliser le tool X…"). Just call it.
Cross-tool workflows: codebase_search → read → edit.
Mandatory triggers:
- "où est défini X" → codebase_search
- "qu'est-ce que ce fichier fait" → read first, then synthesize

[...mock excerpt]`);

  push('memory-stub',
`Dynamic memory stored in PostgreSQL — use \`memory_search\` to query, \`memory_write\` to store.`);

  push('daily-recent',
`# Recent Context

## 2026-05-18
- Sub-agent jobs stable, no escalations this week
- Scheduled task completed successfully

## 2026-05-17
- Memory consolidation ran, merged 12 entries
- Codebase index refreshed

[...mock excerpt]`);

  push('shared-starred:system-overview.md',
`# Shared Starred File: system-overview.md

This file describes the overall system architecture and component responsibilities.

[...mock excerpt]`);

  push('shared-starred:best-practices.md',
`# Shared Starred File: best-practices.md

Conventions and quality standards shared across all agents.

[...mock excerpt]`);

  push('agent-identity',
`# Identity

- **Name**: ${agent.identity.name}
- **Role**: ${agent.identity.vibe ?? '—'}
- **Vibe**: ${agent.identity.vibe ?? '—'}
- **Emoji**: ${agent.identity.emoji ?? '—'}

**Workspace**: ${agent.workspacePath}
**Compact archives**: /workspace/archives/${agentId}`);

  if (agentId === 'assistant') {
    push('codebase-search-hint',
`# Codebase Search

You have a codebase index configured for your project. Use \`codebase_search\` first when the user mentions a file/symbol/concept you don't recognize.`);
  }

  push('workspace:SOUL.md',
`# SOUL.md

Tu es ${agent.identity.name}, ${agent.identity.vibe}. Tu parles cash, tu proposes et tu challenges, pas de hedging RLHF.

[...mock excerpt — workspace file]`);

  push('workspace:MEMORY.md',
`# MEMORY.md

(skippé si memoryStore.enabled — sinon ce fichier disque tient la mémoire de l'agent)

[...mock excerpt]`);

  if (isTg) {
    // En vrai pas une section séparée, juste pour montrer la différence variant.
    // Le vrai prompt diffère via isMainSession dans des branches conditionnelles internes
    // mais l'ordre des sections est identique.
  }
  return sections;
}

/**
 * Mock tools + skills — crédibles pour valider l'UI Prompt Builder.
 * Le vrai backend retourne la sortie de buildAgentToolsForRender qui assemble
 * TOOL_DEFINITIONS + skillActions filtrés par module availability + allowOnly/disabled.
 */
function buildMockTools(agentId: string, lazyActive = false, wildcardActive = false) {
  const mk = (name: string, kind: 'builtin' | 'skill', description: string, parameters: object) => {
    const schema = JSON.stringify({ name, description, parameters }, null, 2);
    return {
      name,
      kind,
      description,
      schema,
      chars: schema.length,
      estimatedTokens: Math.max(1, Math.round(schema.length / 4)),
    };
  };
  // In lazy mode, skills are replaced by minimal stubs (matches backend factory
  // `makeLazySkillStub` in tools/index.ts — keep description empty here too so the
  // mock reflects production payload byte-for-byte).
  const mkSkillStub = (name: string) => mk(
    name,
    'skill',
    '',
    { type: 'object' as const },
  );
  const builtins = [
    mk('read', 'builtin', 'Read a file from disk and return its content.', {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute or workspace-relative path' } },
      required: ['path'],
    }),
    mk('write', 'builtin', 'Write content to a file (creates or overwrites).', {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    }),
    mk('bash', 'builtin', 'Execute a shell command and return stdout/stderr.', {
      type: 'object',
      properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } },
      required: ['command'],
    }),
    mk('web_fetch', 'builtin', 'Fetch a URL and return the page text (max 50KB).', {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    }),
    mk('memory_write', 'builtin', 'Store a fact in shared memory for later retrieval.', {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value'],
    }),
    mk('escalate_to_agent', 'builtin', 'Hand off the current situation to another agent.', {
      type: 'object',
      properties: { agent_id: { type: 'string' }, summary: { type: 'string' } },
      required: ['agent_id', 'summary'],
    }),
    mk('send_to_user', 'builtin', 'Push a message to the user (chat or telegram), with optional attachments.', {
      type: 'object',
      properties: { content: { type: 'string' }, channel: { enum: ['chat', 'telegram', 'both'] }, attachments: { type: 'array', items: { type: 'string' } } },
      required: ['content'],
    }),
  ];
  // The assistant agent has codebase_search access in mock mode
  if (agentId === 'assistant') {
    builtins.push(mk('codebase_search', 'builtin', 'Semantic+hybrid search across indexed codebases. Use first when user mentions a symbol/file.', {
      type: 'object',
      properties: { query: { type: 'string' }, top_k: { type: 'number' } },
      required: ['query'],
    }));
  }
  // Wildcard mode short-circuits all skill stub emission — only inspect_skill +
  // call_skill_action are exposed. Saves ~6-8k tokens for big skill fleets.
  let skills: ReturnType<typeof mk>[];
  if (wildcardActive) {
    skills = []; // no per-skill stubs in wildcard mode
  } else if (lazyActive) {
    skills = [
      mkSkillStub('skill_weather_forecast'),
      mkSkillStub('skill_mastermind_list_agents'),
      mkSkillStub('skill_example_search'),
    ];
  } else {
    skills = [
      mk('skill_weather_forecast', 'skill', 'Get weather forecast for a city for the next N days.', {
        type: 'object',
        properties: { city: { type: 'string' }, days: { type: 'number' } },
        required: ['city'],
      }),
      mk('skill_mastermind_list_agents', 'skill', 'List all Mastermind agents with their identity + model + state.', { type: 'object' }),
      mk('skill_example_search', 'skill', 'Example skill — search for items matching a query.', {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      }),
    ];
  }
  // In lazy mode, inspect_skill becomes available so the agent can fetch full schemas on demand.
  if (lazyActive) {
    builtins.push(mk('inspect_skill', 'builtin', 'Fetch the full schema and parameter definitions for a lazy-loaded skill.', {
      type: 'object',
      properties: { skill_id: { type: 'string' } },
      required: ['skill_id'],
    }));
  }
  // In wildcard mode, call_skill_action is the unified dispatcher.
  if (wildcardActive) {
    builtins.push(mk('call_skill_action', 'builtin', 'Invoke a skill action by its full toolName. Requires inspect_skill first to learn the schema.', {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: 'e.g. skill_meteo_forecast' },
        args: { type: 'object' },
      },
      required: ['toolName', 'args'],
    }));
  }
  return [...builtins, ...skills];
}

function buildMockLazySummary(agentId: string, wildcardActive = false): string {
  const lines = [
    '## Available skills (lazy mode)',
    wildcardActive
      ? 'Each skill is summarised below. To use any action of a skill, FIRST call `inspect_skill(skill_id="<id>")` to fetch its parameter schemas — THEN call `call_skill_action(toolName="<returned toolName>", args={...})` to invoke it. Direct `skill_*` invocations are NOT available in wildcard mode.'
      : 'Each skill is summarised below. To use any action of a skill, FIRST call `inspect_skill(skill_id="<id>")` to fetch its parameter schemas — THEN call the action tool by its `toolName` (returned by inspect_skill) like any other tool.',
    '',
    '- **🌤️ Weather** (id: `weather`) — Weather forecasts via Open-Meteo. 2 action(s): forecast, current',
    '- **🤖 Mastermind** (id: `mastermind`) — Inspect agents and sessions. 4 action(s): list_agents, get_session, list_sessions, get_agent_stats',
  ];
  if (agentId === 'assistant') {
    lines.push('- **🔍 Example** (id: `example`) — Generic example skill demonstrating search/retrieval. 3 action(s): search, get_item, list_items');
  }
  return lines.join('\n');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function installMockApi() {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();

    // Endpoints utiles au SchedulerPage
    if (/\/api\/status(\?|$)/.test(url)) {
      return jsonResponse({
        uptime: 0,
        database: {
          ok: true,
          sessions: 33,
          messages: 1100,
          messagesCompacted: 340,
          reasoningTraces: 185,
          memories: 412,
          scheduledTasks: 7,
          activeJobs: 2,
          dbSize: '47 MB',
          lastMessageAt: new Date(Date.now() - 91 * 60_000).toISOString(),
          lastSessionAt: new Date(Date.now() - 163 * 3_600_000).toISOString(),
        },
        providers: [],
        telegram: [],
        agents: [],
      });
    }
    if (/\/api\/codebase-search\/status/.test(url)) {
      return jsonResponse({ enabled: false, resolvedIndices: {} });
    }
    if (/\/api\/codebase-search\/stats/.test(url)) return jsonResponse({ totalChunks: 0 });
    if (url.endsWith('/health')) return jsonResponse({ ok: true, version: 'dev', uptime: 0 });
    if (/\/api\/scheduler\/status/.test(url)) return jsonResponse({});
    if (/\/api\/scheduler\/tasks\?kind=proactive/.test(url)) return jsonResponse(MOCK_PROACTIVE);
    if (/\/api\/scheduler\/tasks(\?|$)/.test(url) && method === 'GET') return jsonResponse(MOCK_TASKS);
    if (/\/api\/scheduler\/tasks\/trash/.test(url)) return jsonResponse([]);
    if (/\/api\/scheduler\/runs/.test(url)) return jsonResponse([]);
    if (/\/api\/scheduler\/alerts/.test(url)) return jsonResponse([]);
    if (/\/api\/proactive\/(sources|alerts)/.test(url)) return jsonResponse([]);

    // ──────── /api/push (canal mobile APNs / PushSettingsCard) ────────
    if (/\/api\/push\/config/.test(url) && method === 'PUT') {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      console.warn('[mockApi] PUT /api/push/config (in-memory):', body);
      return jsonResponse({
        enabled: !!body.enabled,
        apns: {
          keyId: body.apns?.keyId ?? '', teamId: body.apns?.teamId ?? '',
          topic: body.apns?.topic ?? 'com.example.myapp', production: !!body.apns?.production,
          keyPath: body.apns?.keyPath ?? '', hasInlineKey: !!body.apns?.keyP8,
        },
        active: false,
      });
    }
    if (/\/api\/push\/config/.test(url)) {
      return jsonResponse({
        enabled: false,
        apns: { keyId: '', teamId: '', topic: 'com.example.myapp', production: false, keyPath: '', hasInlineKey: false },
      });
    }
    if (/\/api\/push\/test/.test(url)) return jsonResponse({ attempted: 2, delivered: 0, pruned: 0, errors: ['mock: pas de vrai APNs en dev'] });
    if (/\/api\/push(\?|$)/.test(url)) return jsonResponse({ enabled: false, configured: false, production: false, topic: null, deviceCount: 2 });

    // Agents : 2 shapes selon query (Record sans query, Array avec ?kind=all).
    // Merge des overrides in-memory pour que les toggles depuis ChatPage
    // (qui lit la liste useAgents) survivent au refetch.
    const mergeOverrides = (a: typeof MOCK_AGENTS_LIST[number]) => {
      const ov = MOCK_AGENT_OVERRIDES[a.identity.id];
      return ov ? { ...a, ...ov } : a;
    };
    if (/\/api\/agents\?kind=all/.test(url)) return jsonResponse(MOCK_AGENTS_LIST.map(mergeOverrides));
    if (/\/api\/agents(\?|$)/.test(url) && method === 'GET') {
      const record: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(MOCK_AGENTS)) record[k] = mergeOverrides(v);
      return jsonResponse(record);
    }
    if (/\/api\/agents\/ui-prefs/.test(url)) return jsonResponse({ selectedAgent: 'assistant', agentPanelOpen: true, skillbarCollapsed: false, agentOrder: ['assistant', 'researcher', 'planner'] });
    if (/\/api\/agents\/[^/]+\/tab-order/.test(url)) return jsonResponse([]);
    if (/\/api\/agents\/[^/]+\/stats/.test(url)) return jsonResponse({});
    if (/\/api\/agents\/[^/]+\/files/.test(url)) return jsonResponse([]);
    if (/\/api\/agents\/[^/]+\/prompt-size/.test(url)) return jsonResponse({
      web: { estimatedTokens: 4200, chars: 16800, sections: [] },
      telegram: { estimatedTokens: 3800, chars: 15200, sections: [] },
    });
    // /api/agents/:id/prompt-render?variant=web|telegram&lazySkills=on|off&skillCallMode=stub|wildcard — Prompt Builder
    if (/\/api\/agents\/[^/]+\/prompt-render/.test(url)) {
      const m = url.match(/\/api\/agents\/([^/?]+)\/prompt-render/);
      const aid = m ? m[1] : 'assistant';
      const variant = /variant=telegram/.test(url) ? 'telegram' : 'web';
      const lazyParam = /lazySkills=on|lazySkills=true/.test(url)
        ? true
        : /lazySkills=off|lazySkills=false/.test(url)
          ? false
          : null;
      const skillCallModeOverride: 'stub' | 'wildcard' | null = /skillCallMode=wildcard/.test(url)
        ? 'wildcard'
        : /skillCallMode=stub/.test(url)
          ? 'stub'
          : null;
      // Mock config defaults — assistant has lazy=true in config for demo, others lazy=false.
      // If the user toggled in Agent Settings, the override takes priority over the default.
      const lazyFromConfig = MOCK_AGENT_OVERRIDES[aid]?.lazySkills ?? (aid === 'assistant');
      const effectiveLazy = lazyParam !== null ? lazyParam : lazyFromConfig;
      // V2: skillCallMode peut maintenant être persisté en YAML (mocké via MOCK_AGENT_OVERRIDES).
      const configSkillCallMode: 'stub' | 'wildcard' = (MOCK_AGENT_OVERRIDES[aid]?.skillCallMode) ?? 'stub';
      const skillCallMode: 'stub' | 'wildcard' = skillCallModeOverride ?? configSkillCallMode;
      const wildcardActive = skillCallMode === 'wildcard' && effectiveLazy;
      const sections = buildMockPromptSections(aid, variant);
      const prompt = sections.map(s => s.content).join('\n\n---\n\n');
      const chars = prompt.length;
      const tools = buildMockTools(aid, effectiveLazy, wildcardActive);
      const toolsChars = tools.reduce((acc, t) => acc + t.chars, 0);
      const skillCountFull = aid === 'assistant' ? 3 : 0; // full count of mock skills available
      const lazySummary = effectiveLazy ? buildMockLazySummary(aid, wildcardActive) : null;
      return jsonResponse({
        agentId: aid,
        variant,
        prompt,
        chars,
        estimatedTokens: Math.max(1, Math.round(chars / 4)),
        sections,
        tools,
        toolsMeta: {
          count: tools.length,
          chars: toolsChars,
          estimatedTokens: Math.max(1, Math.round(toolsChars / 4)),
          lazySkillsActive: effectiveLazy,
          bypassUnified: false,
          skillCount: { full: skillCountFull, emitted: skillCountFull },
        },
        lazySkillSummary: lazySummary,
        lazySkillSummaryMeta: lazySummary
          ? { chars: lazySummary.length, estimatedTokens: Math.max(1, Math.round(lazySummary.length / 4)) }
          : null,
        effectiveConfig: {
          kind: 'agent',
          lazySkills: effectiveLazy,
          bypassUnifiedCache: false,
          memoryStoreEnabled: true,
          starredSkills: aid === 'assistant' ? ['weather', 'mastermind'] : ['mastermind'],
          sharedStarredFiles: ['system-overview.md', 'best-practices.md'],
          disabledTools: aid === 'planner' ? ['bash'] : [],
          allowOnly: [],
          skillCallMode,
          overrides: {
            lazySkills: lazyParam !== null
              ? { active: true, value: lazyParam, configValue: lazyFromConfig }
              : { active: false },
            bypassUnifiedCache: { active: false },
            skillCallMode: skillCallModeOverride !== null
              ? { active: true, value: skillCallModeOverride, configValue: configSkillCallMode }
              : { active: false, configValue: configSkillCallMode },
          },
        },
      });
    }
    if (/\/api\/agents\/workspace\/scan/.test(url)) return jsonResponse([]);
    if (/\/api\/skills(\?|$)/.test(url)) return jsonResponse([]);
    if (/\/api\/memory\/shared/.test(url)) return jsonResponse([]);
    // ──────── /api/prompt-templates ──────── (V3 — Templates editor)
    if (/\/api\/prompt-templates(\?|$)/.test(url) && method === 'GET') {
      return jsonResponse(MOCK_TEMPLATE_LIST.map(buildMockTemplateInfo));
    }
    const tplMatch = url.match(/\/api\/prompt-templates\/([\w.-]+)(\/default)?(\?|$)/);
    if (tplMatch) {
      const key = tplMatch[1];
      const isDefault = !!tplMatch[2];
      const spec = MOCK_TEMPLATE_LIST.find(t => t.key === key);
      if (!spec) return jsonResponse({ error: `Unknown template key: ${key}` }, 404);
      if (method === 'GET' && isDefault) {
        return jsonResponse({ key, content: spec.defaultContent, chars: spec.defaultContent.length, estimatedTokens: Math.max(1, Math.round(spec.defaultContent.length / 4)) });
      }
      if (method === 'GET') {
        return jsonResponse(buildMockTemplateInfo(spec));
      }
      if (method === 'PUT') {
        const bodyText = typeof init?.body === 'string' ? init.body : '';
        try {
          const body = JSON.parse(bodyText);
          if (typeof body.content !== 'string') return jsonResponse({ error: 'Body must contain { content: string }' }, 400);
          // Validate required vars
          const required = spec.variables.filter(v => v.required).map(v => v.name);
          const re = /\{\{([\w.]+)\}\}/g;
          const used = new Set<string>();
          let m;
          while ((m = re.exec(body.content)) !== null) used.add(m[1]);
          const missing = required.filter(r => !used.has(r));
          if (missing.length > 0) {
            return jsonResponse({ error: `Required variables missing: ${missing.map(v => `{{${v}}}`).join(', ')}`, code: 'TEMPLATE_MISSING_REQUIRED_VARS' }, 422);
          }
          MOCK_TEMPLATE_OVERRIDES[key] = body.content;
          console.warn(`[mockApi] PUT /api/prompt-templates/${key} persisted (in-memory) ${body.content.length} chars`);
          return jsonResponse(buildMockTemplateInfo(spec));
        } catch {
          return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }
      }
      if (method === 'DELETE') {
        delete MOCK_TEMPLATE_OVERRIDES[key];
        console.warn(`[mockApi] DELETE /api/prompt-templates/${key} (override cleared)`);
        return jsonResponse(buildMockTemplateInfo(spec));
      }
    }

    // POST /api/agents/:id/unify-sessions — active le mode session unifiée (mock : flip le flag)
    if (/\/api\/agents\/[^/]+\/unify-sessions/.test(url) && method === 'POST') {
      const mu = url.match(/\/api\/agents\/([^/?]+)\/unify-sessions/);
      const auid = mu ? mu[1] : '';
      const store = MOCK_AGENT_OVERRIDES[auid] ?? {};
      store.unifiedSession = true;
      MOCK_AGENT_OVERRIDES[auid] = store;
      console.warn(`[mockApi] POST /api/agents/${auid}/unify-sessions (mock: unifiedSession=true)`);
      return jsonResponse({
        ok: true,
        unifiedSessionId: `${auid}-unified`,
        messagesMerged: 0,
        summarized: false,
        mergedFrom: [`${auid}-web`, `${auid}-mobile`],
      });
    }

    // PUT /api/agents/:id/config — V2 persiste skillCallMode (et autres flags YAML)
    if (/\/api\/agents\/[^/]+\/config/.test(url) && method === 'PUT') {
      const m2 = url.match(/\/api\/agents\/([^/?]+)\/config/);
      const aid2 = m2 ? m2[1] : '';
      const bodyText = typeof init?.body === 'string' ? init.body : '';
      try {
        const body = bodyText ? JSON.parse(bodyText) : {};
        const store = MOCK_AGENT_OVERRIDES[aid2] ?? {};
        if (body.skillCallMode !== undefined) {
          if (body.skillCallMode !== 'stub' && body.skillCallMode !== 'wildcard') {
            return jsonResponse({ error: 'skillCallMode must be "stub" or "wildcard"' }, 400);
          }
          store.skillCallMode = body.skillCallMode;
        }
        // Capture les booléens du card "Modèle" pour qu'un toggle off → reload
        // ne soit pas écrasé par les valeurs hardcoded dans MOCK_AGENTS.
        if (body.lazySkills !== undefined) store.lazySkills = body.lazySkills;
        if (body.bypassUnifiedCache !== undefined) store.bypassUnifiedCache = body.bypassUnifiedCache;
        if (body.excludeSharedMemory !== undefined) store.excludeSharedMemory = body.excludeSharedMemory;
        if (body.delivery !== undefined) store.delivery = body.delivery;
        if (body.unifiedSession !== undefined) store.unifiedSession = body.unifiedSession;
        if (body.captureReasoningTraces !== undefined) store.captureReasoningTraces = body.captureReasoningTraces;
        if (body.dailyCompact !== undefined) store.dailyCompact = body.dailyCompact;
        if (body.thinkBudget !== undefined) store.thinkBudget = body.thinkBudget;
        if (body.loraScales !== undefined) {
          // null / [] → clear ; tableau non-vide → persiste pour le prochain GET agent.
          store.loraScales = Array.isArray(body.loraScales) && body.loraScales.length > 0
            ? body.loraScales
            : null;
        }
        MOCK_AGENT_OVERRIDES[aid2] = store;
        console.warn(`[mockApi] PUT /api/agents/${aid2}/config persisted (in-memory):`, store);
      } catch (e) {
        console.warn('[mockApi] PUT /api/agents/:id/config invalid body:', e);
      }
      return jsonResponse({ ok: true });
    }
    // Specific agent fetch (AgentDetailPage) : /api/agents/{id}
    if (/\/api\/agents\/[^/?]+(\?|$)/.test(url) && method === 'GET') {
      const m = url.match(/\/api\/agents\/([^/?]+)/);
      const id = m ? m[1] : '';
      const agent = MOCK_AGENTS[id];
      if (!agent) return jsonResponse({ error: 'not found' }, 404);
      // Merge in-memory overrides persisted via PUT /:id/config so toggling in
      // AgentConfigTab survives the loadAgentDetail refresh that follows the PUT.
      const overrides = MOCK_AGENT_OVERRIDES[id] ?? {};
      return jsonResponse({ ...agent, ...overrides });
    }

    // Bootstrap shell (config, sessions, skills, providers, telegram, logs, war-rooms)
    if (/\/api\/config\/reload/.test(url)) return jsonResponse({ ok: true });
    if (/\/api\/config\/ncm\/test/.test(url)) return jsonResponse({ ok: true, message: 'mock' });
    if (/\/api\/config(\?|$)/.test(url) && method === 'GET') return jsonResponse(MOCK_CONFIG);
    if (/\/api\/config/.test(url) && method === 'PUT') return jsonResponse({ ok: true });
    if (/\/api\/sessions\/search/.test(url) && method === 'GET') {
      const m = url.match(/[?&]q=([^&]*)/);
      const q = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : 'sujet';
      return jsonResponse([
        { id: 'm-1', sessionId: 's-assistant-1', role: 'user', createdAt: new Date(Date.now() - 3_600_000).toISOString(), snippet: `… we discussed «${q}» in the product brainstorm …`, rank: 0.089 },
        { id: 'm-2', sessionId: 's-researcher-1', role: 'assistant', createdAt: new Date(Date.now() - 86_400_000).toISOString(), snippet: `… noted «${q}» as a key point last time …`, rank: 0.071 },
        { id: 'm-3', sessionId: 's-assistant-2', role: 'user', createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), snippet: `… remind me what we decided about «${q}» …`, rank: 0.052 },
      ]);
    }
    if (/\/api\/sessions\/[^/]+\/messages/.test(url)) return jsonResponse([]);
    if (/\/api\/sessions\/[^/]+\/options/.test(url)) return jsonResponse({ thinkBudget: 'off' });
    if (/\/api\/sessions\/[^/]+\/stats/.test(url)) return jsonResponse({
      estimatedTokens: 0,
      systemPromptTokens: 0,
      maxContextTokens: 200000,
      effectiveModel: 'provider/model-medium',
      providerId: 'local',
      messageCount: 0,
      historyWindow: 0,
    });
    if (/\/api\/sessions\?agentId=([^&]+)/.test(url)) {
      const m = url.match(/agentId=([^&]+)/);
      const aid = m ? decodeURIComponent(m[1]) : '';
      return jsonResponse(MOCK_SESSIONS.filter(s => s.agentId === aid));
    }
    if (/\/api\/sessions(\?|$)/.test(url) && method === 'GET') return jsonResponse(MOCK_SESSIONS);
    if (/\/api\/skills\/actions/.test(url)) return jsonResponse([]);
    if (/\/api\/providers\/[^/]+\/exposed-models/.test(url)) return jsonResponse([]);
    if (/\/api\/providers\/[^/]+\/available-models/.test(url)) return jsonResponse([]);
    if (/\/api\/providers\/[^/]+\/embedding-chain/.test(url)) return jsonResponse({ chain: [] });
    if (/\/api\/providers\/[^/]+\/test-stats/.test(url)) return jsonResponse({ ok: true });
    if (/\/api\/providers/.test(url)) return jsonResponse(MOCK_PROVIDERS);
    if (/\/api\/telegram/.test(url)) return jsonResponse([]);
    // Canal push mobile (onglet Delivery › Mobile) — statut + 2 appareils factices.
    if (/\/api\/push\/devices/.test(url)) return jsonResponse([
      { tokenTail: 'a1b2c3d4', platform: 'ios', agentId: 'researcher', createdAt: isoIn(-30), lastSeenAt: isoIn(0) },
      { tokenTail: 'e5f6a7b8', platform: 'ios', agentId: null, createdAt: isoIn(-90), lastSeenAt: isoIn(-1) },
    ]);
    if (/\/api\/push(\?|$|\/)/.test(url)) return jsonResponse({ enabled: true, configured: true, production: false, topic: 'com.example.mastermind', deviceCount: 2 });
    if (/\/api\/logs/.test(url)) {
      // Mock logs : assez d'entrées pour tester la lisibilité, plusieurs niveaux
      // et tags variés pour valider l'alignement des colonnes et le wrap mobile.
      const baseTs = Date.now();
      const samples: Array<[string, string, string]> = [
        ['INFO', 'http', 'GET /api/agents 200 in 12ms'],
        ['INFO', 'agent', 'researcher: starting cron task scheduler'],
        ['DEBUG', 'memory-store', 'embedded 24 chunks for agent assistant (cache hit)'],
        ['WARN', 'provider', 'local embedding endpoint slow: 1247ms (threshold 800ms)'],
        ['INFO', 'ws', 'client connected from 127.0.0.1 (sessionId=s-abc123)'],
        ['ERROR', 'agent', 'planner: failed to fetch calendar — 401 Unauthorized'],
        ['INFO', 'consolidation', 'memory consolidation pass complete (3 merged, 1 archived)'],
        ['DEBUG', 'http', 'POST /api/scheduler/tasks/t1/run 204 in 4ms'],
        ['INFO', 'config', 'config reloaded from disk (mtime change detected)'],
        ['WARN', 'memory-consolidation', 'skipping consolidation: agent has < 5 entries'],
      ];
      return jsonResponse(samples.map(([level, tag, msg], i) => ({
        ts: new Date(baseTs - (samples.length - i) * 1500).toISOString(),
        level, tag, msg,
      })));
    }
    if (/\/api\/war-rooms/.test(url)) return jsonResponse([]);
    if (/\/api\/client-logs/.test(url)) return jsonResponse({ ok: true });

    // Mutations sur les tâches → ack vide (le composant refetch ensuite)
    if (/\/api\/scheduler\/tasks\//.test(url) && method !== 'GET') return jsonResponse({ ok: true });

    // Catch-all : on log et on renvoie array vide (le shape le plus fréquent)
    // pour éviter les .map sur undefined.
    if (url.includes('/api/')) {
      console.warn('[mockApi] unmocked endpoint, returning []:', method, url);
      return jsonResponse([]);
    }

    return origFetch(input, init);
  };
  console.warn('[mockApi] dev fetch mock installé — endpoints scheduler/agents stubés');
}
