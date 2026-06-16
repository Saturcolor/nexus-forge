import { homedir } from 'os';
import { Config, CodeChunk, IndexedChunk, IndexStats } from './types.js';
import { chunkFile, initTreeSitter } from './chunker.js';
import { generateEmbeddings } from './embeddings.js';
import { glob } from 'glob';
import { stat } from 'fs/promises';
import { join, resolve } from 'path';
import * as lancedb from '@lancedb/lancedb';
import ora from 'ora';
import chalk from 'chalk';

export class CodebaseIndexer {
  private db: any;
  private table: any;
  private config: Config;
  private stats: IndexStats;
  private dbPath: string;
  private readonly silent: boolean;

  constructor(
    config: Config,
    dbPath: string = join(homedir(), 'embed'),
    opts?: { silent?: boolean },
  ) {
    this.config = config;
    this.dbPath = dbPath;
    this.silent = opts?.silent ?? false;
    this.stats = {
      totalFiles: 0,
      totalChunks: 0,
      totalSize: 0,
      extensions: {},
      indexedAt: new Date().toISOString()
    };
  }
  
  async initialize(): Promise<void> {
    // Initialiser Tree-sitter si activé
    if (this.config.useTreeSitter) {
      const treeSitterAvailable = await initTreeSitter();
      if (!treeSitterAvailable) {
        console.warn(chalk.yellow('⚠️  Tree-sitter non disponible, utilisation du sliding window'));
        this.config.useTreeSitter = false;
      }
    }
    
    // Connecter à LanceDB
    const spinner = this.silent ? null : ora('Connexion à LanceDB...').start();
    try {
      this.db = await lancedb.connect(this.dbPath);
      if (spinner) spinner.succeed(`Connecté à LanceDB (${this.dbPath})`);
    } catch (error) {
      if (spinner) spinner.fail(`Erreur de connexion: ${error}`);
      throw error;
    }
  }
  
  async indexDirectory(
    rootPath: string,
    onProgress?: (phase: string, done: number, total: number) => void,
  ): Promise<IndexStats> {
    const resolvedPath = resolve(rootPath);
    if (!this.silent) console.log(chalk.blue(`\n📁 Indexation de: ${resolvedPath}\n`));

    // Trouver tous les fichiers
    const files = await this.findFiles(resolvedPath);
    if (!this.silent) console.log(chalk.green(`✓ ${files.length} fichiers trouvés`));

    if (files.length === 0) {
      if (!this.silent) console.log(chalk.yellow('⚠️  Aucun fichier à indexer'));
      return this.stats;
    }

    // Vider la table existante si elle existe
    await this.clearTable();

    // Réinitialiser les stats
    this.stats = {
      totalFiles: files.length,
      totalChunks: 0,
      totalSize: 0,
      extensions: {},
      indexedAt: new Date().toISOString()
    };

    // Traiter les fichiers par lots
    const batchSize = this.config.maxConcurrentFiles;
    const allChunks: CodeChunk[] = [];
    let filesProcessed = 0;

    onProgress?.('chunking', 0, files.length);

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(files.length / batchSize);

      const spinner = this.silent
        ? null
        : ora(`Traitement du lot ${batchNum}/${totalBatches} (${batch.length} fichiers)...`).start();

      const batchChunks = await Promise.all(
        batch.map(file => this.processFile(file))
      );

      const flatChunks = batchChunks.flat();
      allChunks.push(...flatChunks);
      filesProcessed += batch.length;

      this.stats.totalChunks += flatChunks.length;
      onProgress?.('chunking', filesProcessed, files.length);

      if (spinner) spinner.succeed(`Lot ${batchNum}/${totalBatches}: ${flatChunks.length} chunks créés`);
    }

    if (!this.silent) console.log(chalk.green(`\n✓ ${allChunks.length} chunks créés au total`));

    // Générer les embeddings par lots
    await this.indexChunks(allChunks, false, onProgress);

