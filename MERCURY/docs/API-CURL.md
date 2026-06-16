# Requêtes curl – Mercury

Base URL par défaut : `http://localhost:17890`  
Depuis Tailscale : `http://<machine-tailscale>:17890`

---

## Clé API et priorité

Chaque requête peut être identifiée par un **header Authorization** :

- **`Authorization: Bearer <api_key>`** : la clé associe la requête à un utilisateur (user_id) et à une **priorité** (1 = la plus haute). Les requêtes sont traitées par ordre de priorité puis FIFO.
- Sans header ou clé inconnue : la requête est traitée en **anonymous** avec la priorité la plus basse (99).

Les utilisateurs et leurs clés se gèrent depuis le **dashboard** (section « Users & clés API ») ou via les routes admin (voir § 6). La clé n’est affichée en clair qu’une seule fois à la création.

Remplacer `VOTRE_CLE_API` par la clé créée dans le dashboard (Users & clés API). Sans clé, la requête est traitée en anonymous (priorité 99).

```bash
curl -X POST http://localhost:17890/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer VOTRE_CLE_API" \
  -d '{"model": "ollama/llama3", "messages": [{"role": "user", "content": "Test"}], "stream": false}'
```

---

## 1. Chat completions (sans streaming) – Ollama

Envoie vers le backend **Ollama**. Le modèle `ollama/llama3` est routé vers Ollama ; le nom réel envoyé à Ollama est `llama3`.

```bash
curl -X POST http://localhost:17890/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer VOTRE_CLE_API" \
  -d '{"model": "ollama/llama3.2:1b", "messages": [{"role": "user", "content": "Dis bonjour en une phrase."}], "stream": false}'
```

Avec un modèle Ollama installé localement (ex. `qwen2.5:7b`) :

```bash
curl -X POST http://localhost:17890/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer VOTRE_CLE_API" \
  -d '{"model": "ollama/qwen2.5:7b", "messages": [{"role": "user", "content": "Quelle est la capitale de la France ?"}], "stream": false, "max_tokens": 200}'
```

---

## 2. Chat completions (sans streaming) – MLX

Envoie vers le backend **MLX**. Utiliser le préfixe `mlx/` dans le champ `model`.

```bash
curl -X POST http://localhost:17890/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer VOTRE_CLE_API" \
  -d '{"model": "mlx/qwen2.5-7b", "messages": [{"role": "user", "content": "Écris un haïku sur le code."}], "stream": false, "max_tokens": 150}'
```

*(Adapter le nom du modèle après `mlx/` à celui exposé par ton serveur MLX.)*

---

## 3. Chat completions avec streaming

Réponse en flux (Server-Sent Events). Idéal pour afficher le texte au fur et à mesure.

```bash
curl -X POST http://localhost:17890/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer VOTRE_CLE_API" \
  -d '{"model": "ollama/llama3", "messages": [{"role": "user", "content": "Compte de 1 à 5."}], "stream": true}'
```

---

## 4. Conversation multi-tours

Plusieurs messages (historique + nouvelle question).

```bash
curl -X POST http://localhost:17890/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer VOTRE_CLE_API" \
  -d '{"model": "ollama/llama3", "messages": [{"role": "user", "content": "Mon prénom est Alice."}, {"role": "assistant", "content": "D'\''accord, tu t'\''appelles Alice."}, {"role": "user", "content": "Quel est mon prénom ?"}], "stream": false}'
```

---

## 5. Paramètres optionnels

- **max_tokens** : limite de tokens en sortie (surtout pour OpenAI/MLX ; Ollama le mappe en interne).
- **temperature** : créativité (0 = déterministe, 1 = plus varié).

```bash
curl -X POST http://localhost:17890/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer VOTRE_CLE_API" \
  -d '{"model": "ollama/llama3", "messages": [{"role": "user", "content": "Invente un nom de projet."}], "stream": false, "max_tokens": 50, "temperature": 0.8}'
```

---

## 6. API Admin (dashboard)

Utile pour vérifier l’état de Mercury sans passer par l’interface web.

**Config actuelle**

```bash
curl -s http://localhost:17890/admin/config
```

**État de la file d’attente**

```bash
curl -s http://localhost:17890/admin/queue
```

**Statut des backends (Ollama / MLX)**

```bash
curl -s http://localhost:17890/admin/backends
```

**Logs** (sans paramètre = dernières requêtes en mémoire ; avec `date` = fichier du jour)

```bash
curl -s http://localhost:17890/admin/logs
curl -s "http://localhost:17890/admin/logs?date=2025-03-02"
```

**Stats d’utilisation** (par jour)

```bash
curl -s http://localhost:17890/admin/stats
curl -s "http://localhost:17890/admin/stats?date=2025-03-02"
```

**Dates disponibles** (fichiers de logs)

```bash
curl -s http://localhost:17890/admin/dates
```

**Users & clés API** (liste avec clé masquée ; création / modification / suppression via POST/PATCH/DELETE)

```bash
curl -s http://localhost:17890/admin/users
```

**Modèles disponibles (Ollama + MLX)**

Retourne les modèles listés par chaque backend, avec un `id` utilisable dans `model` pour `/v1/chat/completions` (ex. `ollama/llama3`, `mlx/qwen2.5-7b`).

```bash
curl -s http://localhost:17890/admin/models
```

Exemple de réponse :

```json
{
  "ollama": [
    { "id": "ollama/llama3", "name": "llama3", "size": 4835977234, "modified_at": "2025-01-15T12:00:00Z" }
  ],
  "mlx": [
    { "id": "mlx/qwen2.5-7b", "name": "qwen2.5-7b" }
  ]
}
```

Si un backend est injoignable, la clé `ollama_error` ou `mlx_error` contient le message d'erreur.

---

## 7. Variable d’environnement pour la base URL

Pour tester vers une autre machine (ex. Tailscale) :

```bash
export MERCURY_URL="http://100.x.x.x:17890"

curl -X POST $MERCURY_URL/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer VOTRE_CLE_API" \
  -d '{"model": "ollama/llama3", "messages": [{"role": "user", "content": "Test"}], "stream": false}'
```

---

## Rappel routage

| Préfixe dans `model` | Backend |
|----------------------|--------|
| `ollama/...`         | Ollama (port 11434 par défaut) |
| `mlx/...`            | MLX (port 8080 par défaut) |
| Sans préfixe         | Ollama (défaut) |

Le port du middleware est configurable dans `config.yaml` (`server_port`, défaut 17890).
