import fs from 'node:fs/promises';
import path from 'node:path';
import type { MemoryStoreModule } from '../../memory-store/index.js';
import { isSignificant } from '../../memory-store/significanceFilter.js';

export interface MemoryWriteOptions {
  /**
   * Si fourni, écrit dans PostgreSQL (MemoryStore) au lieu de MEMORY.md.
   * Requis quand memoryStore est activé.
   */
  memoryStore?: MemoryStoreModule;
  agentId?: string;
  /**
   * Section optionnelle pour organiser MEMORY.md (mode legacy uniquement).
   * Ex : "## TODOs", "## Décisions", "## Notes techniques"
   */
  section?: string;
  /**
   * Déduplication opt-in : vérifier la similarité avant d'insérer.
   * Passé depuis config.memoryStore.enableDeduplication.
   */
  enableDeduplication?: boolean;
  /** Seuil de similarité pour la dédup (0-1, défaut 0.92) */
  deduplicationThreshold?: number;
  /** Bypass le filtre de significance (garde uniquement les skip patterns trivaux) */
  bypassSignificanceFilter?: boolean;
  /**
   * Scope de la mémoire : "agent" (privée, défaut) ou "shared" (partagée entre tous les agents).
   */
  scope?: 'agent' | 'shared';
}

/**
 * Écrit une entrée mémoire.
 *
 * Comportement :
 * - Si memoryStore est disponible et activé → écriture dans PostgreSQL + filtre de pertinence
 * - Sinon → fallback vers MEMORY.md (comportement legacy, backward-compatible)
 */
