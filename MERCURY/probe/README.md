# Probe LM Studio / Ollama

Service léger à installer sur la **machine qui héberge LM Studio et/ou Ollama**. Il expose des **stats système** (CPU, mémoire, température), parse les **logs LM Studio** pour afficher en temps réel le chargement du modèle et le traitement des prompts, et peut interroger **Ollama** (modèles chargés en mémoire via `/api/ps`).

La **même probe** peut servir LM Studio et Ollama si les deux tournent sur la même machine. Le middleware OpenRouter interroge la probe via `lm_studio_probe_url` (pour LM Studio) et/ou `ollama_probe_url` (pour Ollama) pour afficher les métriques et le badge « Probe OK » dans le dashboard.

## Prérequis

- Python 3.10+
- LM Studio installé sur la même machine (logs dans `~/.lmstudio/server-logs`)

## Installation rapide

```bash
cd probe
sudo ./install.sh
```

Par défaut le service est installé dans `/opt/openrouter-probe`. Pour un autre répertoire :

```bash
PROBE_APP_DIR=/home/user/probe ./install.sh
```

Sur Linux, le service systemd `probe-lmstudio` est installé. Démarrer :

```bash
sudo systemctl enable probe-lmstudio
sudo systemctl start probe-lmstudio
```

Sur macOS (pas de systemd) :

```bash
cd /opt/openrouter-probe   # ou PROBE_APP_DIR
./venv/bin/python main.py
```

## Configuration

Fichier **`config.yaml`** (créé depuis `config.yaml.example` à l’installation) :

| Option | Défaut | Description |
|--------|--------|-------------|
| `host` | `0.0.0.0` | Interface d’écoute |
| `port` | `9090` | Port HTTP |
| `ollama_url` | (vide) | Si défini (ex. `http://localhost:11434`), la probe interroge Ollama pour `/api/ps` et ajoute la clé `ollama` dans `GET /stats` (modèles chargés). Permet d’utiliser la même probe pour Ollama ; le middleware utilise alors `ollama_probe_url` pour le statut probe. |
| `lmstudio_logs_dir` | (vide = `~/.lmstudio/server-logs`) | Répertoire des logs LM Studio |
| `log_source` | `tail` | `tail` (fichier) ou `cli` (`lms log stream --source server`) |
| `stats_interval_seconds` | `2` | Intervalle rafraîchissement stats (SSE) |
| `sse_heartbeat_seconds` | `5` | Heartbeat SSE |

## Endpoints

- **`GET /health`** — Liveness (réponse `{"status": "ok"}`).
- **`GET /stats`** — JSON avec `system` (CPU, mémoire, swap, température), `lmstudio` (état dérivé des logs : `model_loading`, `loading_progress`, `last_prompt_tokens`, etc.) et optionnellement `ollama` (si `ollama_url` est configuré : `loaded_models`, `models_detail`, ou `error`).
- **`GET /stats/stream`** — Flux SSE : mises à jour périodiques des mêmes données (temps réel).

## Migration / mise à jour

Depuis le répertoire `probe/` :

```bash
sudo ./migrate.sh backup    # backup (code + config)
sudo ./migrate.sh migrate   # backup + copie code + mise à jour deps + redémarrage
sudo ./migrate.sh restore /var/backups/openrouter-probe/probe_backup_YYYYMMDD_HHMMSS.tar.gz
sudo ./migrate.sh list      # lister les backups
```

## Intégration avec le middleware OpenRouter

Dans la config du **middleware** (sur une autre machine ou la même), définir l’URL de la probe :

```yaml
lm_studio_probe_url: "http://IP_MACHINE_LMSTUDIO:9090"
```

Exemple si LM Studio et le middleware sont sur la même machine : `http://localhost:9090`.

Le middleware expose :
- **`GET /admin/lm-studio/probe`** (avec token admin) : appelle la probe si `lm_studio_probe_url` est défini, renvoie le JSON des stats ou `{"configured": false}` / `{"configured": true, "error": "..."}`.
- **`GET /admin/ollama/probe`** (avec token admin) : appelle la probe si `ollama_probe_url` est défini (même probe ou une autre instance), renvoie le même format. Pour qu’une probe renvoie la clé `ollama` dans `/stats`, configurer `ollama_url` dans le `config.yaml` de la probe sur la machine Ollama.
