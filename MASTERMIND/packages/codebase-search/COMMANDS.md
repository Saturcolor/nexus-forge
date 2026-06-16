# Codebase-search — Résumé des commandes

## Installation

1. **Cloner ou se placer dans le projet**
   ```bash
   cd codebase-search
   ```

2. **Installer les dépendances**
   ```bash
   npm install
   ```

3. **Compiler (TypeScript → JavaScript)**
   ```bash
   npm run build
   ```
   Les commandes utilisent le dossier `dist/`. Si tu modifies le code source (`.ts`), relance `npm run build`.

4. **Configuration (optionnel mais recommandé)**
   - Créer un fichier de config : `codebase-search init` (génère `codebase-search.config.json`).
  - Clé API mercury : soit dans le fichier de config (`apiKey`), soit en variable d’environnement `mercury_API_KEY` (ou `OPENAI_API_KEY`), soit dans `~/MASTERMIND/.env` (chargé automatiquement).

5. **Vérifier l’installation**
   ```bash
   node dist/index.js test
   ```
   ou, après avoir ajouté la commande au PATH (voir ci‑dessous) :
   ```bash
   codebase-search test
   ```

6. **Ajouter `codebase-search` au PATH (pour l’utiliser depuis n’importe quel répertoire)**

   Choisir une des méthodes suivantes.

   **Option A — Lien symbolique dans un répertoire déjà dans le PATH (recommandé)**  
   Remplace `<CHEMIN_PROJET>` par le chemin réel du projet (ex. `~/scripts/codebase-search`).
   ```bash
   chmod +x <CHEMIN_PROJET>/bin/codebase-search.js
   sudo ln -sf "$(realpath <CHEMIN_PROJET>/bin/codebase-search.js)" /usr/local/bin/codebase-search
   ```
   Exemple concret :
   ```bash
   chmod +x <install-dir>/bin/codebase-search.js
   sudo ln -sf <install-dir>/bin/codebase-search.js /usr/local/bin/codebase-search
   ```
   Le `chmod +x` est nécessaire pour que le système puisse exécuter le script (shebang `#!/usr/bin/env node`). Vérifier que `/usr/local/bin` est dans le PATH (`echo $PATH`). Ensuite : `codebase-search test`.

   **Option B — Répertoire du projet dans le PATH + lien dans `bin/`**  
   Depuis la racine du projet :
   ```bash
   cd bin
   ln -sf codebase-search.js codebase-search
   cd ..
   export PATH="$PATH:$(pwd)/bin"
   ```
   Pour rendre ça permanent, ajouter la dernière ligne dans `~/.bashrc` (en remplaçant `$(pwd)` par le chemin absolu du projet, ex. `<install-dir>`) :
   ```bash
   echo 'export PATH="$PATH:<install-dir>/bin"' >> ~/.bashrc
   source ~/.bashrc
   ```

   **Option C — Alias dans le shell**  
   Dans `~/.bashrc` (adapter le chemin) :
   ```bash
   alias codebase-search='node <install-dir>/bin/codebase-search.js'
   ```
   Puis `source ~/.bashrc`. Ensuite `codebase-search` fonctionne partout.

**Prérequis :** Node.js (recommandé 18+). Une clé API mercury est nécessaire pour l’indexation et la recherche.

---

## Aide

| Commande | Description |
|----------|-------------|
| `codebase-search help` | Affiche l'aide et liste toutes les commandes (équivalent à `--help` / `-h`). |

---

## Index et listage

| Commande | Description |
|----------|-------------|
| `codebase-search index <path>` | Indexe le répertoire `<path>` et génère les embeddings. Sans `-d`, l’index est stocké dans `~/embed` (et remplace l’index précédent à cet emplacement). |
| `codebase-search embed <path>` | Indexe ou **met à jour** les embeddings du répertoire (même comportement qu’`index`). Pratique pour rafraîchir un index après des changements dans le code. |
| `codebase-search list` | Liste les répertoires d’index (codebases) trouvés sous `~/embed` (racine et sous-dossiers), avec le nombre de chunks par index. |

