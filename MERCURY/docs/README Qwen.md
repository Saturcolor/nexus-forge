# Qwen3.5 pour coding agents (sudoingX setup)
Récupéré le 2026-03-07 depuis tweet [2030253886649569299](https://x.com/sudoingX/status/2030253886649569299)

## Tweet complet
```
if you're running Qwen 3.5 on any coding agent (OpenCode, Claude Code) you will hit a jinja template crash. the model rejects the developer role that every modern agent sends.

people asked for the full template. here it is. two paths depending on which model you're running:

path 1: patch base Qwen's template. 
add developer role handling + keep thinking mode alive. 

full command:
llama-server -m Qwen3.5-27B-Q4_K_M.gguf -ngl 99 -c 262144 -np 1 -fa on --cache-type-k q4_0 --cache-type-v q4_0 --chat-template-file qwen3.5_chat_template.jinja

template file: https://gist.github.com/sudoingX/c2facf7d8f7608c65c1024ef3b22d431

without the patched template, --chat-template chatml silently kills thinking. server shows thinking = 0.
no reasoning. no think blocks. check your logs.

path 2: run Qwopus instead.
Qwen3.5-27B with Claude Opus 4.6 reasoning distilled in. the jinja bug doesn't exist on this model. thinking mode works natively. no patched template needed. same speed, same VRAM, better autonomous behavior on coding agents.

weights: https://huggingface.co/Jackrong/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF

both fit on a single RTX 3090. 16.5 GB. 29-35 tok/s. 262K context.
```

## Commande complète
```
llama-server -m Qwen3.5-27B-Q4_K_M.gguf -ngl 99 -c 262144 -np 1 -fa on --cache-type-k q4_0 --cache-type-v q4_0 --chat-template-file qwen3.5_chat_template.jinja
```

## Fichiers
- `qwen3.5_chat_template.jinja` : Template patché pour developer role + thinking mode (de https://gist.github.com/sudoingX/c2facf7d8f7608c65c1024ef3b22d431)
- `hf-model/` : Clone HF repo [Jackrong/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF](https://huggingface.co/Jackrong/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF) (git lfs pull pour les GGUF lourds)
```
