# Stateful (LM Studio) — doc de référence

Documentation de référence LM Studio sur le mode stateful. Notre proxy utilise **POST /v1/responses** (API OpenAI Responses), qui reprend la même logique : `response_id` renvoyé par LM Studio, puis `previous_response_id` dans la requête suivante pour ne pas renvoyer tout l’historique. **Bug connu (corrigé en 0.3.32)** : les 400 `previous_response_not_found` même quelques secondes après la réponse venaient d’un bug LM Studio : l’historique est bien persisté sur disque, mais la relecture du fichier pack échouait (erreur Zod sur `toolCallRequest.arguments`), donc le nœud était considéré introuvable. Voir [issue #1188](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1188). **À faire** : utiliser LM Studio **0.3.32 ou plus récent** (beta ou stable). Voir aussi [analyse-log-lmstudio.md](analyse-log-lmstudio.md).

---

The `/api/v1/chat` endpoint is stateful by default. This means you don't need to pass the full conversation history in every request — LM Studio automatically stores and manages the context for you.

## How it works

When you send a chat request, LM Studio stores the conversation in a chat thread and returns a `response_id` in the response. Use this `response_id` in subsequent requests to continue the conversation.

```lms_code_snippet
title: Start a new conversation
variants:
  curl:
    language: bash
    code: |
      curl http://localhost:1234/api/v1/chat \
        -H "Authorization: Bearer $LM_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{
          "model": "ibm/granite-4-micro",
          "input": "My favorite color is blue."
        }'
```

The response includes a `response_id`:

```lms_info
Every response includes an unique `response_id` that you can use to reference that specific point in the conversation for future requests. This allows you to branch conversations.
```

```lms_code_snippet
title: Response
variants:
  response:
    language: json
    code: |
      {
        "model_instance_id": "ibm/granite-4-micro",
        "output": [
          {
            "type": "message",
            "content": "That's great! Blue is a beautiful color..."
          }
        ],
        "response_id": "resp_abc123xyz..."
      }
```

## Continue a conversation

Pass the `previous_response_id` in your next request to continue the conversation. The model will remember the previous context.



```lms_code_snippet
title: Continue the conversation
variants:
  curl:
    language: bash
    code: |
      curl http://localhost:1234/api/v1/chat \
        -H "Authorization: Bearer $LM_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{
          "model": "ibm/granite-4-micro",
          "input": "What color did I just mention?",
          "previous_response_id": "resp_abc123xyz..."
        }'
```

The model can reference the previous message without you needing to resend it and will return a new `response_id` for further continuation.

## Disable stateful storage

If you don't want to store the conversation, set `store` to `false`. The response will not include a `response_id`.

```lms_code_snippet
title: Stateless chat
variants:
  curl:
    language: bash
    code: |
      curl http://localhost:1234/api/v1/chat \
        -H "Authorization: Bearer $LM_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{
          "model": "ibm/granite-4-micro",
          "input": "Tell me a joke.",
          "store": false
        }'
```

This is useful for one-off requests where you don't need to maintain context.
