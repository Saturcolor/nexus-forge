# Providers locaux — stats, probes et sessions

Toutes les routes sont sous le **middleware** mercury, préfixe **`/admin`**.  
Auth : **`Authorization: Bearer <token>`** si `admin_token` est configuré.

## Comparaison rapide

| Provider | Métriques proxy **par modèle** | Session unifiée (`ts` + ctx + …) |
|----------|--------------------------------|----------------------------------|
| **LlamaCPP** | Oui — `by_model` dans `/admin/llamacpp/probe` et `/admin/host-stats` | `GET /admin/llamacpp/session/{model_id}` |
| **LM Studio** | Non — store global (dernière génération quel que soit le modèle) | `GET /admin/lm-studio/session/{model_key}` |
| **Ollama** | Non — idem | `GET /admin/ollama/session/{model_name}` |

---

## Vue globale machine

**`GET /admin/host-stats`** — CPU, GPU, RAM, réseau, etc. Blocs optionnels **`lmstudio`**, **`ollama`**, **`llamacpp`** (pour llamacpp : `instances` + `by_model`).

---

## LM Studio

### Probe

**`GET /admin/lm-studio/probe`** — Probe hôte (`lm_studio_probe_url/stats`) si configuré + champs proxy globaux.

### Liste modèles

**`GET /admin/lm-studio/models`** — Modèles avec `loaded_instances` (id, config).

### Session (snapshot)

**`GET /admin/lm-studio/session/{model_key}`**

- **`model_key`** : clé LM Studio (ex. `qwen/qwen3.5-9b`), segments de chemin autorisés (`:path`).
- **`404`** si le modèle n’existe pas dans `GET /api/v1/models`.
- **`200`** si le modèle existe : `loaded_instances` peut être vide (non chargé).
- Champs utiles : `ts`, `loaded_instances`, `context_length` (dérivé du premier `config` chargé), `proxy_metrics` (global).

### Session (SSE ~1 s)

**`GET /admin/lm-studio/session-stream/{model_key}`**

```bash
curl -N -H "Authorization: Bearer TOKEN" \
  "http://127.0.0.1:PORT/admin/lm-studio/session-stream/qwen%2Fqwen3.5-9b"
```

---

## Ollama

### Probe

**`GET /admin/ollama/probe`** — Probe hôte (`ollama_probe_url/stats`) si configuré.

### Modèles / ps

- **`GET /admin/ollama/models`** — Tags + flag `running` (via `/api/ps`).
- **`GET /admin/ollama/ps`** — Réponse brute de **`GET /api/ps`** Ollama.

### Session (snapshot)

**`GET /admin/ollama/session/{model_name}`**

- Appelle **`POST /api/show`** puis **`GET /api/ps`** (entrée du modèle si chargé).
- **`404`** si le modèle est inconnu pour Ollama.
- Champs : `ts`, `show` (JSON show), `ps` (entrée ou `null`), `context_length` (souvent depuis `parameters.num_ctx` dans `show`), `proxy_metrics` (global).

### Session (SSE ~1 s)

**`GET /admin/ollama/session-stream/{model_name}`**

```bash
curl -N -H "Authorization: Bearer TOKEN" \
  "http://127.0.0.1:PORT/admin/ollama/session-stream/llama3.2:3b"
```

---

## LlamaCPP

Le **`model_id`** est celui du **daemon** (chemin relatif GGUF sous `models_path`), pas le préfixe client `llamacpp/...`.

| Endpoint | Rôle |
|----------|------|
| **`GET /admin/llamacpp/probe`** | `instances`, **`by_model`** (métriques proxy par modèle), champs globaux |
| **`GET /admin/llamacpp/slots/{model_id}`** | Proxy → llama-server `/slots` |
| **`GET /admin/llamacpp/session/{model_id}`** | Slots + `proxy_metrics` = `by_model[model_id]` + `n_ctx_max` |
| **`GET /admin/llamacpp/session-stream/{model_id}`** | SSE ~1 s, même schéma |
| **`GET /admin/llamacpp/daemon-version`** | Version **llamacpp-daemon** (`/mgmt/version`) |

**`GET /admin/version`** = version du **middleware** uniquement.

Exemple probe par modèle :

```bash
curl -sS -H "Authorization: Bearer TOKEN" \
  "http://127.0.0.1:PORT/admin/llamacpp/probe" | jq '.by_model'
```

---

## Récap endpoints session

| Provider | Snapshot | SSE |
|----------|----------|-----|
| LM Studio | `GET /admin/lm-studio/session/{model_key}` | `.../session-stream/{model_key}` |
| Ollama | `GET /admin/ollama/session/{model_name}` | `.../session-stream/{model_name}` |
| LlamaCPP | `GET /admin/llamacpp/session/{model_id}` | `.../session-stream/{model_id}` |

Les métriques **tokens** côté LM Studio et Ollama dans `proxy_metrics` reflètent la **dernière** réponse passée par le proxy (tous modèles confondus), jusqu’à une évolution éventuelle `by_model` pour ces backends.

---

## Types TypeScript (frontend)

Voir **`getLmStudioSession`**, **`getOllamaSession`**, **`getLlamacppSession`** dans [`frontend/src/api/admin.ts`](../frontend/src/api/admin.ts).