    return this.stats;
  }
  
  private async findFiles(rootPath: string): Promise<string[]> {
    // Construire les patterns d'exclusion
    const ignorePatterns = [
      ...this.config.excludeDirs.map(d => `**/${d}/**`),
      ...this.config.excludeFiles
    ];
    
    // Extensions à inclure
    const extensionsPattern = this.config.extensions.length === 1
      ? `**/*${this.config.extensions[0]}`
      : `**/*{${this.config.extensions.join(',')}}`;
    
    const files = await glob(extensionsPattern, {
      cwd: rootPath,
      absolute: true,
      ignore: ignorePatterns,
      nodir: true
    });
    
    return files;
  }
  
  private async processFile(filePath: string): Promise<CodeChunk[]> {
    try {
      const fileStat = await stat(filePath);
      this.stats.totalSize += fileStat.size;
      
      const extension = filePath.substring(filePath.lastIndexOf('.'));
      this.stats.extensions[extension] = (this.stats.extensions[extension] || 0) + 1;
      
      const fileMtimeMs = Math.floor(fileStat.mtimeMs);
      const chunks = await chunkFile(filePath, this.config);
      return chunks.map(chunk => ({ ...chunk, fileMtimeMs }));
    } catch (error) {
      if (!this.silent) console.warn(chalk.yellow(`⚠️  Erreur lors du traitement de ${filePath}:`), error);
      return [];
    }
  }
  
  private async indexChunks(
    chunks: CodeChunk[],
    append = false,
    onProgress?: (phase: string, done: number, total: number) => void,
  ): Promise<void> {
    if (chunks.length === 0) return;

    const spinner = this.silent ? null : ora('Génération des embeddings...').start();
    // First write to DB in this call: use overwrite (createTable) if !append, addToTable otherwise.
    // After the first successful batch write we always append subsequent batches — this gives us
    // incremental saves: if the process crashes at batch N, batches 0..N-1 are already persisted.
    let firstWrite = true;

    try {
      const batchSize = 100;

      onProgress?.('embedding', 0, chunks.length);

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const texts = batch.map(c => this.prepareTextForEmbedding(c));

        const embeddings = await generateEmbeddings(texts, this.config);

        const indexedBatch: IndexedChunk[] = batch.map((chunk, j) => ({
          ...chunk,
          vector: embeddings[j]!,
          indexedAt: new Date().toISOString(),
        }));

        // Persist immediately after each batch — crash-safe incremental writes
        if (!append && firstWrite) {
          await this.saveToLanceDB(indexedBatch); // createTable / overwrite
        } else {
          try {
            await this.addToTable(indexedBatch);
          } catch (addError) {
            // The overwrite-create fallback is ONLY safe when the table genuinely
            // doesn't exist yet (e.g. very first append into a fresh DB). If the
            // table already exists, saveToLanceDB() would replace the whole index
            // with just this one batch — silently destroying every batch already
            // written (full reindex) or the entire pre-existing index (incremental
            // append). So only fall back to create-overwrite when the table is
            // genuinely absent; otherwise re-throw so prior batches stay persisted
            // and the error surfaces loudly instead of as silent data loss.
            if (await this.tableExists()) {
              throw addError;
            }
            await this.saveToLanceDB(indexedBatch); // fallback: table did not exist yet
          }
        }
        firstWrite = false;

        const done = Math.min(i + batchSize, chunks.length);
        onProgress?.('embedding', done, chunks.length);

        if (spinner) {
          spinner.text = `Génération des embeddings... ${done}/${chunks.length}`;
        }
      }

      if (spinner) spinner.succeed(`${chunks.length} chunks ${append ? 'ajoutés à' : 'indexés dans'} l'index`);
    } catch (error) {
      if (spinner) spinner.fail(`Erreur lors de l'indexation: ${error}`);
      throw error;
    }
  }

  /** Met à jour l'index de façon incrémentale : supprime les fichiers retirés/modifiés, indexe et ajoute les nouveaux/modifiés. */
  async updateIncremental(
    newFilePaths: string[],
    removedFilePaths: string[],
    modifiedFilePaths: string[] = [],
    onProgress?: (phase: string, done: number, total: number) => void,
  ): Promise<{ addedChunks: number; removedFiles: number; modifiedFiles: number }> {
    const pathsToDelete = [...removedFilePaths, ...modifiedFilePaths];
    if (pathsToDelete.length > 0) {
      await this.deleteChunksByFilePaths(pathsToDelete);
    }
    let addedChunks = 0;
    const pathsToIndex = [...newFilePaths, ...modifiedFilePaths];
    if (pathsToIndex.length > 0) {
      const allChunks: CodeChunk[] = [];
      onProgress?.('chunking', 0, pathsToIndex.length);
      for (let i = 0; i < pathsToIndex.length; i++) {
        const chunks = await this.processFile(pathsToIndex[i]!);
        allChunks.push(...chunks);
        onProgress?.('chunking', i + 1, pathsToIndex.length);
      }
      if (allChunks.length > 0) {
        await this.indexChunks(allChunks, true, onProgress);
        addedChunks = allChunks.length;
      }
    }
    return { addedChunks, removedFiles: removedFilePaths.length, modifiedFiles: modifiedFilePaths.length };
  }

  /** Discovers all indexable files in a source directory (public wrapper). */
  async discoverFiles(sourcePath: string): Promise<string[]> {
    return this.findFiles(resolve(sourcePath));
  }

  /** Returns all distinct file paths currently stored in the LanceDB index. */
  async getIndexedFilePaths(): Promise<string[]> {
    try {
      const table = await this.getTable();
      const rows = await table.query().select(['filePath']).toArray();
      const paths = new Set<string>();
      for (const r of rows) {
        if (r.filePath) paths.add(String(r.filePath));
      }
      return Array.from(paths);
    } catch {
      return [];
    }
  }

  /** Returns indexed files with their stored mtime, backfilling legacy rows when possible. */
  async getIndexedFileMetadata(): Promise<Map<string, number>> {
    try {
      const table = await this.getTable();
      const rows = await table.query().select(['filePath', 'fileMtimeMs']).toArray()
        .catch(() => table.query().select(['filePath']).toArray());
      const mtimes = new Map<string, number>();
      const missing = new Map<string, number>();

      for (const r of rows as Array<{ filePath?: string; fileMtimeMs?: number | null }>) {
        if (!r.filePath) continue;
        const stored = Number(r.fileMtimeMs ?? 0);
        if (stored > 0) {
          mtimes.set(r.filePath, stored);
          continue;
        }
        // Legacy indexes have no mtime column. Use the current filesystem mtime and try to
        // persist it so the first post-deploy update avoids a full re-embed.
        const current = await this.getFileMtimeMs(r.filePath);
        if (current > 0) {
          mtimes.set(r.filePath, current);
          missing.set(r.filePath, current);
        } else {
          mtimes.set(r.filePath, 0);
        }
      }

      if (missing.size > 0) {
        await this.backfillFileMtimes(missing);
      }

      return mtimes;
    } catch {
      return new Map();
    }
  }

  async getFileMtimeForPath(filePath: string): Promise<number> {
    return this.getFileMtimeMs(filePath);
  }

  private async getFileMtimeMs(filePath: string): Promise<number> {
    try {
      return Math.floor((await stat(filePath)).mtimeMs);
    } catch {
      return 0;
    }
  }
  
  private prepareTextForEmbedding(chunk: CodeChunk): string {
    const meta: string[] = [];
    if (chunk.type) meta.push(`type=${chunk.type}`);
    if (chunk.name) meta.push(`symbol=${chunk.name}`);
    meta.push(`file=${chunk.fileName}`);
    meta.push(`path=${chunk.filePath}`);
    const header = `[meta] ${meta.join(' | ')}`;
    return `${header}\n${chunk.content}`;
  }
  
  private chunksToRecords(chunks: IndexedChunk[]): Record<string, unknown>[] {
    return chunks.map(chunk => ({
      id: chunk.id,
      filePath: chunk.filePath,
      fileName: chunk.fileName,
      extension: chunk.extension,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      type: chunk.type || '',
      name: chunk.name || '',
      indexedAt: chunk.indexedAt,
      fileMtimeMs: Math.floor(chunk.fileMtimeMs ?? 0),
      vector: chunk.vector
    }));
  }

  private async ensureTable(): Promise<void> {
    if (!this.table) {
      this.table = await this.db.openTable('codebase');
    }
  }

  /** True if the 'codebase' table is already created (open handle or present on disk). */
  private async tableExists(): Promise<boolean> {
    if (this.table) return true;
    try {
      const names: string[] = await this.db.tableNames();
      return names.includes('codebase');
    } catch {
      // If we can't even list tables, assume absent so the caller may create it.
      return false;
    }
  }

  private async addToTable(chunks: IndexedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.ensureTable();
    const records = this.chunksToRecords(chunks);
    await this.table.add(records);
  }

  private async deleteChunksByFilePaths(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    await this.ensureTable();
    const escaped = filePaths.map(p => `'${String(p).replace(/'/g, "''")}'`);
    const predicate = `filePath IN (${escaped.join(', ')})`;
    await this.table.delete(predicate);
  }

  private async backfillFileMtimes(fileMtimes: Map<string, number>): Promise<void> {
    if (fileMtimes.size === 0) return;
    await this.ensureTable();
    for (const [filePath, fileMtimeMs] of fileMtimes) {
      try {
        const predicate = `filePath = '${String(filePath).replace(/'/g, "''")}'`;
        await this.table.update({ where: predicate, values: { fileMtimeMs } });
      } catch {
        // Best-effort only: new or modified rows written by this version will carry mtime.
      }
    }
  }

  private async saveToLanceDB(chunks: IndexedChunk[]): Promise<void> {
    const records = this.chunksToRecords(chunks);
    try {
      this.table = await this.db.createTable('codebase', records, {
        mode: 'overwrite'
      });
    } catch {
      await this.db.dropTable('codebase');
      this.table = await this.db.createTable('codebase', records);
    }
    try {
      await this.table.createIndex('vector', {
        type: 'ivf_pq',
        metric: 'cosine'
      });
    } catch (e) {
      // L'index peut déjà exister
    }
  }
  
  private async clearTable(): Promise<void> {
    try {
      await this.db.dropTable('codebase');
    } catch {
      // La table n'existe peut-être pas encore
    }
  }
  
  async getTable(): Promise<any> {
    if (!this.table) {
      this.table = await this.db.openTable('codebase');
    }
    return this.table;
  }
  
  printStats(): void {
    console.log(chalk.blue('\n📊 Statistiques d\'indexation:'));
    console.log(`  Fichiers: ${this.stats.totalFiles}`);
    console.log(`  Chunks: ${this.stats.totalChunks}`);
    console.log(`  Taille totale: ${(this.stats.totalSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Extensions: ${Object.entries(this.stats.extensions)
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `${ext}(${count})`)
      .join(', ')}`);
    console.log(`  Indexé le: ${this.stats.indexedAt}`);
  }
}
