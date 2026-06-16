# Mock API Mercury (développement)

## Activation

En développement uniquement, avec double garde `import.meta.env.DEV` + `VITE_MOCK_API` :

**Windows (cmd)**

```bat
set VITE_MOCK_API=1
npm run dev
```

**PowerShell**

```powershell
$env:VITE_MOCK_API='1'; npm run dev
```

**Unix**

```bash
VITE_MOCK_API=1 npm run dev
```

Au chargement, `installMock()` enregistre aussi `localStorage.mercury_admin_token = mock` pour que le dashboard ne reste pas sur l’écran de login.

## Console — `window.__mercuryMock`

- `scenarios` : objet mutable (voir `mockScenarios.ts`)
  - `slotActive` : slot exclusif → 503 `slot_reserved` sur inférence + `Retry-After` / `ends_at`
  - `slotOwner` : user autorisé si vous passez le header `X-Mock-Consumer: <user_id>` (ex. `alice`)
  - `ollamaDown` : backends / probe Ollama en erreur
  - `healthzDegraded` : `GET /healthz` → 503 avec `scheduler_last_tick_age_s` dans le payload
  - `embeddingsFailAll` : `POST /v1/embeddings` → 502 chaîne
  - `anthropicStreamError` : flux SSE `/v1/chat/completions` avec événement d’erreur en stream
  - `requireApiKey` : 401 sur routes inférence sans clé `sk-*` (exception : token admin `mock` pour `POST /admin/benchmark/chat-stream` uniquement)
  - `lmStudioResponses400` : `POST /v1/responses` → 400 `lm_studio_error`
- `resetState()` : remet seed + scénarios par défaut
- `getState()` : snapshot de l’état serveur mocké

## Test manuel rapide

1. Lancer avec `VITE_MOCK_API=1`, ouvrir le dashboard.
2. Parcourir chaque section du menu (Dashboard, Brain, Models, Scheduler, Benchmark, OpenBill, Config, Cloud, Routage, Utilisateurs, Logs, Statistiques).
3. Ouvrir la console : `window.__mercuryMock.scenarios.slotActive = true`
4. Aller sur **Benchmark** → Live Chat, envoyer un message → vérifier une erreur **503** / message slot (ou ajouter `X-Mock-Consumer: alice` dans une requête `fetch` manuelle pour voir le flux OK).

## Ajouter un handler

1. Si route `/admin/*` : étendre [`handlers/admin-routes.ts`](./handlers/admin-routes.ts) (ou extraire un module si > ~500 lignes).
2. Si autre préfixe : ajouter un `try*` dans [`mockRouter.ts`](./mockRouter.ts) avant le fallback 501.
3. Réutiliser [`http-helpers.ts`](./http-helpers.ts) (`json`, `errorJson`) pour rester compatible avec [`parseErrorResponse`](../api/errors.ts).

## Limitations

- Parité exacte avec le backend Mercury non garantie (champs optionnels manquants possibles).
- WebSocket `/v1/realtime` : stub minimal (pas de flux audio réel).
- `GET /healthz` : non utilisé par l’UI actuelle ; sert aux scénarios / tests console.
- Pas de mock pour requêtes **hors origine** de la page (autres domaines passent au `fetch` natif).
