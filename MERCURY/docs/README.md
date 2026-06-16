# Mercury

Middleware de routage des requêtes chat : file d’attente unique (FIFO, une requête à la fois) et redirection vers **Ollama** ou **MLX** selon la configuration. Compatible **Linux et macOS**.

## Prérequis

- **Python 3.10+**
- **Node 18+** (uniquement pour builder l’interface web)
- Ollama et/ou MLX (optionnel pour tester l’UI)

## Installation

```bash
cd mercury
pip install -r requirements.txt
```

## Build de l’interface web (optionnel)

L’UI est servie depuis `frontend/dist/`. Pour la générer :

```bash
cd frontend
npm install
npm run build
cd ..
```

## Lancement

Depuis le répertoire `mercury/` :

```bash
python main.py
```

Ou en désignant le fichier depuis un répertoire parent :

```bash
python mercury/main.py
```

Le serveur écoute sur **toutes les interfaces** (`0.0.0.0:17890` par défaut), ce qui permet les requêtes en local, sur le LAN et via **Tailscale**. Host et port sont configurables dans `config.yaml` (`server_host`, `server_port`).

**Logs** : les logs applicatifs sont écrits dans `mercury/logs/mercury.log` ; les **requêtes** sont enregistrées dans `mercury/logs/usage_YYYY-MM-DD.jsonl` (une ligne JSON par requête, avec user_id, model, backend, status, durée). Le dashboard permet de consulter les logs et stats par date.

## Accès à l’interface web

Une fois le serveur démarré et le build frontend présent dans `frontend/dist/` :

- **Dashboard** : http://localhost:17890/

Vous y trouverez : état de la file (en attente, en cours, traitées), statut des backends (Ollama / MLX), **Users & clés API** (création d’utilisateurs, génération de clés, priorité), édition de la config (URLs, port, taille de la file), **Logs** (avec sélecteur de date et colonne User), et **Stats d’utilisation** par jour et par utilisateur.

## Configuration

Fichier **`config.yaml`** à la racine de `mercury/` :

```yaml
server_port: 17890
queue_max_size: 100

ollama_url: "http://localhost:11434"
mlx_url: "http://localhost:8080"

model_routes:
  - pattern: "ollama/.*"
    backend: "ollama"
  - pattern: "mlx/.*"
    backend: "mlx"
  - pattern: "lm_studio/.*"
    backend: "lm_studio"
  - pattern: "llamacpp/.*"
    backend: "llamacpp"
```

- **Routage** : le champ `model` de la requête est comparé aux `pattern` (regex). La première règle qui matche détermine le backend (`ollama`, `mlx`, `lm_studio`, `llamacpp`). Pas de règle catch-all par défaut : utilisez les tags explicites (ex. `ollama/ollama`, `llamacpp/llamacpp`) ou le préfixe du backend.

### Version de l'application

- Source de vérité: `MERCURY/VERSION`.
- La constante Python `config.version.__version__` est chargée automatiquement depuis ce fichier.
- Pour un bump de version, modifier uniquement `MERCURY/VERSION`.

### Client LLM et LM Studio

Pour utiliser n’importe quel client compatible OpenAI avec le middleware et LM Studio :

1. **Configurer le client** avec le **baseUrl du middleware** (ex. `http://localhost:17890`), et non l’URL de LM Studio directement. Ainsi toutes les requêtes passent par le middleware (logs, mapping de modèles, messages d’erreur corrects).
2. **Renseigner `model_mapping`** dans `config.yaml` pour chaque modèle (ex. `qwen/qwen3.5:9b`) : `backend: lm_studio` et `backend_model_id` égal à l’id exact retourné par `GET http://<lm_studio_url>/api/v1/models` (ex. `qwen/qwen3.5-9b@q6_k`). Voir `config.yaml.example` pour des exemples.

**Dépannage LM Studio** : si LM Studio renvoie « Invalid model identifier » ou « model_not_found », vérifier que (1) le modèle est bien **chargé** (Loaded) dans l’interface LM Studio avant d’envoyer des requêtes, et (2) que `backend_model_id` dans `model_mapping` correspond exactement à l’id exposé par `GET /api/v1/models`.

