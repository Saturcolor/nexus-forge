"""
DemoBackend — backend factice pour MERCURY_DEMO_MODE.

Permet de faire tourner Mercury sans aucun vrai modèle derrière : renvoie des
complétions OpenAI-compatibles « canned » (streaming + non-streaming). Branché
par `providers.get_backend("demo", ...)` et dispatché via `_dispatch_cloud_direct`
quand la variable d'environnement MERCURY_DEMO_MODE est définie.

But : démo / exploration par un agent. `curl /v1/chat/completions` répond
immédiatement, zéro GPU, zéro réseau. Le vrai code de routing/queue/API tourne ;
seul l'appel au modèle est remplacé.
"""
import asyncio
import json
import time
from typing import Any

from providers.base import BackendBase, BackendResult


def _extract_last_user(messages: list) -> str:
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user":
            content = m.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):  # blocs multimodaux (vision)
                parts = [
                    b.get("text", "")
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                ]
                return " ".join(p for p in parts if p)
    return ""


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


class DemoBackend(BackendBase):
    """Renvoie des réponses canned au format OpenAI chat.completions."""

    async def chat(self, body: dict, stream: bool) -> Any:
        model = body.get("model") or "demo-model"
        last_user = _extract_last_user(body.get("messages") or [])
        snippet = (last_user or "(aucun message user)").strip()
        if len(snippet) > 280:
            snippet = snippet[:280] + "…"
        reply = (
            "Mercury is running in DEMO_MODE — no real model is loaded. "
            f"This is a canned reply from the fake backend for model '{model}'. "
            f"Your last message was: \"{snippet}\"."
        )
        created = int(time.time())
        cmpl_id = "chatcmpl-demo"
        prompt_tokens = sum(len(str(m.get("content", ""))) for m in (body.get("messages") or [])) // 4
        completion_tokens = max(1, len(reply) // 4)
        usage = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }

        if stream:
            async def _gen():
                yield _sse({
                    "id": cmpl_id, "object": "chat.completion.chunk", "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                })
                for word in reply.split(" "):
                    await asyncio.sleep(0.015)
                    yield _sse({
                        "id": cmpl_id, "object": "chat.completion.chunk", "created": created,
                        "model": model,
                        "choices": [{"index": 0, "delta": {"content": word + " "}, "finish_reason": None}],
                    })
                yield _sse({
                    "id": cmpl_id, "object": "chat.completion.chunk", "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": usage,
                })
                yield "data: [DONE]\n\n"

            return _gen()

        return BackendResult(200, {
            "id": cmpl_id, "object": "chat.completion", "created": created, "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": reply},
                "finish_reason": "stop",
            }],
            "usage": usage,
        })
