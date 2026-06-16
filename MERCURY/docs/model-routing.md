# Routage des modèles — Client → Middleware → Providers

Ce document décrit le flux de résolution du champ `model` entre Client, le middleware et les backends (Ollama, LM Studio, MLX, llama.cpp, OpenRouter).

## Schéma du flux

```
Client (client config)     Middleware                      Providers
────────────────────────     ─────────                       ─────────
baseUrl + model id    →      POST /v1/chat/completions
                             ou POST /api/chat
                                    │
                                    ▼
                             resolve_model(model)
                                    │
                                    ├── Cache mémoire
                                    ├── model_mapping (config/DB)
                                    ├── models_cache (nom exact / normalisé)
                                    ├── model_routes (regex)
                                    └── Fallback par backend
                                    │
                                    ▼
                             (backend, backend_model_id)
                                    │
                                    ▼
                             get_backend(backend) → backend.chat(body)
                                    │
                                    ▼
                             Ollama | LM Studio | MLX | llamacpp | OpenRouter
```

- **Points d’entrée** : `POST /v1/chat/completions` (file + worker), `POST /api/chat` (direct), `POST /v1/responses` (LM Studio uniquement, après résolution).
- **Config** : `config.yaml` + overrides DB (`data/db.json`) pour `model_mapping`, `model_routes`, `provider_priority`, `model_priority`, `hidden_models`. La DB a priorité sur le YAML pour ces clés.

## Formats de `model` supportés

| Format (exemples) | Comportement |
|-------------------|--------------|
| `ollama/ollama` | Premier modèle **Ollama** disponible. |
| `lm_studio/lm_studio`, `lmstudio/lmstudio` | Premier modèle **LM Studio** disponible. |
| `llamacpp/llamacpp` | Premier modèle **llama.cpp** (de préférence déjà chargé). |
| `mlx/mlx` | Premier modèle **MLX** disponible. |
| `backend/model_id` (ex. `ollama/llama3.2`, `lm_studio/qwen3.5-9b`) | Routage vers ce backend avec l’id dérivé (préfixe retiré, `:` → `-` pour LM Studio si besoin). |
| `openrouter/...` | Routage vers OpenRouter avec l’id après le préfixe. |
| Nom canonique dans `model_mapping` | Résolution explicite (backend + backend_model_id). |

Les anciennes formes `auto`, `auto/auto` ou `backend/auto` ne sont plus acceptées : utiliser `ollama/ollama`, `lm_studio/lm_studio`, etc.

## Ordre de résolution dans `resolve_model()`

1. **backend/backend** : `ollama/ollama`, `lm_studio/lm_studio` (ou `lmstudio/lmstudio`), `llamacpp/llamacpp`, `mlx/mlx` → premier modèle du backend.
2. **Forcer OpenRouter** : si `openrouter_fallback_force` est activé → tout vers OpenRouter (openrouter_fallback_model).
3. **Cache mémoire** : résolutions déjà faites (nom → (backend, backend_model_id)).
4. **model_mapping** : entrées explicites (config ou DB).
5. **Cache dynamique** : par nom exact puis par clé normalisée (ex. `qwen/qwen3.5:9b` → `qwen3.5-9b`).
6. **model_routes** : première règle regex qui matche ; si le modèle résolu est `backend/backend`, premier modèle de ce backend.
7. **Fallback par backend** : si aucune règle ne matche, essayer chaque backend activé (ollama, mlx, lm_studio, llamacpp) avec strip de préfixe.
8. **Dernier recours** : OpenRouter si configuré (openrouter_fallback_model).

## Correspondance Provider Client ↔ Backend middleware

| Provider Client (auth / models dans client config) | Backend middleware |
|-----------------------------------------------------|--------------------|
| `ollama` | `ollama` |
| `lmstudio` | `lm_studio` |
| `mlx` | `mlx` |
| `llamacpp` | `llamacpp` |
| `openrouter` | `openrouter` |

Dans les requêtes (champ `model`), Client envoie par exemple `lm_studio/lm_studio` ou `lmstudio/lmstudio` ; le middleware accepte les deux et route vers le premier modèle LM Studio.

## Sources de configuration

- **Éditable en DB (priorité sur YAML)** : `model_mapping`, `model_routes`, `provider_priority`, `model_priority`, `hidden_models`, et les réglages déjà migrés (debug, require_api_key, ollama_enabled, etc.). Voir `data/db.py` et `routing/router.py` (`_apply_db_overrides`).
- **En config uniquement (jamais en DB)** : `admin_token`, `openrouter_api_key`, URLs des backends (ollama_url, lm_studio_url, etc.). Voir commentaires en tête de `config.yaml` (ou `config.yaml copy.example`).

## GET /api/tags

- Si `model_mapping` est non vide : `GET /api/tags` renvoie la fusion `model_mapping` + le cache dynamique (modèles des backends activés). Les clés du mapping qui ne sont pas déjà dans le cache dynamique sont ajoutées.
- Sinon (cache dynamique vide) : la liste renvoyée est celle des clés du mapping (noms canoniques).

Le cache dynamique inclut : `ollama/*`, `lm_studio/*`, `mlx/*`, `llamacpp/*` et, si activé/configuré, `openrouter/*`. Les tags `ollama/ollama`, `lm_studio/lm_studio`, `llamacpp/llamacpp`, `mlx/mlx` sont ajoutés en tête (pour le routage explicite Client).

## Référence rapide : tags pour routage dans Client

| Tag à mettre dans Client | Comportement |
|---------------------------|--------------|
| `lm_studio/lm_studio` ou `lmstudio/lmstudio` | Premier modèle LM Studio |
| `ollama/ollama` | Premier modèle Ollama |
| `llamacpp/llamacpp` | Premier modèle llama.cpp |
| `mlx/mlx` | Premier modèle MLX |
