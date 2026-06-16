# 🔍 codebase-search

Système d'indexation de codebase avec recherche sémantique (vector search).

## ✨ Features

- **Indexation intelligente** : Parsing structurel avec Tree-sitter + fallback sliding window
- **Embeddings cloud** : Via mercury (pas de OOM local)
- **Recherche hybride** : Vectorielle + boost sur noms de fichiers
- **Multi-langages** : TypeScript, JavaScript, Python, C#, Java, Go, Rust, etc.
- **Scalable** : LanceDB pour stocker des milliers de chunks

## 🚀 Installation

```bash
cd ~/WORKSPACE/skills/codebase-search
npm install
npm run build

# Lien global (optionnel)
npm link
```

### Build TypeScript (`tsc`)

Le fichier [`src/ambient-modules.d.ts`](src/ambient-modules.d.ts) fournit des déclarations minimales pour les dépendances natives / sans résolution de types idéale sous `moduleResolution: Node16` (workspaces npm, Docker, etc.). Les paquets listés restent des **dépendances runtime** réelles (`npm install` à la racine du monorepo Mastermind).

## ⚙️ Configuration

Créer un fichier `codebase-search.config.json` :

```bash
npx codebase-search init
```

Ou manuellement :

```json
{
  "extensions": [".ts", ".tsx", ".js", ".py", ".cs"],
  "excludeDirs": ["node_modules", ".git", "dist", "build"],
  "excludeFiles": ["*.min.js", "*.map"],
  "chunkSize": 1500,
  "chunkOverlap": 200,
  "embeddingModel": "qwen/qwen3-embedding-8b",
  "embeddingDimensions": 4096,
  "maxConcurrentFiles": 50,
  "useTreeSitter": true,
  "candidatePool": 80,
  "rerankTopK": 30,
  "vectorWeight": 0.55,
  "lexicalWeight": 0.3,
  "structuralWeight": 0.15,
  "debugScoring": false
}
```

## 🔑 Prérequis

Variable d'environnement requise :

```bash
export mercury_API_KEY="sk-or-..."
```

## 📖 Usage

### Indexer une codebase

```bash
# Indexer le répertoire courant
codebase-search index .

# Indexer avec config personnalisée
codebase-search index /path/to/project -c ./my-config.json

# Sans Tree-sitter (plus rapide, moins précis)
codebase-search index . --no-tree-sitter
```

### Rechercher

```bash
# Recherche vectorielle
codebase-search search "fonction qui gère l'authentification"

# Recherche hybride (vector + nom de fichier)
codebase-search search "user controller" -t hybrid -w 0.3

# Recherche plus précise (pool + reranking + symbole exact)
codebase-search search "AuthService login" -t hybrid --candidate-pool 120 --rerank-top-k 40 --exact-symbol

# Filtrer par extension
codebase-search search "database connection" -e .ts -e .js

# Format JSON
codebase-search search "error handling" --format json

# Format Markdown
codebase-search search "API routes" --format md > results.md
```

### Stats

```bash
codebase-search stats
```

### Test

```bash
codebase-search test
```

## 🛠️ Commandes

```
Usage: codebase-search [options] [command]

Commands:
  index <path>     Indexer une codebase
  search <query>   Rechercher dans la codebase indexée
  stats            Afficher les statistiques de l'index
  init             Créer un fichier de configuration par défaut
  test             Tester la configuration et la connexion API

Options:
  -c, --config <path>   Chemin vers le fichier de configuration
  -d, --db <path>       Chemin vers la base LanceDB (défaut: ./.codebase-index)
```

## 🔧 Options de recherche

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Nombre max de résultats (défaut: 10) |
| `-f, --format <format>` | terminal / json / md |
| `-e, --extension <ext>` | Filtrer par extension (répétable) |
| `--file-pattern <pattern>` | Filtrer par pattern de chemin |
| `-t, --type <type>` | vector ou hybrid |
| `-w, --weight <n>` | Poids du nom de fichier (0-1) |
| `--candidate-pool <n>` | Taille du pool candidat avant tri final |
| `--rerank-top-k <n>` | Nombre de candidats rerankés localement |
| `--exact-symbol` | Priorise les matches exacts de symbole |

## 📁 Structure

```
.codebase-index/          # Base LanceDB (créée automatiquement)
├── codebase.lance/       # Table des chunks indexés
└── ...
```

## 🌳 Tree-sitter

Quand `useTreeSitter: true` :
- Parse les fonctions, classes, interfaces séparément
- Meilleure granularité pour la recherche
- Fallback sur sliding window si parsing échoue

Langages supportés :
- TypeScript / TSX
- JavaScript / JSX
- Python

## 💡 Exemples

```bash
# Index your project
codebase-search index ~/dev/my-project -d ~/.cache/codebase-search/my-project

# Find where a function is defined
codebase-search search "function calculateTotal" -d ~/.cache/codebase-search/my-project

# Chercher des patterns de code
codebase-search search "async function with retry logic"

# Exporter les résultats
codebase-search search "database migration" --format md > migrations.md
```

## 🐛 Troubleshooting

**Erreur "mercury_API_KEY non définie"** :
```bash
export mercury_API_KEY="sk-or-..."
```

**Rate limit mercury** :
- Le script fait des pauses automatiques entre les batches
- Réduisez `maxConcurrentFiles` dans la config

## 📏 Évaluer la précision (avant/après)

- Préparez 10-20 requêtes réelles de votre équipe (ex: "où est validé le JWT", "service de retry DB").
- Exécutez les mêmes requêtes avant et après changement de poids/options.
- Mesurez:
  - précision@5 (combien de résultats top 5 sont réellement pertinents),
  - hit@3 (au moins 1 bon résultat dans le top 3),
  - stabilité du top 3 (résultats cohérents entre runs).
- Ajustez `vectorWeight`, `lexicalWeight`, `structuralWeight`, puis re-testez.
- Modèle prêt à l'emploi: `evaluation/golden-queries.example.json`.

**Tree-sitter ne fonctionne pas** :
- C'est optionnel, le sliding window fonctionne très bien
- Ou installez les dépendances natives : `npm rebuild`

## 📄 License

MIT
