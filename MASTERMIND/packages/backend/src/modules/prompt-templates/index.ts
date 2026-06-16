/**
 * Prompt Templates module.
 *
 * Externalises editable prompt sections (platform, environment, lazy-skills-summary,
 * memory-stub, subagent-harness) from hardcoded TS strings to user-editable .md files
 * stored under `shared/prompt-templates/`.
 *
 * Lifecycle:
 *  - `init()` resolves the templates dir + reads all existing override files into memory cache.
 *  - `fs.watch` invalidates cache entries on file change.
 *  - `render(key, vars)` returns override (if exists) else default, with `{{var}}` replaced.
 *  - PUT/DELETE through routes/prompt-templates.ts → writes file → fs.watch picks it up.
 *
 * Safety:
 *  - If an override file is missing, malformed, or the dir doesn't exist, render() always
 *    falls back to the hardcoded default exported from `defaults.ts`. No prompt ever empty.
 *  - `getDefault()` exposes the hardcoded baseline for diff view in the UI.
 *
 * Cache invalidation:
 *  - When a template changes (PUT/DELETE/external edit via Syncthing/Git), we invalidate
 *    the agent prompt cache TTL so the next message uses the new template.
 *  - Caller (route handler or fs.watch) decides when to call `invalidateAgentPromptCache`.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { Module, MastermindContext } from '@mastermind/shared';
import { DEFAULTS, TEMPLATE_KEYS } from './defaults.js';
import { TEMPLATE_VARIABLES, extractTemplateVariables, validateRequiredVariables, type VariableSpec } from './variables.js';

/** Hard cap on override file size — defense against accidental garbage / DoS via massive .md. */
export const MAX_TEMPLATE_BYTES = 100_000; // 100 KB — largest legit template (platform) is ~6 KB

export interface TemplateInfo {
  key: string;
  /** 'override' if user-edited file exists, 'default' otherwise. */
  source: 'override' | 'default';
  /** Current content (override or default). */
  content: string;
  /** Chars + estimated tokens of current content. */
  chars: number;
  estimatedTokens: number;
  /** Variable manifest (required + optional, with descriptions). */
  variables: VariableSpec[];
  /** Variables actually used in the current content. */
  usedVariables: string[];
  /** Required variables missing from current content (sanity warning). */
  missingRequired: string[];
}

export class PromptTemplatesModule implements Module {
  name = 'prompt-templates';

  private templatesDir = '';
  private cache = new Map<string, string>();
  private watcher: fsSync.FSWatcher | null = null;
  private onChangeListeners: Array<(key: string) => void> = [];