**Streaming LM Studio** : le proxy relaie les événements SSE (progression chargement/prompt, reasoning, tool calls, message) en NDJSON ; voir [docs/lm-studio-ndjson-mapping.md](lm-studio-ndjson-mapping.md) et [docs/lm studio streaming.md](lm%20studio%20streaming.md).

**Probe LM Studio** (optionnel) : pour afficher les stats de la machine hôte LM Studio (CPU, mémoire, température, prompt processing en temps réel), installer la **probe** sur cette machine (voir [probe/README.md](../probe/README.md)). Puis renseigner dans `config.yaml` : `lm_studio_probe_url: "http://IP:9090"` (ex. `http://localhost:9090` si même machine). L’API **GET /admin/lm-studio/probe** (token admin) renvoie alors les stats agrégées ou `{"configured": false}` si l’URL n’est pas définie.

Un changement de **port** ou **queue_max_size** nécessite un redémarrage du serveur. Les URLs Ollama/MLX et les règles de routage peuvent être modifiées depuis l’UI (POST /admin/config) et sont rechargées sans redémarrage.

### Users et clés API

La section **`users`** de la config (ou la gestion depuis le dashboard) associe chaque clé API à un `user_id` et une **priorité** (1 = la plus haute). Les requêtes sont traitées par ordre de priorité puis FIFO. Sans clé ou clé inconnue : utilisateur **anonymous**, priorité 99. La clé se transmet dans le header : `Authorization: Bearer <api_key>`. Création des utilisateurs et génération des clés depuis le dashboard (« Users & clés API ») ; la clé n’est affichée qu’une seule fois à la création.

### Mode local-only (sans OpenRouter web)

Pour forcer un fonctionnement strictement local :

- `local_only_mode: true` (désactive le backend OpenRouter web et le fallback associé)
- `openrouter_enabled: false`
- `openrouter_fallback_model: ""`
- `openrouter_api_key: ""` (optionnel mais recommandé)

Auth admin en local-only : si `admin_accept_user_api_key: true` (défaut), une clé user valide (`users[].api_key`) est acceptée sur `/admin/*` en plus du `admin_token`.

### Crédits providers (OPENBILL)

Le middleware intègre l’agrégation des **crédits / usage** des providers OpenRouter (openrouter.ai), OpenAI et Anthropic. Dans `config.yaml`, ajouter une section **`credits`** :

```yaml
credits:
  enabled: true
  timeout_ms: 30000
  openrouter_key: "sk-..."   # clé openrouter.ai (GET https://openrouter.ai/api/v1/credits)
  openai_key: "sk-..."       # clé Admin OpenAI
  anthropic_key: "sk-..."    # clé Admin Anthropic
```

Les clés ne sont **jamais** renvoyées par l’API (GET /admin/config retourne uniquement `enabled`, `timeout_ms` et la liste des providers configurés). Depuis le dashboard : activer « Crédits activés (OPENBILL) » dans Configuration, enregistrer, puis utiliser la section **« Crédits providers (OPENBILL) »** pour choisir les providers, le timeout et rafraîchir le rapport. En API : **GET /admin/credits** (rapport complet), **GET /admin/credits/totals** (totaux restants). L’ensemble tourne sur **Linux/macOS** (scripts install.sh, migrate.sh).

## API

Voir **[docs/API-CURL.md](docs/API-CURL.md)** pour des exemples de requêtes curl (chat, streaming, admin).

Pour les **endpoints admin** des providers locaux (probes, `host-stats`, sessions LM Studio / Ollama / LlamaCPP) : **[docs/local-providers-stats-endpoints.md](local-providers-stats-endpoints.md)**.

### Chat (OpenAI-compatible)

```bash
curl -X POST http://localhost:17890/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ollama/llama3",
    "messages": [{"role": "user", "content": "Dis bonjour"}],
    "stream": false
  }'
```

Avec streaming :

```bash
curl -X POST http://localhost:17890/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ollama/llama3",
    "messages": [{"role": "user", "content": "Compte de 1 à 5"}],
    "stream": true
  }'
```

