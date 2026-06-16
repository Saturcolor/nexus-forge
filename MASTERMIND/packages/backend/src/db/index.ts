import pg from 'pg';
import type { DatabaseConfig } from '@mastermind/shared';

const { Pool } = pg;

let pool: pg.Pool;

export function createPool(config: DatabaseConfig): pg.Pool {
  pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 20,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });

  pool.on('error', (err) => {
    console.error('[db] Unexpected pool error:', err.message);
  });

  console.log(`[db] Pool ready ${config.user}@${config.host}:${config.port}/${config.database}`);

  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) {
    console.error('[db] getPool before initialization');
    throw new Error('Database pool not initialized');
  }
  console.debug('[db] getPool ok');
  return pool;
}

export async function queryWithTimeout<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
  timeoutMs = 30_000,
): Promise<pg.QueryResult<T>> {
  const activePool = getPool();
  const startedAt = Date.now();
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  console.debug(`[db] query start timeoutMs=${timeoutMs} params=${params?.length ?? 0} sql="${preview}"`);
  const client = await activePool.connect();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    client.release(true);
  }, timeoutMs);

  try {
    const result = await client.query<T>(text, params);
    console.debug(`[db] query done rows=${result.rowCount ?? result.rows.length} ms=${Date.now() - startedAt} sql="${preview}"`);
    return result;
  } catch (err) {
    if (timedOut) {
      console.warn(`[db] query timeout after=${timeoutMs}ms sql="${preview}"`);
      throw new Error(`Database query timed out after ${timeoutMs}ms`);
    }
    console.warn(`[db] query failed ms=${Date.now() - startedAt} sql="${preview}": ${err instanceof Error ? err.message : err}`);
    throw err;
  } finally {
    clearTimeout(timeout);
    if (!timedOut) {
      client.release();
    }
  }
}