**Options communes à `index` et `embed` :**

- `-c, --config <path>` — Fichier de configuration.
- `-d, --db <path>` — Où stocker la base LanceDB (défaut : `~/embed`).
- `--no-tree-sitter` — Désactive Tree-sitter (fallback sliding-window).

**Options de `list` :**

- `-r, --root <path>` — Racine à scanner (défaut : `~/embed`).

---

## Recherche

| Commande | Description |
|----------|-------------|
| `codebase-search search <query>` | Recherche sémantique. **Sans `-d`** : recherche dans **tous** les index sous `~/embed` (ou `-r`), résultats fusionnés par score. **Avec `-d <path>`** : recherche dans l’index indiqué uniquement. |

**Options :**

- `-c, --config <path>` — Fichier de configuration.
- `-d, --db <path>` — Index à interroger (optionnel : si absent, recherche dans tous les index sous `-r`).
- `-r, --root <path>` — Racine des index pour recherche globale sans `-d` (défaut : `~/embed`).
- `-l, --limit <n>` — Nombre max de résultats (défaut : `10`).
- `-f, --format <format>` — Sortie : `terminal`, `json`, `md` (défaut : `terminal`).
- `-e, --extension <ext>` — Filtrer par extension (répétable).
- `--file-pattern <pattern>` — Filtrer par motif sur le chemin de fichier.
- `-t, --type <type>` — `vector` ou `hybrid` (défaut : `vector`).
- `-w, --weight <n>` — Poids du nom de fichier en mode hybride, 0–1 (défaut : `0.2`).
- `--candidate-pool <n>` — Taille du pool candidat avant reranking (défaut: config).
- `--rerank-top-k <n>` — Taille du pool reranké localement (défaut: config).
- `--exact-symbol` — Prioriser les correspondances exactes sur `chunk.name`.

---

## Statistiques

| Commande | Description |
|----------|-------------|
| `codebase-search stats` | Affiche les statistiques de l’index (nombre de chunks, répartition par extension). |

**Options :**

- `-c, --config <path>` — Fichier de configuration.
- `-d, --db <path>` — Index à interroger (défaut : `~/embed`).

---

## Configuration et test

| Commande | Description |
|----------|-------------|
| `codebase-search init` | Crée un fichier de configuration par défaut. |
| `codebase-search test` | Vérifie la config, la clé API (env ou config) et l’accès à l’API mercury et à LanceDB. |

**Options de `init` :**

- `-o, --output <path>` — Fichier de sortie (défaut : `codebase-search.config.json`).

**Options de `test` :**

- `-c, --config <path>` — Fichier de configuration.

---

## Synchronisation index / source (incrémental)

| Commande | Description |
|----------|-------------|
| `codebase-search update` | Met à jour **tous** les index sous `~/embed` en mode incrémental (répertoire source déduit des chemins indexés). |
| `codebase-search update <path>` | Met à jour **un** index : compare `<path>` à l’index (défaut ou `-d`), supprime l’obsolète, embed le manquant. |

**Options :**

- `-c, --config <path>` — Fichier de configuration.
- `-d, --db <path>` — Index à mettre à jour (utilisé seulement avec un `path` fourni ; défaut : `~/embed`).
- `-r, --root <path>` — Racine des index à scanner quand **aucun** path n’est fourni (défaut : `~/embed`).
- `--no-tree-sitter` — Désactiver Tree-sitter pour les nouveaux fichiers.

---

## Exemples d'utilisation

### Indexation

