import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { AgentModule } from '../modules/agent/index.js';
import type { MemoryModule } from '../modules/memory/index.js';

export function memoryRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const memoryMod = ctx.modules.get<MemoryModule>('memory');
  const agentMod = ctx.modules.get<AgentModule>('agent');

  // List shared memory directory
  app.get('/shared', async (c) => {
    const pathParam = c.req.query('path') ?? '';
    console.debug(`[route:memory] list shared path="${pathParam}"`);
    const entries = await memoryMod.shared.listDir(pathParam);
    console.debug(`[route:memory] list shared path="${pathParam}" entries=${entries.length}`);
    return c.json(entries);
  });

  // Read shared memory file
  app.get('/shared/*', async (c) => {
    const filePath = c.req.path.replace('/api/memory/shared/', '');
    console.debug(`[route:memory] read shared file=${filePath}`);
    const content = await memoryMod.shared.readFile(filePath);
    if (content === null) {
      console.warn(`[route:memory] read shared file=${filePath} not found`);
      return c.json({ error: 'File not found' }, 404);
    }
    console.debug(`[route:memory] read shared file=${filePath} len=${content.length}`);
    return c.json({ path: filePath, content });
  });

  // Write shared memory file
  app.put('/shared/*', async (c) => {
    const filePath = c.req.path.replace('/api/memory/shared/', '');
    const body = await c.req.json<{ content: string }>();
    console.debug(`[route:memory] write shared file=${filePath} len=${body.content.length}`);
    await memoryMod.shared.writeFile(filePath, body.content);
    // Do NOT invalidate the prompt cache here — the TTL controls when the prompt is rebuilt.
    // Immediate invalidation on file writes bypasses the TTL entirely.
    return c.json({ ok: true, path: filePath });
  });

  return app;
}
