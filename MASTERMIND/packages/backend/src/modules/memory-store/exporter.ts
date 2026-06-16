/**
 * Export de la mémoire vectorielle vers un fichier Markdown lisible.
 * Inverse logique de importer.ts : sérialise toutes les entrées (scope agent + shared)
 * groupées par scope puis par agent, métadonnées incluses, embeddings exclus.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryEntry } from './store.js';

export interface ExportResult {
  path: string;
  entryCount: number;
  bytes: number;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatEntry(entry: MemoryEntry): string {
  const lines: string[] = [];
  const flags: string[] = [];
  if (entry.archived) flags.push('[ARCHIVED]');
  if (entry.mergedInto) flags.push(`[MERGED → ${shortId(entry.mergedInto)}]`);
  const flagsPrefix = flags.length > 0 ? `${flags.join(' ')} ` : '';

  const title = `${flagsPrefix}${shortId(entry.id)} — ${entry.domain ?? 'no-domain'}`;
  lines.push(`### ${title}`);

  const meta: string[] = [];
  meta.push(entry.createdAt);
  if (entry.accessCount > 0) meta.push(`accessed ${entry.accessCount}×`);
  if (entry.score != null) meta.push(`score ${entry.score.toFixed(2)}`);
  if (entry.tags.length > 0) meta.push(`tags: ${entry.tags.join(', ')}`);
  meta.push(`source: ${entry.source}`);
  if (entry.mergeSourceIds.length > 0) meta.push(`merged from ${entry.mergeSourceIds.length}`);
  lines.push(`_${meta.join(' · ')}_`);

  lines.push('');
  lines.push(entry.text);
  lines.push('');
  lines.push('---');
  return lines.join('\n');
}

export function exportAsMarkdown(entries: MemoryEntry[], includeArchived: boolean): string {
  const header: string[] = [];
  header.push('# Mastermind — Memory Export');
  header.push(`_Exported: ${new Date().toISOString()} · ${entries.length} entries · includeArchived: ${includeArchived}_`);
  header.push('');

  const shared = entries.filter(e => e.scope === 'shared');
  const agentEntries = entries.filter(e => e.scope === 'agent');

  const sections: string[] = [];

  if (shared.length > 0) {
    sections.push(`## Shared (${shared.length})`);
    sections.push('');
    for (const e of shared) sections.push(formatEntry(e));
  }

  const byAgent = new Map<string, MemoryEntry[]>();
  for (const e of agentEntries) {
    const key = e.agentId ?? '(no-agent)';
    const list = byAgent.get(key) ?? [];
    list.push(e);
    byAgent.set(key, list);
  }
  const agentIds = Array.from(byAgent.keys()).sort();
  for (const agentId of agentIds) {
    const list = byAgent.get(agentId)!;
    sections.push('');
    sections.push(`## Agent: ${agentId} (${list.length})`);
    sections.push('');
    for (const e of list) sections.push(formatEntry(e));
  }

  return header.join('\n') + '\n' + sections.join('\n') + '\n';
}

export async function writeExportFile(markdown: string, sharedMemoryDir: string): Promise<ExportResult> {
  const exportDir = path.join(sharedMemoryDir, 'export');
  await fs.mkdir(exportDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const filename = `mastermind-memory-${stamp}.md`;
  const outPath = path.join(exportDir, filename);

  await fs.writeFile(outPath, markdown, 'utf8');
  const bytes = Buffer.byteLength(markdown, 'utf8');
  console.log(`[memory-store] export written path=${outPath} bytes=${bytes}`);
  return { path: outPath, entryCount: 0, bytes };
}
