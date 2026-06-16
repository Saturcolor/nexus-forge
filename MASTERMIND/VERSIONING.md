# Version Mastermind

Une seule source à modifier : le fichier **`VERSION`** à la racine du dossier `MASTERMIND` (une ligne, ex. `0.3.2`).

Ensuite, pour aligner les `package.json` des workspaces (npm, builds) :

```bash
npm run version:sync
```

Le backend lit **`VERSION` au démarrage** pour répondre sur `GET /health` (`version` dans le JSON). Après un bump, redémarre le serveur pour que `/health` reflète la nouvelle valeur.

En déploiement (Docker, etc.), copie aussi le fichier **`VERSION`** à côté de l’arborescence attendue, ou laisse le fallback sur `package.json` racine.

Résumé :

1. Éditer `VERSION`
2. `npm run version:sync` (commit les `package.json` mis à jour si tu versionnes le repo)
3. Redémarrer le serveur

---

## Codebase search (onglet Mémoire)

Le package workspace **`@mastermind/codebase-search`** (`packages/codebase-search`) fournit l’indexation LanceDB + embeddings et est utilisé par :

- l’outil agent **`codebase_search`** (pas besoin de `bash` / CLI externe) ;
- l’API **`/api/codebase-search`** (status, stats, search) ;
- l’UI **Mémoire** (`/memory`).

**Configuration** (`mastermind.yml` + persistance API → **`mastermind.local.yml`**) : section `codebaseSearch` avec notamment `enabled`, `defaultDbPath` et/ou `indices`, `embedSources` (sources à indexer), `embeddingModel`, `embeddingApiKey` (souvent en local), `embedCronEnabled` / `embedCronHourUtc` (UTC), `lastEmbedRuns` (mis à jour par le serveur), `allowUiIndex` (désactiver pour refuser `POST /api/codebase-search/embed` depuis l’UI ; par défaut autorisé si non défini à `false`). L’onglet **Mémoire** permet d’éditer ces champs et de lancer un embed manuel.

**Agents** : dans `tools`, `disabled` peut inclure `codebase_search` ; `codebaseSearchInPrompt` ajoute une note sur l’index dans le prompt système ; `codebaseSearchIndex` choisit une clé dans `codebaseSearch.indices`.

**Prérequis** : clé embeddings via **`codebaseSearch.embeddingApiKey`** ou variables d’environnement **`mercury_API_KEY`** / **`OPENAI_API_KEY`**. Optionnel : `configPath` vers un JSON du même format que `codebase-search.config.json` (extensions, etc.).

**Build** : `npm run build` à la racine Mastermind compile aussi `@mastermind/codebase-search`. En CLI, indexer avec :  
`npm run index -w @mastermind/codebase-search -- <chemin> -d <répertoire_lancedb>` (voir le README du package).

L’ancien dossier **`NEXUS-PROJECT/codebase-search`** à la racine du repo global peut être conservé comme copie historique ; la source intégrée au monorepo est **`MASTERMIND/packages/codebase-search`**.

---

## Journalisation (fichier + rotation)

La section **`logging`** dans `mastermind.yml` / `mastermind.local.yml` (ou l’onglet **Settings → Logging**) définit le niveau minimal écrit sur disque, le chemin du fichier (optionnel) et la rotation par taille (`maxFileSizeMb`, `maxFiles`). Le serveur applique aussi **`MASTERMIND_LOG_LEVEL`** et **`MASTERMIND_LOG_FILE`** si présents. En Linux, **logrotate** externe reste possible en complément du mécanisme intégré (un seul process Node ouvre le fichier actif).
