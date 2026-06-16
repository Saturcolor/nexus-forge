/**
 * Nom de fichier pour export Markdown d'un run sub-agent (shared memory, etc.).
 */

function fallbackSlug(fallbackJobId: string): string {
  const short = fallbackJobId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
  return short ? `run-${short}` : 'run-export';
}

function slugifyReportTitle(title: string): string {
  return title
    .replace(/[/\\?%*:|"<>#\u0000-\u001f]/g, '')
    .replace(/[.]{2,}/g, '.')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
}

/** Première ligne utile : préférence aux titres `# …` ; sinon première ligne non vide. */
export function suggestSubagentReportBasename(markdown: string, fallbackJobId: string): string {
  if (!markdown.trim()) return fallbackSlug(fallbackJobId);

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const hm = line.match(/^#{1,6}\s+(.+)$/);
    let title = (hm ? hm[1] : line).trim();
    title = title.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').trim();
    title = title.replace(/\s+/g, ' ').trim();
    if (!title) continue;

    let slug = slugifyReportTitle(title);
    if (slug.length >= 3) return slug;

    const stripped = title.replace(/[^\p{L}\p{N}\s\-–—:.,()']/gu, '').trim();
    slug = slugifyReportTitle(stripped);
    if (slug.length >= 3) return slug;
  }

  return fallbackSlug(fallbackJobId);
}

/**
 * Un seul segment de nom (sans chemin), sans extension .md ; sert côté serveur après saisie UI.
 */
export function sanitizeReportFilenameBase(input: string, fallbackJobId: string): string {
  let s = input.trim();
  const parts = s.split(/[/\\]/);
  s = (parts[parts.length - 1] ?? s).trim();
  s = s.replace(/\.(md|markdown)$/i, '');
  s = s.replace(/\.\./g, '_');
  s = s.replace(/[/\\?%*:|"<>#\u0000-\u001f]/g, '-');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  s = s.slice(0, 120);
  if (s.length < 1) return fallbackSlug(fallbackJobId);
  return s;
}