Pour envoyer vers MLX, utilisez un modèle avec le préfixe `mlx/`, par exemple `"model": "mlx/qwen"` (en adaptant le nom au modèle MLX utilisé).

### Admin (dashboard)

- `GET /admin/config` — configuration actuelle
- `GET /admin/queue` — état de la file (size, in_progress, processed)
- `GET /admin/backends` — statut Ollama / MLX (up/down)
- `GET /admin/logs` — dernières requêtes ; `?date=YYYY-MM-DD` pour un jour donné
- `GET /admin/stats?date=YYYY-MM-DD` — stats d’utilisation (par user, total requêtes / durée)
- `GET /admin/dates` — liste des dates ayant des logs
- `GET /admin/users` — liste des users (clé masquée) ; `POST /admin/users` (création + clé générée une fois), `PATCH` / `DELETE` pour modification / suppression
- `GET /admin/credits` — rapport crédits (OPENBILL) ; `?providers=openrouter,openai&timeout_ms=30000`
- `GET /admin/credits/totals` — totaux restants par provider
- `POST /admin/config` — enregistrer la config (body JSON)

## Développement frontend (Linux / macOS)

Depuis `mercury/` :

1. Démarrer le serveur Python : `python main.py`
2. Dans un autre terminal : `cd frontend && npm run dev`
3. Ouvrir l’URL indiquée par Vite (ex. http://localhost:5173). Le proxy Vite redirige `/admin` et `/v1` vers le serveur (port 17890).

## Comportement

- **File à priorité** : une seule requête traitée à la fois. Les requêtes sont ordonnées par priorité (définie par la clé API / user), puis FIFO à priorité égale.
- **Streaming** : si `stream: true`, le flux SSE est proxifié depuis le backend vers le client ; le slot est libéré à la fin du stream.
- **Backends** : Ollama (`/api/chat`) et MLX (`/v1/chat/completions`) ; le format d’entrée est toujours OpenAI-like (`/v1/chat/completions`).

## Scripts d’installation et de migration (Linux / macOS)

- **`install.sh`** : installation complète (dépendances, venv, build frontend, service systemd sur Linux). Sur Linux : `sudo ./install.sh`. Sur macOS : exécution possible sans sudo (le script adapte les commandes) ; vous pouvez modifier `APP_DIR` en tête de script (ex. `$HOME/mercury`) si vous n’utilisez pas `/opt/mercury`.
- **`migrate.sh`** : backup, restauration et mise à jour du déploiement.
  - `sudo ./migrate.sh backup` — crée une archive (code, config.yaml, logs) dans `$BACKUP_DIR` (défaut : `/var/backups/mercury`).
  - `sudo ./migrate.sh restore <fichier.tar.gz>` — restaure code et optionnellement config/logs.
  - `sudo ./migrate.sh migrate` — backup puis mise à jour (code, venv, deps, build frontend, redémarrage du service).
  - `sudo ./migrate.sh list` — liste les backups.
- **Service systemd** : le fichier `systemd/mercury.service` est installé par `install.sh` sur Linux. Démarrer avec : `sudo systemctl start mercury`.
- **Probe LM Studio** : dans le répertoire `probe/`, `install.sh` et `migrate.sh` permettent d’installer et mettre à jour la probe sur la machine hôte LM Studio (voir [probe/README.md](../probe/README.md)).

## Routes optionnelles (dépendances externes)

Certaines routes Mercury nécessitent des composants externes non inclus dans ce dépôt :

| Routes | Dépendance | Activation |
|--------|-----------|------------|
| `/atlas/*` | AtlasMind (app séparée, port 9300 par défaut) | `atlas_enabled: true` dans `config.yaml` |
| `/quant/*` | brain-daemon avec module quantize | `quant_enabled: true` dans `config.yaml` |
| `/admin/amrevolt/*` | Amrevolt (app séparée) | Toujours enregistré ; renvoie 502 si Amrevolt inaccessible |

Sans la dépendance active, les routes `/atlas/*` et `/quant/*` renvoient **501 Not Implemented** (feature flag désactivé par défaut). Ces routes sont complètement facultatives — Mercury démarre et fonctionne normalement sans elles.
