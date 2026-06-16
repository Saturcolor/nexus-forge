import { Hono } from 'hono';
import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { MastermindContext } from '@mastermind/shared';
import type { ConfigModule } from '../modules/config/index.js';
import type { SkillActionsModule } from '../modules/skill-actions/index.js';

export interface SkillMeta {
  /** Display name — frontmatter `name` if défini, sinon dir. À utiliser pour le rendu UI. */
  name: string;
  /** Dir name (toujours = dossier réel). À utiliser pour starredSkills + lookup API. */
  dir: string;
  description?: string;
  summary?: string;
  emoji?: string;
  hint?: string;
  requires?: { bins?: string[] };
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    return (yaml.load(match[1]) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

function extractMeta(fm: Record<string, unknown>, dirName: string): SkillMeta {
  const meta = fm.metadata as Record<string, unknown> | undefined;
  const skillconfig = meta?.skillconfig as Record<string, unknown> | undefined;

  const emoji =
    (meta?.emoji as string | undefined) ??
    (skillconfig?.emoji as string | undefined) ??
    '';

  const hint =
    (meta?.hint as string | undefined) ??
    (skillconfig?.hint as string | undefined) ??
    '';

  const bins =
    ((meta?.requires as Record<string, unknown> | undefined)?.bins as string[] | undefined) ??
    ((skillconfig?.requires as Record<string, unknown> | undefined)?.bins as string[] | undefined) ??
    [];

  return {
    name: (fm.name as string | undefined) ?? dirName,
    dir: dirName,
    description: (fm.description as string | undefined) ?? '',
    summary: (fm.summary as string | undefined) ?? '',
    emoji,
    hint,
    requires: bins.length ? { bins } : undefined,
  };
}

export function skillsRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const configMod = ctx.modules.get<ConfigModule>('config');

  function getSkillsDir(): string | null {
    const raw = ctx.config.paths.skillsDir;
    if (!raw) return null;
    return configMod.resolvePath(raw);
  }

  // List all skills with parsed metadata
  app.get('/', async (c) => {
    const skillsDir = getSkillsDir();
    if (!skillsDir) {
      console.warn('[route:skills] list requested but skillsDir not configured');
      return c.json({ error: 'skillsDir not configured' }, 404);
    }

    let entries: string[];
    try {
      const dirents = await fs.readdir(skillsDir, { withFileTypes: true });
      entries = dirents.filter(d => d.isDirectory()).map(d => d.name).sort();
      console.debug(`[route:skills] list dirs count=${entries.length} dir=${skillsDir}`);
    } catch (err) {
      console.warn(`[route:skills] cannot read skillsDir=${skillsDir}: ${err instanceof Error ? err.message : err}`);
      return c.json({ error: 'Cannot read skills directory' }, 500);
    }

    const skills: SkillMeta[] = [];
    for (const name of entries) {
      const skillFile = path.join(skillsDir, name, 'SKILL.md');
      try {
        const raw = await fs.readFile(skillFile, 'utf-8');
        const fm = parseFrontmatter(raw);
        skills.push(extractMeta(fm, name));
      } catch {
        // Directory exists but no SKILL.md — include with minimal info
        console.debug(`[route:skills] skill has no readable SKILL.md name=${name}`);
        skills.push({ name, dir: name });
      }
    }

    console.debug(`[route:skills] list result count=${skills.length}`);
    return c.json(skills);
  });

  // ── Skill Actions endpoints ─────────────────────────────────────────────────
  // IMPORTANT: these MUST be declared before `/:name` — otherwise Hono matches
  // `/:name` first and `/actions` is treated as a skill name lookup (→ ENOENT).

  // List all skill actions (for frontend one-click buttons)
  app.get('/actions', async (c) => {
    const skillActionsMod = ctx.modules.tryGet<SkillActionsModule>('skill-actions');
    if (!skillActionsMod) {
      console.debug('[route:skills] actions requested but module unavailable');
      return c.json([]);
    }
    const actions = skillActionsMod.getAllActionsForUI();
    console.debug(`[route:skills] actions count=${actions.length}`);
    return c.json(actions);
  });

  // Hot-reload all actions.yml files
  app.post('/actions/reload', async (c) => {
    const skillActionsMod = ctx.modules.tryGet<SkillActionsModule>('skill-actions');
    if (!skillActionsMod) {
      console.warn('[route:skills] actions reload requested but module unavailable');
      return c.json({ error: 'skill-actions module not available' }, 404);
    }
    console.log('[route:skills] actions reload requested');
    await skillActionsMod.reload();
    console.log(`[route:skills] actions reload done tools=${skillActionsMod.getToolDefinitions().length}`);
    return c.json({ ok: true, count: skillActionsMod.getToolDefinitions().length });
  });

  // Read a skill's SKILL.md content
  app.get('/:name', async (c) => {
    const skillsDir = getSkillsDir();
    if (!skillsDir) {
      console.warn('[route:skills] get requested but skillsDir not configured');
      return c.json({ error: 'skillsDir not configured' }, 404);
    }

    const name = c.req.param('name');
    if (name.includes('..') || name.includes('/')) {
      console.warn(`[route:skills] invalid skill name get name=${name}`);
      return c.json({ error: 'Invalid skill name' }, 400);
    }

    const skillFile = path.join(skillsDir, name, 'SKILL.md');
    try {
      const content = await fs.readFile(skillFile, 'utf-8');
      console.debug(`[route:skills] get name=${name} len=${content.length}`);
      return c.json({ name, content });
    } catch (err) {
      console.warn(`[route:skills] get name=${name} not found/readable: ${err instanceof Error ? err.message : err}`);
      return c.json({ error: 'Skill not found' }, 404);
    }
  });

  // Write a skill's SKILL.md content
  app.put('/:name', async (c) => {
    const skillsDir = getSkillsDir();
    if (!skillsDir) {
      console.warn('[route:skills] write requested but skillsDir not configured');
      return c.json({ error: 'skillsDir not configured' }, 404);
    }

    const name = c.req.param('name');
    if (name.includes('..') || name.includes('/')) {
      console.warn(`[route:skills] invalid skill name put name=${name}`);
      return c.json({ error: 'Invalid skill name' }, 400);
    }

    const body = await c.req.json<{ content: string }>();
    const skillFile = path.join(skillsDir, name, 'SKILL.md');
    console.log(`[route:skills] write name=${name} len=${body.content.length}`);
    await fs.writeFile(skillFile, body.content, 'utf-8');
    return c.json({ ok: true, name });
  });

  return app;
}
