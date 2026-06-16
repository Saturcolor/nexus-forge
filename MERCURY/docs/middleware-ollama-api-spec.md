# Middleware Ollama-Compatible - Spécifications API

**Objectif:** Créer un middleware qui expose une API Ollama-compatible pour Le client, avec switch de modèles LM Studio à la volée.

## Authentification

Le client envoie la clé API dans le header `Authorization`:

```http
Authorization: Bearer <apiKey>
```

**Exemple:**
```http
GET /api/tags
Authorization: Bearer middleware-secret-key
```

**Vérification dans le middleware:**

```python
# Python/FastAPI
auth_header = request.headers.get("Authorization")
if auth_header != f"Bearer {EXPECTED_API_KEY}":
    return JSONResponse(status_code=401, content={"error": "Unauthorized"})
```

```javascript
// Node/Express
const auth = req.headers['authorization'];
if (auth !== `Bearer ${process.env.API_KEY}`) {
    return res.status(401).send('Unauthorized');
}
```

---

## Endpoints à implémenter

### 1. GET /api/tags
Liste les modèles disponibles.

**Request:**
```http
GET /api/tags
```

**Response:**
```json
{
  "models": [
    {
      "name": "qwen:7b",
      "modified_at": "2026-03-03T10:00:00Z",
      "size": 4320000000
    },
    {
      "name": "qwen:72b",
      "modified_at": "2026-03-03T10:00:00Z", 
      "size": 43200000000
    }
  ]
}
```

**Notes:**
- `name`: ID du modèle (format `nom:tag`)
- `modified_at`: ISO 8601 timestamp
- `size`: taille en bytes

---

### 2. POST /api/chat
Chat avec streaming.

**Request:**
```http
POST /api/chat
Content-Type: application/json

{
  "model": "qwen:72b",
  "messages": [
    {"role": "user", "content": "Dis bonjour"}
  ],
  "stream": true,
  "options": {
    "temperature": 0.7
  }
}
```

**Response (streaming):**
```
data: {"model":"qwen:72b","created_at":"2026-03-03T10:00:00Z","message":{"role":"assistant","content":"Bon"},"done":false}

data: {"model":"qwen:72b","created_at":"2026-03-03T10:00:01Z","message":{"role":"assistant","content":"jour"},"done":false}

data: {"model":"qwen:72b","created_at":"2026-03-03T10:00:02Z","message":{"role":"assistant","content":"!"},"done":true,"total_duration":1234567890}
```

**Format des chunks:**
- `model`: ID du modèle utilisé
- `created_at`: timestamp ISO 8601
- `message.role`: toujours "assistant"
- `message.content`: morceau de texte
- `done`: `true` quand c'est fini
- `total_duration`: durée totale en nanosecondes (optionnel)

---

### 3. POST /api/show (optionnel)
Infos détaillées sur un modèle.

**Request:**
```http
POST /api/show
Content-Type: application/json

{
  "name": "qwen:72b"
}
```

**Response:**
```json
{
  "modelfile": "FROM qwen:72b",
  "parameters": "temperature 0.7",
  "template": "{{ .System }} {{ .Prompt }}",
  "details": {
    "format": "gguf",
    "family": "qwen2",
    "parameter_size": "72B"
  }
}
```

---

## Workflow du middleware

```
Le client → GET /api/tags → Middleware retourne liste modèles LM Studio
                ↓
Le client → POST /api/chat (model: qwen:72b)
                ↓
Middleware vérifie si qwen:72b chargé
    ├─ Oui → Forward à LM Studio → Stream réponse
    └─ Non → Charge qwen:72b dans LM Studio → Attente → Stream réponse
```

## Config Le client

```json5
{
  models: {
    providers: {
      ollama: {
        enabled: true,
        baseUrl: "http://localhost:11434",  // Ton middleware
        apiKey: "middleware-secret-key",    // Clé pour auth Bearer
        api: "ollama-native",
        models: [
          {
            id: "qwen:7b",
            name: "Qwen 7B",
            contextWindow: 32768
          },
          {
            id: "qwen:72b", 
            name: "Qwen 72B",
            contextWindow: 32768
          }
        ]
      }
    }
  }
}
```

## Communication LM Studio

LM Studio expose une API interne (non documentée officiellement) :

**Charger un modèle:**
```http
POST http://localhost:1234/v1/models/load
Content-Type: application/json

{
  "model": "qwen:72b"
}
```

**Vérifier modèle chargé:**
```http
GET http://localhost:1234/v1/models/current
```

**Décharger:**
```http
POST http://localhost:1234/v1/models/unload
```

> **Note:** Ces endpoints LM Studio peuvent varier selon les versions. À vérifier avec les dev tools du navigateur quand tu es sur l'UI LM Studio.

## Gestion du chargement

**Option 1: Réponse immédiate + retry**
```
Le client: "Dis bonjour"
Middleware: "Chargement de qwen:72b... (10s)" → répond immédiatement
[utilisateur attend]
Le client: "Dis bonjour" (2ème fois)
Middleware: modèle déjà chargé → réponse normale
```

**Option 2: Keep-alive + stream d'attente**
```
Le client: "Dis bonjour"
Middleware: garde connexion ouverte
    → stream: "Chargement..."
    → [charge modèle]
    → stream: "Bonjour !"
```

**Option 3: Pré-chargement intelligent**
- Middleware garde les 2-3 modèles les plus utilisés en mémoire
- Switch rapide quand Le client demande un autre

## Stack suggéré

**Backend:**
- Python + FastAPI (async, streaming natif)
- Ou Node.js + Express (EventSource pour streaming)

**Frontend (optionnel):**
- TypeScript + React ou Vue
- Voir quel modèle est chargé
- Boutons pré-chargement manuel

## Ressources

- Doc Ollama API: https://github.com/ollama/ollama/blob/main/docs/api.md

---
*Document créé le 2026-03-03*
