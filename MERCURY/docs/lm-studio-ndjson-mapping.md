# Mapping LM Studio SSE → NDJSON (Ollama-compatible)

Le proxy convertit le flux SSE de LM Studio (`POST /api/v1/chat` avec `stream: true`) en NDJSON pour `/api/chat` (format Ollama-compatible). Référence : [lm studio streaming.md](lm%20studio%20streaming.md).

| Événement LM Studio | Chunk NDJSON émis |
|---------------------|-------------------|
| *(début du stream)* | Premier chunk : `event: "stream.start"`, `message: { role, content: "" }`, `done: false` — le client peut afficher « Traitement en cours » |
| `model_load.start`, `model_load.progress`, `model_load.end`, `prompt_processing.start`, `prompt_processing.progress`, `prompt_processing.end` | `model`, `created_at`, `message: { role, content: "" }`, `done: false`, `event` (type), `progress` (0–1 si fourni) — aperçu de l’avancement du process |
| `reasoning.start` | `event: "reasoning.start"`, `message: { role, content: "", reasoning: "" }`, `done: false` |
| `reasoning.delta` | `message: { role, content: "", reasoning: "<delta>" }`, `done: false` |
| `tool_call.start` | (accumulation interne) |
| `tool_call.arguments`, `tool_call.success` | `message: { role, content: "", tool_calls: [{ function: { name, arguments } }] }`, `done: false` (un chunk par appel complété) |
| `tool_call.failure` | (ignoré) |
| `message.delta` | `message: { role, content: "<delta>" }`, `done: false` |
| `error` | `message: { role, content: "[Erreur LM Studio: …]" }`, `done: true` ; fin du stream |
| `chat.end` | `message: { role, content: "" }`, `done: true`, `prompt_eval_count`, `eval_count`, `total_duration` (depuis `stats`) |

Implémentation : `providers/lm_studio/handler.py` → `_stream_from_resp`.

### Réception tout d’un bloc (pas de stream continu)

Si le client reçoit toute la réponse à la fin sans progression :

1. **LM Studio** doit envoyer les événements SSE au fur et à mesure (pas de buffer côté LM Studio). Vérifier la version et les réglages de LM Studio.
2. **Proxy inverse** (nginx, etc.) : le serveur envoie `X-Accel-Buffering: no` pour limiter la mise en buffer ; s’il y a un proxy, s’assurer qu’il ne bufferise pas la réponse.
3. **Client** : consommer le corps de la réponse en flux (ex. `fetch` + `response.body.getReader()`, ou équivalent) et traiter chaque ligne NDJSON dès réception.