export async function memoryWrite(
  content: string,
  mode: 'append' | 'overwrite',
  workspacePath: string,
  opts: MemoryWriteOptions = {},
): Promise<string> {
  const { memoryStore, agentId, section, scope = 'agent' } = opts;

  // ── Mode vectoriel (PostgreSQL) ──────────────────────────────────────────
  if (memoryStore?.isEnabled && agentId) {
    console.debug(
      `[memory-store] memory_write vector mode=${mode} len=${content.length} agent=${agentId} dedup=${!!opts.enableDeduplication} bypass=${!!opts.bypassSignificanceFilter}`,
    );
    const domain = domainFromSection(section);

    // Mode overwrite : sémantique "remplacer". Avant d'insérer, on supprime les mémoires
    // existantes de même (agentId, scope, domain) — sinon `memoryStore.add` ci-dessous se
    // contentait d'INSÉRER une nouvelle ligne, laissant l'ancienne en place (accumulation de
    // faits contradictoires). Le filtre significance/dédup est volontairement court-circuité
    // ici : un overwrite explicite est une mise à jour voulue, pas un append opportuniste.
    if (mode === 'overwrite') {
      try {
        const filters: { agentId?: string; scope: 'agent' | 'shared'; domain?: string } = {
          scope,
          ...(scope === 'agent' ? { agentId } : {}),
          ...(domain ? { domain } : {}),
        };
        // domain non renseigné = on ne purge QUE les entrées sans domaine (évite d'effacer
        // d'autres sections de la même mémoire agent/shared).
        //
        // On supprime exactement ce qu'on lit : on reboucle donc TOUJOURS sur la première page
        // (page=1). Chaque `delete` retire physiquement la ligne, donc à l'itération suivante les
        // survivants remontent en tête et sont relus depuis l'offset 0 — jamais de saut d'offset
        // (le bug M9 incrémentait `page`, ce qui, après suppression des lignes lues, faisait sauter
        // 100 survivants par itération → sous-purge silencieuse au-delà de 200 entrées).
        let purged = 0;
        for (;;) {
          const { entries } = await memoryStore.list(filters, 1, 100);
          const toDelete = domain ? entries : entries.filter(e => e.domain == null);
          // Plus rien à purger sur la première page → terminé.
          if (toDelete.length === 0) {
            // Garde-fou anti-boucle-infinie : si la page contient des entrées mais aucune cible,
            // c'est qu'il ne reste que des entrées hors-scope (cas domain=∅ avec des entrées
            // ayant un domaine). On a fini de purger nos cibles — on coupe proprement.
            if (entries.length > 0) {
              console.debug(`[memory-store] memory_write overwrite purge: ${entries.length} entrée(s) restantes hors cible (domaine présent), arrêt`);
            }
            break;
          }
          for (const e of toDelete) {
            await memoryStore.delete(e.id);
            purged++;
          }
        }
        console.log(`[memory-store] memory_write overwrite purged=${purged} agent=${agentId} scope=${scope} domain=${domain ?? '∅'}`);
      } catch (err) {
        // Non-fatal : on continue vers l'insert (au pire on retombe sur l'ancien comportement
        // d'accumulation pour cette écriture, mais on ne casse pas l'outil).
        console.warn(`[memory-store] memory_write overwrite purge failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (mode === 'append') {
      if (opts.bypassSignificanceFilter) {
        const trimmed = content.trim();
        if (trimmed.length < 10) {
          return `memory_write: contenu ignoré (trop court — ${trimmed.length} chars)`;
        }
        const SKIP_PATTERNS = [
          /^(hello|hi|hey|bonjour|salut|bonsoir|coucou)\s*[.!?]?\s*$/i,
          /^(thanks|thank you|merci|parfait|super|ok|okay|oui|non|yes|no|sure|d'accord|vu)\s*[.!?]?\s*$/i,
          /^(done|fait|terminé|finished|completed|task completed|operation successful)\s*[.!?]?\s*$/i,
          /^(noted|noté|je note|compris|understood|got it)\s*[.!?]?\s*$/i,
        ];
        if (SKIP_PATTERNS.some(p => p.test(trimmed))) {
          console.debug(`[memory-store] memory_write skipped trivial (bypass mode)`);
          return `memory_write: contenu ignoré (trivial)`;
        }
      } else {
        const { significant, reason } = isSignificant(content, 'append');
        if (!significant) {
          console.debug(`[memory-store] memory_write skipped insignificant: ${reason}`);
          return `memory_write: contenu ignoré (non significatif — ${reason})`;
        }
      }

      // Déduplication opt-in : vérifier la similarité avant d'insérer
      if (opts.enableDeduplication) {
        const threshold = opts.deduplicationThreshold ?? 0.92;
        const dedupScopes = scope === 'shared' ? ['shared' as const] : ['agent' as const];
        try {
          const similar = await memoryStore.search(content, {
            agentId,
            scopes: dedupScopes,
            topK: 1,
            threshold,
          });
          if (similar.length > 0) {
            console.log(
              `[memory-store] memory_write dedup skip sim=${Math.round((similar[0]?.similarity ?? 0) * 100)}% (threshold=${threshold})`,
            );
            return `memory_write: doublon ignoré (similarité ${Math.round((similar[0]?.similarity ?? 0) * 100)}% avec une entrée existante)`;
          }
        } catch {
          // Non-fatal — on continue vers l'insert
        }
      }
    }

    const id = await memoryStore.add({
      text: content,
      agentId,
      scope,
      domain,
      source: 'manual',
    });

    console.log(`[memory-store] memory_write ok id=${id.slice(0, 8)}… scope=${scope}`);
    return `Mémoire enregistrée (id: ${id.slice(0, 8)}…, scope: ${scope})`;
  }

  // ── Mode legacy (MEMORY.md) ──────────────────────────────────────────────
  if (mode === 'append') {
    const { significant, reason } = isSignificant(content, 'append');
    if (!significant) {
      console.log(`[memory] Skipped non-significant content (${reason}): "${content.slice(0, 60)}"`);
      return `memory_write: contenu ignoré (non significatif — ${reason})`;
    }
  }

  const memPath = path.join(workspacePath, 'MEMORY.md');

  if (mode === 'overwrite') {
    await fs.writeFile(memPath, content, 'utf-8');
    return `MEMORY.md réécrit (${content.length} chars)`;
  }

  // Append — avec support optionnel de sections
  let existing = '';
  try {
    existing = await fs.readFile(memPath, 'utf-8');
  } catch {
    // fichier inexistant, ok
  }

  if (section) {
    const updated = appendToSection(existing, section, content);
    await fs.writeFile(memPath, updated, 'utf-8');
    return `Ajouté dans la section "${section}" de MEMORY.md`;
  }

  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  await fs.writeFile(memPath, existing + separator + content, 'utf-8');
  return `Ajouté ${content.length} chars à MEMORY.md`;
}

/**
 * Insère le contenu sous une section markdown dans un document.
 * Crée la section en fin de document si elle n'existe pas.
 *
 * L8 : le header est matché de façon ANCRÉE (ligne entière, trim comparé), pas en
 * sous-chaîne. Un `doc.includes(section)` matchait "## Notes" à l'intérieur d'un
 * paragraphe mémorisé ("voir ## Notes ci-dessous") ou d'un header plus long
 * ("## Notes techniques"), puis insérait après le prochain `\n` — donc potentiellement
 * AU MILIEU d'un contenu existant. On exige désormais une ligne dont le contenu trimé
 * est exactement le header recherché.
 */
function appendToSection(doc: string, section: string, content: string): string {
  const target = section.trim();
  const lines = doc.split('\n');
  const headerIdx = lines.findIndex(line => line.trim() === target);

  if (headerIdx !== -1) {
    // Insère le contenu juste après la ligne du header (ligne entière matchée).
    lines.splice(headerIdx + 1, 0, content);
    return lines.join('\n');
  }

  // Section inexistante → crée à la fin
  const sep = doc && !doc.endsWith('\n') ? '\n' : '';
  return `${doc}${sep}\n${section}\n${content}\n`;
}

/** Extrait un domaine depuis le nom de section (ex: "## TODOs" → "todos") */
function domainFromSection(section?: string): string | undefined {
  if (!section) return undefined;
  return section.replace(/^#+\s*/, '').toLowerCase().replace(/\s+/g, '-') || undefined;
}
