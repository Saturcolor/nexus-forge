/**
 * CLI script to import existing .md memory files into the vector memory store (PostgreSQL).
 *
 * Usage:
 *   npx tsx src/scripts/import-memory.ts --agent assistant --file path/to/MEMORY.md
 *   npx tsx src/scripts/import-memory.ts --shared --dir path/to/shared-memory/decisions/ --domain decisions
 *   npx tsx src/scripts/import-memory.ts --shared --dir path/to/shared-memory/ --domain notes
 *
 * Options:
 *   --agent <id>     Agent ID (scope = 'agent'). Required if not --shared.
 *   --shared         Mark imported entries as scope='shared'.
 *   --file <path>    Import a single .md file.
 *   --dir <path>     Import all .md files in a directory (recursive).
 *   --domain <name>  Optional domain tag (decisions, errors, notes, etc.)
 *   --dry-run        Print what would be imported without writing to DB.
 */

import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createPool } from '../db/index.js';
import { loadConfigFromFile } from '../modules/config/index.js';
import { MemoryStore } from '../modules/memory-store/store.js';
import { buildEmbedConfig } from '../modules/memory-store/embedder.js';
import type { ImportOptions } from '../modules/memory-store/importer.js';

const configPath = process.env.MASTERMIND_CONFIG
  ?? path.resolve(import.meta.dirname, '../../../../config/mastermind.yml');

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    agent: { type: 'string' },
    shared: { type: 'boolean' },
    file: { type: 'string' },
    dir: { type: 'string' },
    domain: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
  strict: false,
});

const agentId = values['agent'] as string | undefined;
const isShared = values['shared'] === true;
const filePath = values['file'] as string | undefined;
const dirPath = values['dir'] as string | undefined;
const domain = values['domain'] as string | undefined;
const dryRun = values['dry-run'] === true;

if (!agentId && !isShared) {
  console.error('Error: specify --agent <id> or --shared');
  process.exit(1);
}
if (!filePath && !dirPath) {
  console.error('Error: specify --file <path> or --dir <path>');
  process.exit(1);
}

console.log(`[import-memory] Config: ${configPath}`);
const config = loadConfigFromFile(configPath);

if (!config.memoryStore?.enabled) {
  console.error('Error: memoryStore is not enabled in config (memoryStore.enabled: false)');
  process.exit(1);
}

const pool = createPool(config.database);
const embedCfg = buildEmbedConfig(config);
const store = new MemoryStore(pool, embedCfg);

const dimensions = config.memoryStore.embeddingDimensions ?? 4096;
await store.ensureSchema(dimensions);

const opts: ImportOptions = {
  agentId: isShared ? undefined : agentId,
  scope: isShared ? 'shared' : 'agent',
  domain,
  dryRun,
};

const { importMarkdownFile, importDirectory } = await import('../modules/memory-store/importer.js');

try {
  if (filePath) {
    const absPath = path.resolve(filePath);
    console.log(`[import-memory] Importing file: ${absPath}`);
    const result = await importMarkdownFile(absPath, store, opts);
    console.log(`[import-memory] Done: ${result.imported} imported, ${result.skippedInsignificant} skipped (insignificant), ${result.skippedDuplicate} skipped (duplicate), ${result.total} total chunks`);
  } else if (dirPath) {
    const absDir = path.resolve(dirPath);
    console.log(`[import-memory] Importing directory: ${absDir}`);
    const result = await importDirectory(absDir, store, opts);
    console.log(`[import-memory] Done: ${result.imported} imported, ${result.skippedInsignificant} skipped (insignificant), ${result.skippedDuplicate} skipped (duplicate), ${result.total} total chunks`);
  }
} finally {
  await pool.end();
}
