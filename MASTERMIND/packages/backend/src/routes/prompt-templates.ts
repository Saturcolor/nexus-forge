import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { PromptTemplatesModule } from '../modules/prompt-templates/index.js';
import { TEMPLATE_KEYS } from '../modules/prompt-templates/defaults.js';
import { invalidateTelegramPromptCache } from '../modules/agent/run.js';

/**
 * Prompt templates CRUD — lets the Prompt Builder UI (Advanced tab) edit the
 * editable sections of the system prompt (platform, environment, lazy-skills-summary,
 * memory-stub, subagent-harness).
 *
 * Overrides land in `shared/prompt-templates/<key>.md` on disk. Hot reload via
 * fs.watch in PromptTemplatesModule + `invalidateTelegramPromptCache()` invalidates
 * cached system prompts so the next message uses the new template.
 */
export function promptTemplatesRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const mod = ctx.modules.get<PromptTemplatesModule>('prompt-templates');

  // List all template metadata (key, source, sizes, variables manifest, missing required).
  app.get('/', (c) => {
    const list = mod.listAll();
    console.debug(`[route:prompt-templates] list count=${list.length}`);
    return c.json(list);
  });

  // Get one template — current content (override or default) + metadata.
  app.get('/:key', (c) => {
    const key = c.req.param('key');
    if (!TEMPLATE_KEYS.includes(key)) {
      return c.json({ error: `Unknown template key: ${key}` }, 404);
    }
    return c.json(mod.getInfo(key));
  });

  // Get the hardcoded default for diff view (always returns the baseline, never the override).
  app.get('/:key/default', (c) => {
    const key = c.req.param('key');
    if (!TEMPLATE_KEYS.includes(key)) {
      return c.json({ error: `Unknown template key: ${key}` }, 404);
    }
    const content = mod.getDefault(key);
    return c.json({ key, content, chars: content.length, estimatedTokens: Math.max(1, Math.round(content.length / 4)) });
  });

  // Persist an override. Validates required variables are present.
  app.put('/:key', async (c) => {
    const key = c.req.param('key');
    if (!TEMPLATE_KEYS.includes(key)) {
      return c.json({ error: `Unknown template key: ${key}` }, 404);
    }
    let body: { content?: string };
    try {
      body = await c.req.json<{ content?: string }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (typeof body.content !== 'string') {
      return c.json({ error: 'Body must contain { content: string }' }, 400);
    }
    try {
      await mod.setOverride(key, body.content);
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === 'TEMPLATE_MISSING_REQUIRED_VARS') {
        // 422 — semantically distinct from a malformed payload (400) or unknown key (404).
        return c.json({ error: e.message, code: 'TEMPLATE_MISSING_REQUIRED_VARS' }, 422);
      }
      if (e.code === 'TEMPLATE_TOO_LARGE') {
        // 413 — payload too large.
        return c.json({ error: e.message, code: 'TEMPLATE_TOO_LARGE' }, 413);
      }
      console.warn(`[route:prompt-templates] PUT ${key} failed: ${e.message}`);
      return c.json({ error: e.message }, 500);
    }
    // Invalidate the system prompt cache so the next message picks up the new template.
    // We use the telegram cache helper because it's the shared TTL cache for ALL sessions
    // (web + telegram) per agent (despite its name) — see modules/agent/prompt-cache.ts.
    invalidateTelegramPromptCache();
    console.log(`[route:prompt-templates] PUT ${key} ok (${body.content.length} chars) — prompt cache invalidated`);
    return c.json(mod.getInfo(key));
  });

  // Remove the override, revert to default.
  app.delete('/:key', async (c) => {
    const key = c.req.param('key');
    if (!TEMPLATE_KEYS.includes(key)) {
      return c.json({ error: `Unknown template key: ${key}` }, 404);
    }
    const removed = await mod.clearOverride(key);
    invalidateTelegramPromptCache();
    console.log(`[route:prompt-templates] DELETE ${key} ok (fileRemoved=${removed}) — prompt cache invalidated`);
    return c.json(mod.getInfo(key));
  });

  return app;
}
