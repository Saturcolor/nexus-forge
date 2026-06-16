/**
 * Importe des fichiers .md existants dans le MemoryStore.
 * Découpe en chunks par sections markdown, filtre les insignifiants, dé-duplique.
 */
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import type { MemoryStore, MemoryScope } from './store.js';
import { isSignificant } from './significanceFilter.js';

export interface ImportOptions {
  agentId?: string | null;
  scope?: MemoryScope;
  domain?: string;
  source?: string;
  /** Taille max d'un chunk (chars). Défaut : 800 */
  maxChunkSize?: number;
  /** Si true, simule l'import sans écrire en base */
  dryRun?: boolean;
}

export interface ImportResult {
  imported: number;
  skippedInsignificant: number;
  skippedDuplicate: number;
  total: number;
}

/** Ensemble des hashes de texte déjà connus (pour dé-duplication en mémoire). */
const MAX_IMPORTED_HASHES = 10_000;
const importedHashes = new Set<string>();

function textHash(text: string): string {
  return crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

function rememberImportedHash(hash: string): void {
  importedHashes.add(hash);
  while (importedHashes.size > MAX_IMPORTED_HASHES) {
    const oldest = importedHashes.values().next().value as string | undefined;
    if (!oldest) break;
    importedHashes.delete(oldest);
  }
}

/**
 * Découpe un contenu markdown en chunks sémantiques.
 * Coupe d'abord sur les headers (##, ###), puis sur les paragraphes si trop long.
 */
function chunkMarkdown(content: string, maxChunkSize: number): string[] {
  // Sépare sur les headers markdown (## ou ###)
  const sections = content.split(/\n(?=#{1,3}\s)/);
  const chunks: string[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    if (trimmed.length <= maxChunkSize) {
      chunks.push(trimmed);
    } else {
      // Découpe par paragraphes (double newline)
      const paragraphs = trimmed.split(/\n{2,}/);
      let current = '';
      for (const para of paragraphs) {
        if (!para.trim()) continue;
        if ((current + '\n\n' + para).length > maxChunkSize && current) {
          chunks.push(current.trim());
          current = para;
        } else {
          current = current ? current + '\n\n' + para : para;
        }
      }
      if (current.trim()) chunks.push(current.trim());
    }
  }

  return chunks.filter(c => c.length > 0);
}

/**
 * Importe un fichier .md dans le MemoryStore.
 * @returns Statistiques d'import
 */
export async function importMarkdownFile(
  filePath: string,
  store: MemoryStore,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const {
    agentId = null,
    scope = 'shared',
    domain,
    source,
    maxChunkSize = 800,
    dryRun = false,
  } = opts;

  const content = await fs.readFile(filePath, 'utf-8');
  const chunks = chunkMarkdown(content, maxChunkSize);
  const result: ImportResult = { imported: 0, skippedInsignificant: 0, skippedDuplicate: 0, total: chunks.length };
  const localHashes = new Set<string>();
  console.log(
    `[memory-store] import file=${filePath.split(/[/\\]/).pop()} chunks=${chunks.length} dryRun=${dryRun} scope=${scope} agent=${agentId ?? '∅'}`,
  );

  for (const chunk of chunks) {
    // Filtre de pertinence
    const sig = isSignificant(chunk);
    if (!sig.significant) {
      result.skippedInsignificant++;
      continue;
    }

    // Dé-duplication par hash
    const hash = textHash(chunk);
    if (localHashes.has(hash) || importedHashes.has(hash)) {
      result.skippedDuplicate++;
      continue;
    }
    localHashes.add(hash);

    if (dryRun) {
      result.imported++;
      continue;
    }

    rememberImportedHash(hash);

    await store.add({
      text: chunk,
      agentId,
      scope,
      domain,
      source: source ?? `import:${filePath.split('/').pop() ?? filePath}`,
    });
    result.imported++;
  }

  console.log(
    `[memory-store] import done imported=${result.imported} skipInsig=${result.skippedInsignificant} skipDup=${result.skippedDuplicate} totalChunks=${result.total}`,
  );
  return result;
}

/**
 * Importe tous les fichiers .md d'un répertoire (récursivement).
 */
export async function importDirectory(
  dirPath: string,
  store: MemoryStore,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const total: ImportResult = { imported: 0, skippedInsignificant: 0, skippedDuplicate: 0, total: 0 };
  console.log(`[memory-store] importDirectory root=${dirPath}`);

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const r = await importMarkdownFile(fullPath, store, opts);
        total.imported += r.imported;
        total.skippedInsignificant += r.skippedInsignificant;
        total.skippedDuplicate += r.skippedDuplicate;
        total.total += r.total;
      }
    }
  }

  await walk(dirPath);
  console.log(
    `[memory-store] importDirectory done imported=${total.imported} skipInsig=${total.skippedInsignificant} skipDup=${total.skippedDuplicate} chunks=${total.total}`,
  );
  return total;
}
