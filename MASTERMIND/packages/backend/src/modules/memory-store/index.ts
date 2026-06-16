import type { Module, MastermindContext } from '@mastermind/shared';
import { MemoryStore } from './store.js';
import { buildEmbedConfig, findMercuryEmbeddingProvider, getMercuryEmbeddingChainUrl } from './embedder.js';
import type { SearchOptions, MemoryEntryInput, ListFilters, MemoryEntry, MemoryHit, MemoryStats } from './store.js';
import type { ImportOptions, ImportResult } from './importer.js';
import type { ExportResult } from './exporter.js';

/** Vérifie que tous les modèles de la chaine embedding Mercury produisent la dim attendue par la DB.
 *  Empêche la corruption silencieuse si on mélange Qwen3-8B (4096) et BGE-M3 (1024) dans la chaine.
 *  Si la chaine est vide ou Mercury injoignable au boot, log un warning sans bloquer.
 *  Si au moins une entrée a un `dim` divergent, throw — refus de boot explicite.
 */
async function assertEmbeddingChainHomogeneity(ctx: MastermindContext, expectedDim: number): Promise<void> {
  const mercury = findMercuryEmbeddingProvider(ctx.config.providers);
  if (!mercury) return;  // mode legacy flat, pas de chaine à valider
  const url = getMercuryEmbeddingChainUrl(mercury);
  let chain: Array<{ id: string; dim?: number | null }>;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) {
      console.warn(`[memory-store] Impossible de récupérer la chaine Mercury (${r.status}) — validation dim sautée`);
      return;
    }
    const body = await r.json() as { data?: Array<{ id: string; dim?: number | null }> };
    chain = body.data ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[memory-store] Mercury injoignable au boot (${msg}) — validation dim sautée`);
    return;
  }

  if (chain.length === 0) {
    console.warn('[memory-store] Mercury chaine embedding vide — configure local_embedding_models et/ou openrouter_embedding_model');
    return;
  }

  const mismatches = chain.filter(e => typeof e.dim === 'number' && e.dim !== expectedDim);
  if (mismatches.length > 0) {
    const detail = chain.map(e => `${e.id}=${e.dim ?? '?'}`).join(', ');
    throw new Error(
      `[memory-store] Mercury embedding chain dim mismatch: DB attend ${expectedDim}, ` +
      `chaine: ${detail}. Corrige les dims dans Mercury (panneau Models > Chaine embedding) ` +
      `ou re-indexe la DB avant d'activer ces modèles.`
    );
  }

  const unknownDims = chain.filter(e => typeof e.dim !== 'number');
  if (unknownDims.length > 0) {
    console.warn(
      `[memory-store] ${unknownDims.length} entrée(s) de chaine sans dim déclarée: ${unknownDims.map(e => e.id).join(', ')}. ` +
      `Renseigne 'dim' dans Mercury pour activer la validation.`
    );
  }
}

async function getExistingEmbeddingColumnDimension(ctx: MastermindContext): Promise<number | null> {
  const result = await ctx.db.query<{ type: string }>(`
    SELECT format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'agent_memories'
      AND n.nspname = current_schema()
      AND a.attname = 'embedding'
      AND NOT a.attisdropped
    LIMIT 1
  `);
  const typeName = result.rows[0]?.type;
  if (!typeName) return null;

  // pgvector exposes the declared dimension through format_type(), e.g. "vector(4096)".
  // If the table does not exist yet there is no row, so schema creation below owns the dim.
  const match = typeName.match(/^vector\((\d+)\)$/i);
  return match ? Number(match[1]) : null;
}

export type { MemoryEntry, MemoryHit, MemoryStats, SearchOptions, MemoryEntryInput, MemoryScope } from './store.js';
export type { ImportOptions, ImportResult } from './importer.js';
export type { ExportResult } from './exporter.js';
export { isSignificant } from './significanceFilter.js';

export class MemoryStoreModule implements Module {
  name = 'memory-store';
  store?: MemoryStore;
  private _ctx?: MastermindContext;
  private disabledReason?: string;

  async init(ctx: MastermindContext): Promise<void> {
    this._ctx = ctx;
    const cfg = ctx.config.memoryStore;
    if (!cfg?.enabled) {
      console.log('[memory-store] Désactivé (memoryStore.enabled: false)');
      return;
    }
    console.debug('[memory-store] init: memoryStore.enabled=true → schéma + embedder');
    await this._doInit(ctx);
  }

