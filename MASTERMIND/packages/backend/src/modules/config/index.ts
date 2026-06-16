import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Module, MastermindContext, MastermindConfig } from '@mastermind/shared';
import { applyLoggingFromConfig } from '../logger.js';
import { configSchema, loggingConfigSchema } from './schema.js';
import { getConfigStateMtimeMsFromPath } from './stateMtime.js';

export { getConfigStateMtimeMsFromPath };

/** Replace ${ENV_VAR} patterns with actual env values */
function substituteEnvVars(text: string): string {
  const matches = [...text.matchAll(/\$\{(\w+)\}/g)];
  if (matches.length > 0) {
    console.debug(`[config] substituteEnvVars count=${matches.length} vars=${[...new Set(matches.map(m => m[1]))].join(',')}`);
  }
  return text.replace(/\$\{(\w+)\}/g, (_match, varName) => {
    return process.env[varName] ?? '';
  });
}

/**
 * Deep-merge `override` into `base` (mutates base).
 * - Plain objects: recursive merge
 * - Arrays of objects with `id` field: merge by id (update existing, append new)
 * - Other arrays / scalars: override wins
 */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  for (const [key, val] of Object.entries(override)) {
    if (val === null || val === undefined) continue;
    const existing = base[key];

    if (
      typeof val === 'object' && !Array.isArray(val) &&
      typeof existing === 'object' && existing !== null && !Array.isArray(existing)
    ) {
      // Both plain objects — recurse
      deepMerge(existing as Record<string, unknown>, val as Record<string, unknown>);
    } else if (Array.isArray(val) && Array.isArray(existing)) {
      const first = val[0];
      if (first && typeof first === 'object' && 'id' in (first as object)) {
        // Array of {id, ...} — merge by id
        const byId = new Map((existing as Array<{ id: string }>).map(e => [e.id, e]));
        for (const item of val as Array<{ id: string }>) {
          if (byId.has(item.id)) {
            deepMerge(byId.get(item.id) as Record<string, unknown>, item as Record<string, unknown>);
          } else {
            (existing as unknown[]).push(item);
          }
        }
      } else {
        base[key] = val;
      }
    } else {
      base[key] = val;
    }
  }
  return base;
}

/**
 * Canonical path for persisted runtime config (API/UI saves).
 * Always `<directory_of_primary_yml>/mastermind.local.yml` — never derived from the
 * primary basename (avoids mastermind.local.local.yml if MASTERMIND_CONFIG already
 * pointed at a *.local.yml file).
 */
export function resolveRuntimeConfigPath(primaryConfigPath: string): string {
  return path.join(path.dirname(path.resolve(primaryConfigPath)), 'mastermind.local.yml');
}

export function loadConfigFromFile(configPath: string): MastermindConfig {
  const startedAt = Date.now();
  console.log(`[config] load start path=${configPath}`);
  if (!fs.existsSync(configPath)) {
    console.error(`[config] load failed missing path=${configPath}`);
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  console.debug(`[config] primary read bytes=${Buffer.byteLength(raw)} path=${configPath}`);
  const base = yaml.load(substituteEnvVars(raw)) as Record<string, unknown>;

  // Deep-merge mastermind.local.yml on top (secrets, runtime state, per-machine overrides)
  const localPath = resolveRuntimeConfigPath(configPath);
  if (fs.existsSync(localPath)) {
    const localRaw = fs.readFileSync(localPath, 'utf-8');
    console.debug(`[config] runtime overlay read bytes=${Buffer.byteLength(localRaw)} path=${localPath}`);
    const localParsed = yaml.load(substituteEnvVars(localRaw)) as Record<string, unknown>;
    if (localParsed && typeof localParsed === 'object') {
      deepMerge(base, localParsed);
      console.log(`[config] Merged overrides from ${path.basename(localPath)}`);
    }
  }

  // Older builds derived the overlay path from the basename (mastermind.local.yml → mastermind.local.local.yml).
  const legacyMisnamed = path.join(path.dirname(path.resolve(configPath)), 'mastermind.local.local.yml');
  if (fs.existsSync(legacyMisnamed)) {
    const legacyRaw = fs.readFileSync(legacyMisnamed, 'utf-8');
    console.debug(`[config] legacy overlay read bytes=${Buffer.byteLength(legacyRaw)} path=${legacyMisnamed}`);
    const legacyParsed = yaml.load(substituteEnvVars(legacyRaw)) as Record<string, unknown>;
    if (legacyParsed && typeof legacyParsed === 'object') {
      deepMerge(base, legacyParsed);
      console.warn(
        `[config] Merged legacy mis-saved file ${path.basename(legacyMisnamed)} — next save() will write to mastermind.local.yml only`,
      );
    }
  }

  const parsed = configSchema.parse(base);
  if (!parsed.logging) {
    parsed.logging = loggingConfigSchema.parse({});
  }
  console.log(`[config] load done agents=${Object.keys(parsed.agents).length} providers=${parsed.providers.length} modules loggingLevel=${parsed.logging.level} ms=${Date.now() - startedAt}`);
  return parsed;
}

export function saveConfigToFile(configPath: string, config: MastermindConfig): void {
  // Write only to mastermind.local.yml — never overwrites the git-tracked mastermind.yml
  const runtimePath = resolveRuntimeConfigPath(configPath);
  const content = yaml.dump(config, { lineWidth: 120, noRefs: true });
  console.debug(`[config] saveConfigToFile path=${runtimePath} bytes=${Buffer.byteLength(content)} agents=${Object.keys(config.agents).length} providers=${config.providers.length}`);
  fs.writeFileSync(runtimePath, content, 'utf-8');
}

export class ConfigModule implements Module {
  name = 'config';
  private configPath = '';
  private ctx!: MastermindContext;

  constructor(configPath: string) {
    this.configPath = path.resolve(configPath);
  }

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;
    const localPath = resolveRuntimeConfigPath(this.configPath);
    console.log(`[config] Primary YAML: ${this.configPath}`);
    console.log(`[config] Runtime persistence (read/write API state): ${localPath}`);
    if (!fs.existsSync(localPath)) {
      console.log(`[config] No ${path.basename(localPath)} yet — created on first save`);
    }
  }

  getConfigPath(): string {
    return this.configPath;
  }

  /** Same directory as primary config; all `save()` output goes here. */
  getRuntimeConfigPath(): string {
    return resolveRuntimeConfigPath(this.configPath);
  }

  /** Max mtime of primary + runtime files — use for reload-if-changed detection. */
  getConfigStateMtimeMs(): number {
    return getConfigStateMtimeMsFromPath(this.configPath);
  }

  /** Resolve a path relative to the config file directory */
  resolvePath(p: string): string {
    const resolved = path.isAbsolute(p) ? p : path.resolve(path.dirname(this.configPath), p);
    console.debug(`[config] resolvePath input=${p} resolved=${resolved}`);
    return resolved;
  }

  reload(): MastermindConfig {
    const startedAt = Date.now();
    console.log('[config] Reload requested');
    const config = loadConfigFromFile(this.configPath);
    Object.assign(this.ctx.config, config);
    applyLoggingFromConfig(this.configPath, this.ctx.config.logging);
    console.log(`[config] Reloaded ms=${Date.now() - startedAt}`);
    return config;
  }

  save(): void {
    const startedAt = Date.now();
    saveConfigToFile(this.configPath, this.ctx.config);
    console.log(`[config] Saved to ${path.basename(resolveRuntimeConfigPath(this.configPath))} ms=${Date.now() - startedAt}`);
  }
}
