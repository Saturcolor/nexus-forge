import { Hono } from 'hono';
import type { MastermindContext, CreateTaskInput, UpdateTaskInput, TaskKind } from '@mastermind/shared';
import type { SchedulerModule } from '../modules/scheduler/index.js';

export function schedulerRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();

  function getScheduler(): SchedulerModule {
    return ctx.modules.get<SchedulerModule>('scheduler');
  }

  // List tasks (optional ?agentId= and ?kind= filters)
  app.get('/tasks', async (c) => {
    const agentId = c.req.query('agentId');
    const kindParam = c.req.query('kind');
    const kind: TaskKind | undefined = kindParam === 'proactive' || kindParam === 'task' ? kindParam : undefined;
    console.debug(`[route:scheduler] list tasks agent=${agentId ?? 'all'} kind=${kind ?? 'all'}`);
    const tasks = await getScheduler().listTasks(agentId, kind);
    console.debug(`[route:scheduler] list tasks result count=${tasks.length}`);
    return c.json(tasks);
  });

  // List soft-deleted tasks (corbeille)
  app.get('/tasks/trash', async (c) => {
    console.debug(`[route:scheduler] list trash`);
    const tasks = await getScheduler().listDeletedTasks();
    return c.json(tasks);
  });

  // Get single task
  app.get('/tasks/:id', async (c) => {
    const id = c.req.param('id');
    console.debug(`[route:scheduler] get task=${id}`);
    const task = await getScheduler().getTask(id);
    if (!task) {
      console.warn(`[route:scheduler] get task=${id} not found`);
      return c.json({ error: 'Task not found' }, 404);
    }
    return c.json(task);
  });

  // Create task
  app.post('/tasks', async (c) => {
    try {
      const body = await c.req.json<CreateTaskInput>();
      console.log(`[route:scheduler] create task name="${body.name}" agent=${body.agentId} kind=${body.kind ?? 'task'} schedule=${body.scheduleKind}`);
      const task = await getScheduler().createTask(body);
      return c.json(task, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[route:scheduler] create task failed: ${msg}`);
      return c.json({ error: msg }, 400);
    }
  });

  // Update task
  app.put('/tasks/:id', async (c) => {
    const id = c.req.param('id');
    try {
      const body = await c.req.json<UpdateTaskInput>();
      console.log(`[route:scheduler] update task=${id} keys=${Object.keys(body).join(',')}`);
      const task = await getScheduler().updateTask(id, body);
      if (!task) {
        console.warn(`[route:scheduler] update task=${id} not found`);
        return c.json({ error: 'Task not found' }, 404);
      }
      return c.json(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[route:scheduler] update task=${id} failed: ${msg}`);
      return c.json({ error: msg }, 400);
    }
  });

  // Delete task (soft → corbeille)
  app.delete('/tasks/:id', async (c) => {
    const id = c.req.param('id');
    console.log(`[route:scheduler] delete task=${id} (soft)`);
    const ok = await getScheduler().deleteTask(id);
    if (!ok) {
      console.warn(`[route:scheduler] delete task=${id} not found`);
      return c.json({ error: 'Task not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Restore task from corbeille
  app.post('/tasks/:id/restore', async (c) => {
    const id = c.req.param('id');
    console.log(`[route:scheduler] restore task=${id}`);
    const task = await getScheduler().restoreTask(id);
    if (!task) {
      console.warn(`[route:scheduler] restore task=${id} not found in trash`);
      return c.json({ error: 'Task not found in trash' }, 404);
    }
    return c.json(task);
  });

  // Permanently purge task from corbeille
  app.delete('/tasks/:id/purge', async (c) => {
    const id = c.req.param('id');
    console.log(`[route:scheduler] purge task=${id} (permanent)`);
    const ok = await getScheduler().purgeTask(id);
    if (!ok) {
      console.warn(`[route:scheduler] purge task=${id} not found in trash`);
      return c.json({ error: 'Task not found in trash' }, 404);
    }
    return c.json({ ok: true });
  });

  // Toggle task enabled/disabled
  app.post('/tasks/:id/toggle', async (c) => {
    const id = c.req.param('id');
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    console.log(`[route:scheduler] toggle task=${id} enabled=${enabled}`);
    const task = await getScheduler().toggleTask(id, enabled);
    if (!task) {
      console.warn(`[route:scheduler] toggle task=${id} not found`);
      return c.json({ error: 'Task not found' }, 404);
    }
    return c.json(task);
  });

  // Run task immediately
  app.post('/tasks/:id/run', async (c) => {
    const id = c.req.param('id');
    try {
      console.log(`[route:scheduler] runNow task=${id}`);
      await getScheduler().runNow(id);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[route:scheduler] runNow task=${id} failed: ${msg}`);
      return c.json({ error: msg }, 400);
    }
  });

  // Get runs for a task
  app.get('/tasks/:id/runs', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '20');
    const id = c.req.param('id');
    console.debug(`[route:scheduler] task runs task=${id} limit=${limit}`);
    const runs = await getScheduler().getTaskRuns(id, limit);
    console.debug(`[route:scheduler] task runs task=${id} count=${runs.length}`);
    return c.json(runs);
  });

  // Get all recent runs
  app.get('/runs', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50');
    console.debug(`[route:scheduler] recent runs limit=${limit}`);
    const runs = await getScheduler().getRecentRuns(limit);
    console.debug(`[route:scheduler] recent runs count=${runs.length}`);
    return c.json(runs);
  });

  // ── Proactive alerts ─────────────────────────────────────
  // List recent proactive/escalation runs (for the Proactive tab audit view)
  app.get('/alerts/recent', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50');
    console.debug(`[route:scheduler] alerts recent limit=${limit}`);
    const runs = await getScheduler().listAlerts(limit);
    console.debug(`[route:scheduler] alerts recent count=${runs.length}`);
    return c.json(runs);
  });

  // Acknowledge an alert (marks acknowledged_at)
  app.post('/alerts/:runId/ack', async (c) => {
    const runId = c.req.param('runId');
    console.log(`[route:scheduler] ack alert run=${runId}`);
    const ok = await getScheduler().ackAlert(runId);
    if (!ok) console.warn(`[route:scheduler] ack alert run=${runId} no row updated`);
    return c.json({ ok });
  });

  return app;
}
