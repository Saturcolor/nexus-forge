import { homedir } from 'os';
import { join } from 'path';
import { Config, CodeChunk, SearchResult, SearchOptions } from './types.js';
import { generateEmbedding } from './embeddings.js';
import * as lancedb from '@lancedb/lancedb';
import ora from 'ora';
import chalk from 'chalk';

export class CodebaseSearcher {
  private db: any;
  private table: any;
  private config: Config;
  private dbPath: string;
  
  constructor(config: Config, dbPath: string = join(homedir(), 'embed')) {
    this.config = config;
    this.dbPath = dbPath;
  }
  
  async initialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    this.table = await this.db.openTable('codebase');
  }
  
  async search(options: SearchOptions): Promise<SearchResult[]> {
    const { query, limit = 10, extensions, filePattern, type = 'vector', silent = false } = options;

    const spinner = silent ? null : ora('Recherche en cours...').start();

    try {
      let results: SearchResult[] = [];

      if (type === 'vector') {
        results = await this.vectorSearch(query, limit, extensions, filePattern);
      } else if (type === 'hybrid') {
        results = await this.hybridSearch({
          query,
          limit,
          extensions,
          filePattern,
          fileNameWeight: options.fileNameWeight ?? 0.2,
          candidatePool: options.candidatePool ?? this.config.candidatePool,
          rerankTopK: options.rerankTopK ?? this.config.rerankTopK,
          exactSymbol: options.exactSymbol ?? false
        });
      }

      if (spinner) spinner.succeed(`Recherche terminée: ${results.length} résultats`);
      return results;
    } catch (error) {
      if (spinner) spinner.fail(`Erreur de recherche: ${error}`);
      throw error;
    }
  }
  
  /**
   * Escape a string value for use in LanceDB SQL-like filter strings.
   * Prevents injection by escaping backslashes and double-quote characters.
   */
  private escapeSqlString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Escape SQL LIKE metacharacters (% and _) so a literal filePattern is matched as a
   * substring instead of being interpreted as wildcards (% = any sequence, _ = any single
   * char). Prepends a backslash; the LIKE clause must declare ESCAPE '\'. Apply AFTER
   * escapeSqlString (which already doubles literal backslashes) so the only single
   * backslashes introduced here are the intended wildcard escapes.
   */
  private escapeLikeWildcards(value: string): string {
    return value.replace(/[%_]/g, (ch) => `\\${ch}`);
  }

  /**
   * Validate that an extension value is safe for use in a filter clause.
   * Accepts optional leading dot followed by alphanumeric characters only.
   */
  private isValidExtension(ext: string): boolean {
    return /^\.?[a-zA-Z0-9]+$/.test(ext);
  }

  private async vectorSearch(
    query: string,
    limit: number,
    extensions?: string[],
    filePattern?: string
  ): Promise<SearchResult[]> {
    // Générer l'embedding de la requête
    const queryEmbedding = await generateEmbedding(query, this.config);

    // Construire le filtre
    const filters: string[] = [];
    if (extensions && extensions.length > 0) {
      const validExts = extensions.filter(e => this.isValidExtension(e));
      if (validExts.length > 0) {
        const extFilter = validExts.map(e => `extension = "${this.escapeSqlString(e)}"`).join(' OR ');
        filters.push(`(${extFilter})`);
      }
    }
    if (filePattern) {
      // Échapper d'abord les caractères de chaîne SQL (backslash, double-quote), PUIS les
      // métacaractères LIKE (% et _) avec un caractère d'échappement explicite. Sans ça, un
      // filePattern contenant '_' ou '%' (très courant : 'embed_runner', 'auto_warmup') agirait
      // comme un wildcard et sur-matcherait. ESCAPE '\' s'applique aux deux niveaux car
      // escapeSqlString a déjà doublé les '\' littéraux, donc '\%'/'\_' ne visent que les
      // wildcards intentionnellement échappés ici.
      const safePattern = this.escapeLikeWildcards(this.escapeSqlString(filePattern));
      filters.push(`filePath LIKE "%${safePattern}%" ESCAPE '\\'`);
    }
    
    const whereClause = filters.length > 0 ? filters.join(' AND ') : undefined;
    
    // Recherche vectorielle
    const searchQuery = this.table.search(queryEmbedding);
    
    if (whereClause) {
      searchQuery.where(whereClause);
    }
    
    const rawResults = await searchQuery.limit(limit).toArray();
    const results = Array.isArray(rawResults) ? rawResults : [];
    
    return results.map((record: any) => ({
      chunk: this.recordToChunk(record),
      score: record._distance || 0
    }));
  }

  private async hybridSearch(params: {
    query: string;
    limit: number;
    extensions?: string[];
    filePattern?: string;
    fileNameWeight: number;
    candidatePool: number;
    rerankTopK: number;
    exactSymbol: boolean;
  }): Promise<SearchResult[]> {
    const {
      query,
      limit,
      extensions,
      filePattern,
      fileNameWeight,
      candidatePool,
      rerankTopK,
      exactSymbol
    } = params;

    const baseCandidates = await this.vectorSearch(
      query,
      Math.max(limit, candidatePool),
      extensions,
      filePattern
    );

    const queryTerms = this.extractTerms(query);
    const scored = baseCandidates.map((result) => {
      const vectorSimilarity = 1 / (1 + result.score);
      const lexicalScore = this.computeLexicalScore(result.chunk, query, queryTerms);
      const structuralScore = this.computeStructuralScore(result.chunk, queryTerms, exactSymbol);
      const fileBoostScore = this.computeFileBoost(result.chunk, query, queryTerms) * fileNameWeight;

      const combinedSimilarity =
        vectorSimilarity * this.config.vectorWeight +
        lexicalScore * this.config.lexicalWeight +
        structuralScore * this.config.structuralWeight +
        fileBoostScore;

      if (this.config.debugScoring) {
        console.log(
          `[score] ${result.chunk.filePath}:${result.chunk.startLine} vec=${vectorSimilarity.toFixed(3)} lex=${lexicalScore.toFixed(3)} struct=${structuralScore.toFixed(3)} file=${fileBoostScore.toFixed(3)}`
        );
      }

      return {
        chunk: result.chunk,
        score: this.similarityToDistance(combinedSimilarity)
      };
    });

    scored.sort((a, b) => a.score - b.score);
    const reranked = this.rerankResults(scored, query, queryTerms, rerankTopK, exactSymbol);
    return reranked.slice(0, limit);
  }

  private rerankResults(
    results: SearchResult[],
    query: string,
    queryTerms: string[],
    rerankTopK: number,
    exactSymbol: boolean
  ): SearchResult[] {
    const k = Math.min(Math.max(rerankTopK, 1), results.length);
    const head = results.slice(0, k);
    const tail = results.slice(k);
    const queryLower = query.toLowerCase();

    const rerankedHead = head
      .map((result) => {
        const lexicalCoverage = this.computeCoverageScore(result.chunk, queryTerms);
        const proximity = this.computeTermProximityScore(result.chunk, queryTerms);
        const symbolExact = exactSymbol && result.chunk.name?.toLowerCase() === queryLower ? 1 : 0;
        const baseSimilarity = 1 / (1 + result.score);
        const finalSimilarity =
          baseSimilarity * 0.7 +
          lexicalCoverage * 0.18 +
          proximity * 0.1 +
          symbolExact * 0.02;
        return {
          chunk: result.chunk,
          score: this.similarityToDistance(finalSimilarity)
        };
      })
      .sort((a, b) => a.score - b.score);

    return [...rerankedHead, ...tail];
  }

  private extractTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
  }

  private computeLexicalScore(chunk: CodeChunk, query: string, queryTerms: string[]): number {
    const haystack = [
      chunk.name || '',
      chunk.type || '',
      chunk.fileName,
      chunk.filePath,
      chunk.content
    ]
      .join('\n')
      .toLowerCase();

    let score = 0;
    const queryLower = query.toLowerCase();
    if (haystack.includes(queryLower)) score += 0.35;
    const matchedTerms = queryTerms.filter((t) => haystack.includes(t)).length;
    if (queryTerms.length > 0) {
      score += 0.65 * (matchedTerms / queryTerms.length);
    }
    return Math.min(1, score);
  }

  private computeStructuralScore(chunk: CodeChunk, queryTerms: string[], exactSymbol: boolean): number {
    let score = 0;
    const typeLower = (chunk.type || '').toLowerCase();
    const nameLower = (chunk.name || '').toLowerCase();
    const hasFuncIntent = queryTerms.some((t) => ['function', 'method', 'func', 'handler'].includes(t));
    const hasClassIntent = queryTerms.some((t) => ['class', 'service', 'controller'].includes(t));
    const hasTypeIntent = queryTerms.some((t) => ['interface', 'type', 'schema'].includes(t));

    if (hasFuncIntent && (typeLower.includes('func') || typeLower.includes('method'))) score += 0.4;
    if (hasClassIntent && typeLower.includes('class')) score += 0.35;
    if (hasTypeIntent && (typeLower.includes('interface') || typeLower.includes('type'))) score += 0.35;

    if (nameLower && queryTerms.some((t) => nameLower.includes(t))) score += 0.2;
    if (exactSymbol && nameLower && queryTerms.some((t) => nameLower === t)) score += 0.25;
    return Math.min(1, score);
  }

  private computeFileBoost(chunk: CodeChunk, query: string, queryTerms: string[]): number {
    const fileNameLower = chunk.fileName.toLowerCase();
    const filePathLower = chunk.filePath.toLowerCase();
    const queryLower = query.toLowerCase();
    let score = 0;
    if (fileNameLower.includes(queryLower) || filePathLower.includes(queryLower)) score += 0.4;
    for (const term of queryTerms) {
      if (fileNameLower.includes(term)) score += 0.12;
      if (filePathLower.includes(term)) score += 0.06;
    }
    return Math.min(1, score);
  }

  private computeCoverageScore(chunk: CodeChunk, queryTerms: string[]): number {
    if (queryTerms.length === 0) return 0;
    const haystack = `${chunk.name || ''}\n${chunk.content}`.toLowerCase();
    const matched = queryTerms.filter((t) => haystack.includes(t)).length;
    return matched / queryTerms.length;
  }

  private computeTermProximityScore(chunk: CodeChunk, queryTerms: string[]): number {
    if (queryTerms.length <= 1) return 0;
    const text = `${chunk.name || ''}\n${chunk.content}`.toLowerCase();
    const positions = queryTerms
      .map((t) => text.indexOf(t))
      .filter((p) => p >= 0)
      .sort((a, b) => a - b);
    if (positions.length <= 1) return 0;
    const spread = positions[positions.length - 1] - positions[0];
    const normalized = 1 - Math.min(1, spread / 400);
    return normalized;
  }

  private similarityToDistance(similarity: number): number {
    const clamped = Math.max(0.0001, Math.min(0.9999, similarity));
    return (1 / clamped) - 1;
  }
  
  private recordToChunk(record: any): CodeChunk {
    return {
      id: record.id,
      filePath: record.filePath,
      fileName: record.fileName,
      extension: record.extension,
      content: record.content,
      startLine: record.startLine,
      endLine: record.endLine,
      type: record.type || undefined,
      name: record.name || undefined,
      fileMtimeMs: typeof record.fileMtimeMs === 'number' ? record.fileMtimeMs : undefined
    };
  }
  
  async getIndexedFilePaths(): Promise<Set<string>> {
    const allData = await this.table.query().select(['filePath']).toArray();
    return new Set((allData as { filePath: string }[]).map((r) => r.filePath));
  }

  async getStats(): Promise<{ totalChunks: number; extensions: Record<string, number> }> {
    const allData = await this.table.query().select(['extension']).toArray();
    const extensions: Record<string, number> = {};
    
    for (const record of allData) {
      extensions[record.extension] = (extensions[record.extension] || 0) + 1;
    }
    
    return {
      totalChunks: allData.length,
      extensions
    };
  }
  
  formatResults(results: SearchResult[], format: 'terminal' | 'json' | 'md'): string {
    switch (format) {
      case 'json':
        return JSON.stringify(results, null, 2);
      case 'md':
        return this.formatAsMarkdown(results);
      case 'terminal':
      default:
        return this.formatAsTerminal(results);
    }
  }
  
  private formatAsTerminal(results: SearchResult[]): string {
    if (results.length === 0) {
      return chalk.yellow('Aucun résultat trouvé.');
    }
    
    const lines: string[] = [];
    lines.push(chalk.blue(`\n🔍 ${results.length} résultats trouvés\n`));
    
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const chunk = result.chunk;
      const similarity = (1 / (1 + result.score) * 100).toFixed(1);
      
      lines.push(chalk.green(`${i + 1}. ${chunk.fileName} ${chalk.gray(`(${similarity}% pertinence)`)}`));
      lines.push(chalk.gray(`   ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`));
      
      if (chunk.name) {
        lines.push(chalk.cyan(`   ${chunk.type || 'symbol'}: ${chunk.name}`));
      }
      
      // Extraire un aperçu du contenu
      const preview = chunk.content
        .split('\n')
        .slice(0, 5)
        .map(line => line.slice(0, 80))
        .join('\n');
      
      lines.push(chalk.white(`   ${preview}`));
      
      if (chunk.content.split('\n').length > 5) {
        lines.push(chalk.gray('   ...'));
      }
      
      lines.push('');
    }
    
    return lines.join('\n');
  }
  
  private formatAsMarkdown(results: SearchResult[]): string {
    if (results.length === 0) {
      return 'Aucun résultat trouvé.';
    }
    
    const lines: string[] = [];
    lines.push(`# Résultats de recherche (${results.length})\n`);
    
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const chunk = result.chunk;
      const similarity = (1 / (1 + result.score) * 100).toFixed(1);
      
      lines.push(`## ${i + 1}. ${chunk.fileName}`);
      lines.push(`- **Fichier:** \`${chunk.filePath}:${chunk.startLine}-${chunk.endLine}\``);
      lines.push(`- **Pertinence:** ${similarity}%`);
      
      if (chunk.name) {
        lines.push(`- **${chunk.type || 'Symbol'}:** \`${chunk.name}\``);
      }
      
      lines.push('');
      lines.push('```' + chunk.extension.replace('.', ''));
      lines.push(chunk.content);
      lines.push('```');
      lines.push('');
    }
    
    return lines.join('\n');
  }
}
