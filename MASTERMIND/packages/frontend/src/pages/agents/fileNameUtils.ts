const INVALID_WIN = /[<>:"|?*\x00-\x1f]/;

/** Basename uniquement, extension .md (ajoutée si absente). */
export function normalizeMdBasename(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const t = raw.trim();
  if (!t) return { ok: false, message: 'Nom requis.' };
  if (t.includes('/') || t.includes('\\') || t.includes('..')) {
    return { ok: false, message: 'Pas de chemin : uniquement le nom du fichier.' };
  }
  if (INVALID_WIN.test(t)) {
    return { ok: false, message: 'Caractères interdits dans le nom de fichier.' };
  }
  const name = /\.md$/i.test(t) ? t : `${t}.md`;
  if (INVALID_WIN.test(name)) return { ok: false, message: 'Caractères interdits dans le nom de fichier.' };
  return { ok: true, name };
}
