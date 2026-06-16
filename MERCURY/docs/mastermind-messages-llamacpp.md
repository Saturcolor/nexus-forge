# Mastermind → Mercury → llama.cpp : séquence de messages

Mastermind ne définit **pas** `llamacpp_normalize_messages` : ce flag est lu uniquement par Mercury ([`providers/llamacpp/backend.py`](../providers/llamacpp/backend.py)) avant l’appel au daemon.

## Construction côté Mastermind

Fichier : `MASTERMIND/packages/backend/src/modules/agent/run.ts`.

1. Premier message : `role: system`, contenu = `assembleSystemPrompt(...)`.
2. Historique DB : `toAiMessage` — `assistant` avec `tool_calls` dans les métadonnées, `tool` avec `tool_call_id`, etc.
3. Boucle outils : un tour `assistant` (texte + `tool_calls`) puis un ou plusieurs `tool`, puis nouveau tour.

En pratique, la forme ressemble à : `system`, `user`, …, `assistant`+tools, `tool`×n, `assistant`, `user`, …

## Pourquoi Mercury normalise

Les templates Jinja de certains GGUF (Mistral, Qwen…) exigent une **alternance stricte** user/assistant en dehors des blocs tool. Des cas comme `tool` → `user` sans message `assistant` intermédiaire, ou deux `user` / deux `assistant` consécutifs (ex. contenu non fusionnable), provoquent une erreur 500 côté llama-server.

La normalisation Mercury insère des messages « pont » (`content: " "`) et fusionne les messages texte consécutifs du même rôle lorsque c’est possible.