  async init(ctx: MastermindContext): Promise<void> {
    const startedAt = Date.now();
    const configMod = ctx.modules.get<import('../config/index.js').ConfigModule>('config');
    const sharedDir = configMod.resolvePath(ctx.config.paths.sharedMemoryDir);
    this.templatesDir = path.join(sharedDir, 'prompt-templates');
    console.log(`[prompt-templates] init dir=${this.templatesDir}`);

    try {
      await fs.mkdir(this.templatesDir, { recursive: true });
    } catch (err) {
      console.warn(`[prompt-templates] mkdir failed (non-fatal, will fall back to defaults): ${err instanceof Error ? err.message : err}`);
      console.log(`[prompt-templates] init done ms=${Date.now() - startedAt} (no overrides — defaults only)`);
      return;
    }

    // Initial load — read all existing .md override files into cache.
    // Applies the same size check as reloadFromDisk: oversize files are skipped (cache stays
    // on default) so a corrupted/runaway file can't OOM the backend at boot.
    let loaded = 0;
    for (const key of TEMPLATE_KEYS) {
      const filePath = path.join(this.templatesDir, `${key}.md`);
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_TEMPLATE_BYTES) {
          console.warn(`[prompt-templates] init skip key=${key} size=${stat.size} > MAX_TEMPLATE_BYTES=${MAX_TEMPLATE_BYTES} (falling back to default)`);
          continue;
        }
        const content = await fs.readFile(filePath, 'utf-8');
        const missingRequired = validateRequiredVariables(key, content);
        if (missingRequired.length > 0) {
          console.warn(`[prompt-templates] init key=${key} loaded but required variables missing: ${missingRequired.map(v => `{{${v}}}`).join(', ')}`);
        }
        this.cache.set(key, content);
        loaded++;
        console.debug(`[prompt-templates] loaded override key=${key} chars=${content.length}`);
      } catch {
        // File missing — fall back to default at render time. Not an error.
      }
    }

    // Watch for fs changes (Syncthing, manual edits, UI saves all trigger this).
    try {
      this.watcher = fsSync.watch(this.templatesDir, { persistent: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.md')) return;
        const key = filename.replace(/\.md$/, '');
        if (!TEMPLATE_KEYS.includes(key)) {
          console.debug(`[prompt-templates] watch ignored non-template file=${filename}`);
          return;
        }
        // Re-read async. Errors here are benign (file might be mid-write).
        this.reloadFromDisk(key).catch(err => {
          console.warn(`[prompt-templates] reload failed key=${key}: ${err instanceof Error ? err.message : err}`);
        });
      });
      console.log(`[prompt-templates] watcher attached on ${this.templatesDir}`);
    } catch (err) {
      console.warn(`[prompt-templates] fs.watch failed (non-fatal, hot reload disabled): ${err instanceof Error ? err.message : err}`);
    }

    console.log(`[prompt-templates] init done ms=${Date.now() - startedAt} loaded=${loaded}/${TEMPLATE_KEYS.length}`);
  }

  /**
   * Render a template with variables substituted.
   * Returns override content if present, otherwise the hardcoded default.
   * Missing variables are left as `{{varName}}` literals (visible in output → defensive).
   */
  render(key: string, vars: Record<string, string> = {}): string {
    const template = this.getRaw(key);
    return this.applyVars(template, vars);
  }

  /** Get the raw template content (override or default), without variable substitution. */
  getRaw(key: string): string {
    const override = this.cache.get(key);
    if (override !== undefined) return override;
    return DEFAULTS[key] ?? '';
  }

  /** Get the hardcoded default (for diff view in UI). */
  getDefault(key: string): string {
    return DEFAULTS[key] ?? '';
  }

  /** Check whether an override is currently active for `key`. */
  hasOverride(key: string): boolean {
    return this.cache.has(key);
  }

  /** List all known template keys with metadata. */
  listAll(): TemplateInfo[] {
    return TEMPLATE_KEYS.map(key => this.getInfo(key));
  }

  getInfo(key: string): TemplateInfo {
    const content = this.getRaw(key);
    const variables = TEMPLATE_VARIABLES[key] ?? [];
    const usedVariables = extractTemplateVariables(content);
    const missingRequired = validateRequiredVariables(key, content);
    return {
      key,
      source: this.cache.has(key) ? 'override' : 'default',
      content,
      chars: content.length,
      estimatedTokens: Math.max(1, Math.round(content.length / 4)),
      variables,
      usedVariables,
      missingRequired,
    };
  }

  /**
   * Persist a new override for `key`. Throws if validation fails (missing required vars).
   * Returns the saved content (post-validation, pre-render).
   */
  async setOverride(key: string, content: string): Promise<{ content: string; missingRequired: string[] }> {
    if (!TEMPLATE_KEYS.includes(key)) {
      throw new Error(`Unknown template key: ${key}`);
    }
    // Size guard — prevents accidental garbage / DoS via massive override.
    if (Buffer.byteLength(content, 'utf-8') > MAX_TEMPLATE_BYTES) {
      const err = new Error(`Template too large: ${Buffer.byteLength(content, 'utf-8')} bytes > ${MAX_TEMPLATE_BYTES} bytes max`);
      (err as Error & { code?: string }).code = 'TEMPLATE_TOO_LARGE';
      throw err;
    }
    const missingRequired = validateRequiredVariables(key, content);
    if (missingRequired.length > 0) {
      const err = new Error(`Required variables missing: ${missingRequired.map(v => `{{${v}}}`).join(', ')}`);
      (err as Error & { code?: string }).code = 'TEMPLATE_MISSING_REQUIRED_VARS';
      throw err;
    }
    if (!this.templatesDir) {
      throw new Error('Templates directory not initialised — module not ready');
    }
    await fs.mkdir(this.templatesDir, { recursive: true });
    const filePath = path.join(this.templatesDir, `${key}.md`);
    await fs.writeFile(filePath, content, 'utf-8');
    this.cache.set(key, content);
    console.log(`[prompt-templates] set override key=${key} chars=${content.length}`);
    this.fireChange(key);
    return { content, missingRequired: [] };
  }

  /** Remove the override, falling back to default. Returns true if a file was deleted. */
  async clearOverride(key: string): Promise<boolean> {
    if (!TEMPLATE_KEYS.includes(key)) {
      throw new Error(`Unknown template key: ${key}`);
    }
    this.cache.delete(key);
    const filePath = path.join(this.templatesDir, `${key}.md`);
    try {
      await fs.unlink(filePath);
      console.log(`[prompt-templates] cleared override key=${key} (file deleted)`);
      this.fireChange(key);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.debug(`[prompt-templates] clear override key=${key} (no file present, in-memory only)`);
        this.fireChange(key);
        return false;
      }
      throw err;
    }
  }

  /** Subscribe to change notifications (called whenever override is added/changed/removed). */
  onChange(listener: (key: string) => void): () => void {
    this.onChangeListeners.push(listener);
    return () => {
      this.onChangeListeners = this.onChangeListeners.filter(l => l !== listener);
    };
  }

  private fireChange(key: string): void {
    for (const l of this.onChangeListeners) {
      try { l(key); } catch (err) {
        console.warn(`[prompt-templates] onChange listener error: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Reload a template from disk after an external edit (Syncthing, manual file editor, etc.).
   *
   * Behavior:
   *  - If file is missing → drop cache (revert to default), fire change.
   *  - If file too large → reject (keep old override or default), log warn.
   *  - If required vars missing → ACCEPT but log warn (operator's call — direct file edits
   *    bypass UI validation by design, but we surface the issue in logs so the agent prompt
   *    breakage is debuggable). The fireChange still propagates so the cache invalidator
   *    re-runs prompt cache TTL on the next message.
   *  - Otherwise → update cache + fire change.
   *
   * `fireChange` is subscribed by the bootstrap (index.ts) to invalidate the agent prompt
   * TTL cache — this means a Syncthing-edited template propagates to the next message,
   * matching the UI Save path.
   */
  private async reloadFromDisk(key: string): Promise<void> {
    const filePath = path.join(this.templatesDir, `${key}.md`);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_TEMPLATE_BYTES) {
        console.warn(`[prompt-templates] reload rejected key=${key} size=${stat.size} > MAX_TEMPLATE_BYTES=${MAX_TEMPLATE_BYTES} (file kept on disk but cache unchanged)`);
        return;
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const prev = this.cache.get(key);
      if (prev === content) return; // no-op
      const missingRequired = validateRequiredVariables(key, content);
      if (missingRequired.length > 0) {
        console.warn(`[prompt-templates] reload key=${key} chars=${content.length} — required variables missing: ${missingRequired.map(v => `{{${v}}}`).join(', ')} (accepted because external edit bypasses UI validation; agent prompts will contain literal placeholders for those vars until fixed)`);
      }
      this.cache.set(key, content);
      console.log(`[prompt-templates] reload from disk key=${key} chars=${content.length}${missingRequired.length > 0 ? ` (⚠️ ${missingRequired.length} required var(s) missing)` : ''}`);
      this.fireChange(key);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // File deleted externally — drop from cache (revert to default).
        if (this.cache.has(key)) {
          this.cache.delete(key);
          console.log(`[prompt-templates] file gone key=${key} (reverted to default)`);
          this.fireChange(key);
        }
      } else {
        throw err;
      }
    }
  }

  /**
   * Apply variable substitutions. `{{varName}}` patterns missing from `vars` are left intact
   * (defensive — visible in output rather than silent empty string).
   * Supports dotted names like `{{fleetRoster.standard}}`.
   */
  private applyVars(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{([\w.]+)\}\}/g, (match, name) => {
      return vars[name] !== undefined ? vars[name] : match;
    });
  }

  async shutdown(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log('[prompt-templates] watcher closed');
    }
  }
}
