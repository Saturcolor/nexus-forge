import { Hono } from 'hono';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MastermindContext } from '@mastermind/shared';
import type { MemoryStoreModule } from '../modules/memory-store/index.js';
import { ReasoningTraceStore } from '../modules/reasoning-traces/index.js';

export function memoryStoreRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const reasoningTraceStore = new ReasoningTraceStore(ctx.db);

  function getStore(): MemoryStoreModule | undefined {
    return ctx.modules.tryGet<MemoryStoreModule>('memory-store');
  }

  function logRouteError(route: string, err: unknown): void {
    console.warn(`[memory-store] API ${route} error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── POST /api/memory-store/onboard ───────────────────────────────────────
  // Vérifie les prérequis (pgvector) et initialise le schéma si nécessaire.
  app.post('/onboard', async (c) => {
    console.log('[memory-store] API POST /onboard');
    const checks: Array<{ step: string; ok: boolean; message: string }> = [];

    // Step 1: Check pgvector availability
    try {
      const res = await ctx.db.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS exists`,
      );
      const available = res.rows[0]?.exists ?? false;
      checks.push({
        step: 'pgvector disponible',
        ok: available,
        message: available
          ? 'Extension pgvector présente dans pg_available_extensions.'
          : 'Extension pgvector introuvable. Installez postgresql-16-pgvector (ou équivalent) sur le serveur.',
      });
      if (!available) {
        return c.json({ ok: false, checks });
      }
    } catch (err) {
      logRouteError('POST /onboard pgvector-check', err);
      checks.push({ step: 'pgvector disponible', ok: false, message: err instanceof Error ? err.message : String(err) });
      return c.json({ ok: false, checks });
    }

    // Step 2: Create extension
    try {
      await ctx.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      checks.push({ step: 'CREATE EXTENSION vector', ok: true, message: 'Extension activée (ou déjà présente).' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRouteError('POST /onboard create-extension', err);
      const hint = /permission denied/i.test(msg)
        ? ` — L'utilisateur DB n'a pas les droits superuser. Exécutez en tant que postgres : psql -U postgres -d ${ctx.config.database.database} -c "CREATE EXTENSION IF NOT EXISTS vector;"`
        : '';
      checks.push({ step: 'CREATE EXTENSION vector', ok: false, message: msg + hint });
      return c.json({ ok: false, checks });
    }

    // Step 3: Create agent_memories table
    const dimensions = ctx.config.memoryStore?.embeddingDimensions ?? 4096;
    try {
      await ctx.db.query(`
        CREATE TABLE IF NOT EXISTS agent_memories (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          text       TEXT NOT NULL,
          embedding  VECTOR(${dimensions}),
          agent_id   TEXT,
          scope      TEXT NOT NULL DEFAULT 'agent',
          tags       TEXT[] DEFAULT '{}',
          domain     TEXT,
          source     TEXT NOT NULL DEFAULT 'manual',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories(agent_id);
        CREATE INDEX IF NOT EXISTS idx_agent_memories_scope ON agent_memories(scope);
        CREATE INDEX IF NOT EXISTS idx_agent_memories_domain ON agent_memories(domain);
        CREATE INDEX IF NOT EXISTS idx_agent_memories_created ON agent_memories(created_at DESC);
      `);
      checks.push({ step: 'Table agent_memories', ok: true, message: `Table et index créés (vector(${dimensions})).` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRouteError('POST /onboard table', err);
      checks.push({ step: 'Table agent_memories', ok: false, message: msg });
      return c.json({ ok: false, checks });
    }

    // Step 4: Create HNSW vector index (may fail if table already has rows with different dimensions — non-fatal)
    try {
      await ctx.db.query(
        `CREATE INDEX IF NOT EXISTS idx_agent_memories_hnsw ON agent_memories USING hnsw (embedding vector_cosine_ops)`,
      );
      checks.push({ step: 'Index HNSW (cosine)', ok: true, message: 'Index vectoriel HNSW créé (ou déjà présent).' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRouteError('POST /onboard hnsw-index', err);
      checks.push({ step: 'Index HNSW (cosine)', ok: false, message: `Non bloquant — ${msg}` });
      // Non-fatal: continue
    }

    // Step 5: Create reasoning_traces table
    try {
      await ctx.db.query(`
        CREATE TABLE IF NOT EXISTS reasoning_traces (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          session_id TEXT NOT NULL,
          agent_id   TEXT NOT NULL,
          query      TEXT,
          reasoning  TEXT,
          conclusion TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_reasoning_agent ON reasoning_traces(agent_id, created_at DESC);
      `);
      checks.push({ step: 'Table reasoning_traces', ok: true, message: 'Table créée (ou déjà présente).' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRouteError('POST /onboard reasoning-traces', err);
      checks.push({ step: 'Table reasoning_traces', ok: false, message: `Non bloquant — ${msg}` });
    }

    const allCriticalOk = checks.every(c => c.ok || c.message.startsWith('Non bloquant'));
    return c.json({ ok: allCriticalOk, checks });
  });

  // ── GET /api/memory-store/status ─────────────────────────────────────────
  app.get('/status', async (c) => {
    console.debug('[memory-store] API GET /status');
    const mod = getStore();
    if (!mod) {
      return c.json({ enabled: false, reason: 'Module non enregistré' });
    }
    if (!mod.isEnabled) {
      return c.json({ enabled: false, reason: 'memoryStore.enabled: false dans la config' });
    }
    try {
      const stats = await mod.stats();
      return c.json({ enabled: true, stats });
    } catch (err) {
      logRouteError('GET /status', err);
      return c.json({ enabled: true, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /api/memory-store/stats ──────────────────────────────────────────
  app.get('/stats', async (c) => {
    console.debug('[memory-store] API GET /stats');
    const mod = getStore();
    if (!mod?.isEnabled) return c.json({ error: 'Memory store non activé' }, 503);
    try {
      const stats = await mod.stats();
      return c.json(stats);
    } catch (err) {
      logRouteError('GET /stats', err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── GET /api/memory-store/entries ────────────────────────────────────────
  // Query params: agentId, scope ('agent'|'shared'|'all'), domain, q (semantic search), page, limit
  app.get('/entries', async (c) => {
    const mod = getStore();
    if (!mod?.isEnabled) return c.json({ error: 'Memory store non activé' }, 503);

    const agentId = c.req.query('agentId') || undefined;
    const scopeParam = c.req.query('scope') ?? 'all';
    const domain = c.req.query('domain') || undefined;
    const q = c.req.query('q') || undefined;
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)));

    console.log(
      `[memory-store] API GET /entries q=${q ? `"${q.slice(0, 40)}${q.length > 40 ? '…' : ''}"` : '∅'} agent=${agentId ?? '∅'} scope=${scopeParam} page=${page}`,
    );

    // Semantic search mode
    if (q) {
      try {
        const scopes: Array<'agent' | 'shared'> =
          scopeParam === 'agent' ? ['agent']
          : scopeParam === 'shared' ? ['shared']
          : ['agent', 'shared'];
        const hits = await mod.search(q, {
          agentId,
          scopes,
          domain,
          topK: limit,
          threshold: 0.2,
        });
        return c.json({
          entries: hits.map(h => ({ ...h.entry, similarity: h.similarity })),
          total: hits.length,
          page: 1,
          pages: 1,
        });
      } catch (err) {
        logRouteError('GET /entries search', err);
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // Listing mode
    try {
      const scope = scopeParam === 'agent' ? 'agent' : scopeParam === 'shared' ? 'shared' : undefined;
      const archived = c.req.query('archived') === 'true';
      const result = await mod.list({ agentId, scope, domain, archived }, page, limit);
      return c.json({ ...result, page, pages: Math.ceil(result.total / limit) });
    } catch (err) {
      logRouteError('GET /entries list', err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── POST /api/memory-store/entries ───────────────────────────────────────
  app.post('/entries', async (c) => {
    const mod = getStore();
    if (!mod?.isEnabled) return c.json({ error: 'Memory store non activé' }, 503);

    console.log('[memory-store] API POST /entries (manuel)');
    let body: { text?: string; agentId?: string; scope?: string; domain?: string; tags?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'JSON invalide' }, 400);
    }

    if (!body.text?.trim()) return c.json({ error: 'text requis' }, 400);

    try {
      const id = await mod.add({
        text: body.text.trim(),
        agentId: body.agentId || undefined,
        scope: body.scope === 'shared' ? 'shared' : 'agent',
        domain: body.domain || undefined,
        tags: body.tags || [],
        source: 'manual',
      });
      return c.json({ ok: true, id });
    } catch (err) {
      logRouteError('POST /entries', err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── PUT /api/memory-store/entries/:id ────────────────────────────────────
  app.put('/entries/:id', async (c) => {
    const mod = getStore();
    if (!mod?.isEnabled) return c.json({ error: 'Memory store non activé' }, 503);

    const id = c.req.param('id');
    console.log(`[memory-store] API PUT /entries/${id.slice(0, 8)}…`);
    let body: { text?: string; domain?: string; tags?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'JSON invalide' }, 400);
    }

    try {
      await mod.update(id, { text: body.text, domain: body.domain, tags: body.tags });
      return c.json({ ok: true });
    } catch (err) {
      logRouteError(`PUT /entries/${id.slice(0, 8)}`, err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── DELETE /api/memory-store/entries/:id ─────────────────────────────────
  app.delete('/entries/:id', async (c) => {
    const mod = getStore();
    if (!mod?.isEnabled) return c.json({ error: 'Memory store non activé' }, 503);

    const id = c.req.param('id');
    console.log(`[memory-store] API DELETE /entries/${id.slice(0, 8)}…`);
    try {
      await mod.delete(id);
      return c.json({ ok: true });
    } catch (err) {
      logRouteError(`DELETE /entries/${id.slice(0, 8)}`, err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── POST /api/memory-store/import ────────────────────────────────────────
  // Accepts multipart: file (.md), agentId, scope, domain, dryRun
  app.post('/import', async (c) => {
    const mod = getStore();
    if (!mod?.isEnabled) return c.json({ error: 'Memory store non activé' }, 503);

    console.log('[memory-store] API POST /import');
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: 'Multipart form data attendu' }, 400);
    }

    const file = formData.get('file');
    if (!(file instanceof File)) return c.json({ error: 'Champ "file" requis (.md)' }, 400);

    const agentId = (formData.get('agentId') as string | null) || undefined;
    const scopeVal = (formData.get('scope') as string | null) ?? 'agent';
    const domain = (formData.get('domain') as string | null) || undefined;
    const dryRun = (formData.get('dryRun') as string | null) === 'true';

    // Write temp file. Sanitize `file.name` (attacker-controlled multipart field)
    // before interpolating into the temp path: `basename` drops any path component
    // (`../`, `C:\…`), then strip filesystem-unsafe chars and leading dots — otherwise
    // a name like `../../etc/foo` escapes tmpdir for both the write and the unlink below.
    // Same pattern as routes/upload.ts.
    const safeName = (path.basename(file.name) || 'upload')
      .replace(/[\\/:*?"<>|\x00]/g, '_')
      .replace(/^\.+/, '') || 'upload';
    const tmpPath = path.join(os.tmpdir(), `ms-import-${Date.now()}-${safeName}`);
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(tmpPath, buffer);

      const { importMarkdownFile } = await import('../modules/memory-store/importer.js');
      if (!mod.store) return c.json({ error: 'MemoryStore indisponible' }, 503);
      const result = await importMarkdownFile(tmpPath, mod.store, {
        agentId,
        scope: scopeVal === 'shared' ? 'shared' : 'agent',
        domain,
        dryRun,
      });

      return c.json({ ok: true, ...result });
    } catch (err) {
      logRouteError('POST /import', err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  // ── POST /api/memory-store/export ────────────────────────────────────────
  // Body: { includeArchived?: boolean }
  // Écrit un fichier .md dans {sharedMemoryDir}/export/
  app.post('/export', async (c) => {
    const mod = getStore();
    if (!mod?.isEnabled) return c.json({ error: 'Memory store non activé' }, 503);

    let body: { includeArchived?: boolean } = {};
    try {
      body = await c.req.json().catch(() => ({}));
    } catch { /* body optionnel */ }
    const includeArchived = body.includeArchived === true;

    const sharedMemoryDir = ctx.config.paths?.sharedMemoryDir;
    if (!sharedMemoryDir) {
      return c.json({ error: 'paths.sharedMemoryDir non configuré' }, 500);
    }

    console.log(`[memory-store] API POST /export includeArchived=${includeArchived}`);
    try {
      const result = await mod.exportMarkdown(sharedMemoryDir, { includeArchived });
      return c.json({ ok: true, ...result });
    } catch (err) {
      logRouteError('POST /export', err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── POST /api/memory-store/reembed ────────────────────────────────────────
  // Re-génère les embeddings pour les entrées qui n'en ont pas
  app.post('/reembed', async (c) => {
    const mod = getStore();
    if (!mod?.isEnabled) return c.json({ error: 'Memory store non activé' }, 503);

    console.log('[memory-store] API POST /reembed — start');
    try {
      const count = await mod.reembedMissing((done, total) => {
        if (done % 5 === 0 || done === total) {
          console.debug(`[memory-store] reembed progress: ${done}/${total}`);
        }
      });
      console.log(`[memory-store] API POST /reembed — done: ${count} embedded`);
      return c.json({ ok: true, embedded: count });
    } catch (err) {
      logRouteError('POST /reembed', err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── GET /api/memory-store/reasoning-traces ────────────────────────────────
  // Query params: agentId (required), limit, offset
  app.get('/reasoning-traces', async (c) => {
    const agentId = c.req.query('agentId');
    if (!agentId) return c.json({ error: 'agentId requis' }, 400);

    console.debug(`[memory-store] API GET /reasoning-traces agent=${agentId}`);

    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)));
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10));

    try {
      const result = await reasoningTraceStore.list(agentId, { limit, offset });
      return c.json(result);
    } catch (err) {
      logRouteError('GET /reasoning-traces', err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}