```bash
# Indexer le répertoire courant, index stocké dans ~/embed (remplace l'index existant)
codebase-search index .

# Indexer un chemin absolu
codebase-search index ~/my-project/

# Indexer et stocker l'index dans un sous-dossier de ~/embed (plusieurs codebases)
codebase-search index ~/my-project/ -d ~/embed/workspace-main

# Indexer avec un index nommé "mon-projet" (chemin relatif = sous le répertoire courant)
codebase-search index ./mon-repo -d ./embed-mon-projet

# Indexer sans Tree-sitter (fallback sliding-window)
codebase-search index /path/to/repo --no-tree-sitter

# Mettre à jour les embeddings d'un index existant (même syntaxe qu'index)
codebase-search embed ~/my-project/ -d ~/embed/workspace-main
```

### Mise à jour des embeddings

```bash
# Rafraîchir l'index par défaut (~/embed) après des changements dans le projet
codebase-search embed ~/my-project/

# Rafraîchir un index nommé
codebase-search embed ~/my-project/ -d ~/embed/workspace-main
```

### Mise à jour incrémentale (update = list + embed manquants)

```bash
# Mettre à jour tous les index connus (sous ~/embed) — pas besoin de path
codebase-search update

# Mettre à jour un seul index en donnant le répertoire source
codebase-search update ~/my-project/

# Un index précis avec -d
codebase-search update ~/my-project/ -d ~/embed/workspace-main
```

### Listage des index

```bash
# Lister tous les index sous ~/embed
codebase-search list

# Lister les index sous une autre racine
codebase-search list -r ~/embed
```

### Recherche

```bash
# Recherche globale dans tous les index (sans -d)
codebase-search search "où est la fonction d'authentification"

# Recherche dans un index précis
codebase-search search "config API" -d ~/embed/workspace-main

# Recherche globale avec une autre racine d'index
codebase-search search "config API" -r ~/embed

# 20 résultats, format JSON
codebase-search search "erreur 404" -l 20 -f json

# Filtrer par extension (.ts et .tsx)
codebase-search search "useState" -e .ts -e .tsx

# Recherche hybride (vector + nom de fichier), poids fichier 0.3
codebase-search search "login" -t hybrid -w 0.3

# Recherche plus ciblée (grand pool + reranking + symbole exact)
codebase-search search "AuthService login" -t hybrid --candidate-pool 120 --rerank-top-k 40 --exact-symbol

# Filtrer par motif de chemin
codebase-search search "database" --file-pattern "src/"
```

### Statistiques

```bash
# Stats de l'index par défaut
codebase-search stats

# Stats d'un index précis
codebase-search stats -d ~/embed/workspace-main
```

### Config et test

```bash
# Créer un fichier de config
codebase-search init

# Créer la config dans un fichier nommé autrement
codebase-search init -o .codebase-search.json

# Tester la configuration et l'API
codebase-search test
```

---

## Récapitulatif rapide

| Commande | Rôle |
|----------|------|
| `help` | Aide / liste des commandes |
| `list` | Lister les index sous `~/embed` |
| `index <path>` | Indexer un répertoire |
| `embed <path>` | Indexer ou mettre à jour les embeddings (rafraîchir un index) |
| `search <query>` | Rechercher dans l’index |
| `stats` | Stats de l’index |
| `update` / `update <path>` | Mise à jour incrémentale : sans path = tous les index ; avec path = un index |
| `init` | Créer un fichier de config |
| `test` | Tester config et API |

**Emplacement par défaut des index :** `~/embed` (ou `%USERPROFILE%\embed` sous Windows). Utiliser `-d <path>` pour un index différent (ex. `-d ~/embed/mon-projet`).

---

## Protocole d'évaluation précision (avant/après)

1. Définir un jeu de 10-20 requêtes représentatives.
2. Lancer chaque requête avec les mêmes options et sauvegarder les top 5.
3. Noter pour chaque requête:
   - `precision@5`
   - `hit@3` (au moins un résultat pertinent dans le top 3)
4. Ajuster `vectorWeight`, `lexicalWeight`, `structuralWeight`, puis refaire la mesure.
