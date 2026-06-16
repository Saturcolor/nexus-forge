import fs from 'node:fs';
import path from 'node:path';

/** Must match `resolveRuntimeConfigPath` in index.ts */
const RUNTIME_CONFIG_BASENAME = 'mastermind.local.yml';
const LEGACY_MISNAMED_BASENAME = 'mastermind.local.local.yml';

/** Max mtime of primary YAML + runtime overlay + optional legacy misnamed file (reload detection). */
export function getConfigStateMtimeMsFromPath(primaryConfigPath: string): number {
  const resolved = path.resolve(primaryConfigPath);
  console.debug(`[config] stateMtime start primary=${resolved}`);
  let m = fs.statSync(resolved).mtimeMs;
  const run = path.join(path.dirname(resolved), RUNTIME_CONFIG_BASENAME);
  if (fs.existsSync(run)) {
    m = Math.max(m, fs.statSync(run).mtimeMs);
    console.debug(`[config] stateMtime runtime present path=${run}`);
  } else {
    console.debug(`[config] stateMtime runtime missing path=${run}`);
  }
  const legacy = path.join(path.dirname(resolved), LEGACY_MISNAMED_BASENAME);
  if (fs.existsSync(legacy)) {
    m = Math.max(m, fs.statSync(legacy).mtimeMs);
    console.warn(`[config] stateMtime legacy misnamed present path=${legacy}`);
  }
  console.debug(`[config] stateMtime done mtimeMs=${m}`);
  return m;
}