  async reinit(): Promise<void> {
    if (!this._ctx) return;
    if (this.store) {
      console.debug('[memory-store] reinit: déjà initialisé, skip');
      return;
    }
    console.log('[memory-store] reinit: initialisation à chaud');
    await this._doInit(this._ctx);
  }

  private async _doInit(ctx: MastermindContext): Promise<void> {
    const cfg = ctx.config.memoryStore!;
    const embedCfg = buildEmbedConfig(ctx.config);
    const dimensions = cfg.embeddingDimensions ?? 4096;
    await assertEmbeddingChainHomogeneity(ctx, dimensions);

    const existingDim = await getExistingEmbeddingColumnDimension(ctx);
    if (existingDim != null && existingDim !== dimensions) {
      this.store = undefined;
      this.disabledReason = `DB vector dim=${existingDim}, config dim=${dimensions}`;
      console.error(
        `[memory-store] FATAL: dimension mismatch (${this.disabledReason}). ` +
        `Module désactivé sans crash daemon; corrige la config ou ré-indexe la table agent_memories.`,
      );
      return;
    }

    this.store = new MemoryStore(ctx.db, embedCfg);
    this.disabledReason = undefined;
    console.debug(`[memory-store] ensureSchema embeddingDimensions=${dimensions} url=${embedCfg.baseUrl}`);
    await this.store.ensureSchema(dimensions);
    console.log(`[memory-store] Initialisé (pgvector + embeddings via Mercury broker)`);
  }

  get isEnabled(): boolean {
    return !!this.store;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<MemoryHit[]> {
    if (!this.store) throw new Error(`memory-store disabled${this.disabledReason ? `: ${this.disabledReason}` : ''}`);
    return this.store.search(query, opts);
  }

  async add(input: MemoryEntryInput): Promise<string> {
    if (!this.store) throw new Error(`memory-store disabled${this.disabledReason ? `: ${this.disabledReason}` : ''}`);
    return this.store.add(input);
  }

  async update(id: string, patch: { text?: string; tags?: string[]; domain?: string }): Promise<void> {
    if (!this.store) throw new Error(`memory-store disabled${this.disabledReason ? `: ${this.disabledReason}` : ''}`);
    return this.store.update(id, patch);
  }

  async delete(id: string): Promise<void> {
    if (!this.store) throw new Error(`memory-store disabled${this.disabledReason ? `: ${this.disabledReason}` : ''}`);
    return this.store.delete(id);
  }

  async list(filters: ListFilters = {}, page = 1, limit = 20): Promise<{ entries: MemoryEntry[]; total: number }> {
    if (!this.store) throw new Error(`memory-store disabled${this.disabledReason ? `: ${this.disabledReason}` : ''}`);
    return this.store.list(filters, page, limit);
  }

  async stats(): Promise<MemoryStats> {
    if (!this.store) throw new Error(`memory-store disabled${this.disabledReason ? `: ${this.disabledReason}` : ''}`);
    return this.store.stats();
  }

  async reembedMissing(onProgress?: (done: number, total: number) => void): Promise<number> {
    if (!this.store) throw new Error(`memory-store disabled${this.disabledReason ? `: ${this.disabledReason}` : ''}`);
    return this.store.reembedMissing(onProgress);
  }

  async importMarkdown(filePath: string, opts: ImportOptions = {}): Promise<ImportResult> {
    if (!this.store) throw new Error(`memory-store disabled${this.disabledReason ? `: ${this.disabledReason}` : ''}`);
    const { importMarkdownFile } = await import('./importer.js');
    return importMarkdownFile(filePath, this.store, opts);
  }

  async importDirectory(dirPath: string, opts: ImportOptions = {}): Promise<ImportResult> {
    if (!this.store) throw new Error(`memory-store disabled${this.disabledReason ? `: ${this.disabledReason}` : ''}`);
    const { importDirectory } = await import('./importer.js');
    return importDirectory(dirPath, this.store, opts);
  }

  async exportMarkdown(sharedMemoryDir: string, opts: { includeArchived?: boolean } = {}): Promise<ExportResult> {
    if (!this.store) throw new Error(`memory-store disabled${this.disabledReason ? `: ${this.disabledReason}` : ''}`);
    const includeArchived = opts.includeArchived === true;
    const entries = await this.store.listAll({ includeArchived });
    const { exportAsMarkdown, writeExportFile } = await import('./exporter.js');
    const markdown = exportAsMarkdown(entries, includeArchived);
    const result = await writeExportFile(markdown, sharedMemoryDir);
    return { ...result, entryCount: entries.length };
  }
}
