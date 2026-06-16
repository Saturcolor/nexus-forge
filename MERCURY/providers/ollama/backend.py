"""
Backend Ollama : POST {base_url}/api/chat
Adapte le format OpenAI -> Ollama et le flux stream -> SSE OpenAI.
"""
import json
import logging
from typing import AsyncIterator

import httpx

from providers.base import BackendBase, BackendResult, BackendRequestFailed
from providers.ollama.last_metrics import set_last_metrics
from utils.debug import debug_json

logger = logging.getLogger(__name__)

# Typage des options pour l'API Ollama (partagé backend + proxy).
_OLLAMA_OPTIONS_INT = frozenset({"num_predict", "num_ctx", "num_gpu", "top_k", "seed"})
_OLLAMA_OPTIONS_FLOAT = frozenset({"temperature", "top_p", "repeat_penalty"})


def coerce_ollama_options(options: dict) -> dict:
    """Typage des options pour l'API Ollama (ex. top_k en int, temperature en float)."""
    if not options:
        return {}
    out = {}
    for k, v in options.items():
        if v is None:
            continue
        k_lower = k.lower()
        if k_lower in _OLLAMA_OPTIONS_INT:
            try:
                out[k] = int(float(v))
            except (TypeError, ValueError):
                out[k] = v
        elif k_lower in _OLLAMA_OPTIONS_FLOAT:
            try:
                out[k] = float(v)
            except (TypeError, ValueError):
                out[k] = v
        else:
            out[k] = v
    return out


class OllamaBackend(BackendBase):
    def __init__(self, base_url: str, timeout: float = 300.0):
        super().__init__(base_url, timeout)
        self.chat_url = f"{self.base_url}/api/chat"

    def _openai_to_ollama_body(self, body: dict) -> dict:
        """Convertit le body OpenAI-like en format Ollama."""
        messages = self._openai_to_messages(body)
        model = body.get("model", "llama3")
        # Enlever le préfixe ollama/ pour le nom de modèle envoyé à Ollama
        if model.startswith("ollama/"):
            model = model[7:]
        out = {
            "model": model,
            "messages": messages,
            "stream": body.get("stream", False),
        }
        options = {}
        if "max_tokens" in body:
            options["num_predict"] = body["max_tokens"]
        if "temperature" in body:
            options["temperature"] = body["temperature"]
        if body.get("options"):
            options.update(body["options"])
        if options:
            out["options"] = coerce_ollama_options(options)
        return out

    def _ollama_chunk_to_openai_sse(self, line: str) -> str | None:
        """Convertit une ligne JSON Ollama en ligne SSE OpenAI (data: {...})."""
        line = line.strip()
        if not line:
            return None
        try:
            obj = json.loads(line)
            # Ollama stream: message.content (delta), done, etc.
            # OpenAI SSE: choices[0].delta.content
            delta = {}
            if "message" in obj and "content" in obj["message"]:
                delta["content"] = obj["message"]["content"]
            if "done" in obj and obj["done"]:
                delta = {}  # final chunk souvent vide
            sse_obj = {
                "id": "ollama",
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": delta, "finish_reason": "stop" if obj.get("done") else None}],
            }
            return f"data: {json.dumps(sse_obj)}\n\n"
        except json.JSONDecodeError:
            return None

    async def chat(self, body: dict, stream: bool):
        from routing.router import get_config
        ollama_body = self._openai_to_ollama_body(body)
        if get_config().get("debug"):
            js = json.dumps(ollama_body, ensure_ascii=False)
            logger.info("DEBUG [ollama] envoyé: %s", (js[:4000] + "...") if len(js) > 4000 else js)

        if not stream:
            ollama_body["stream"] = False
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(self.chat_url, json=ollama_body)
                if resp.status_code >= 400:
                    err = (resp.text or str(resp.status_code))[:500]
                    logger.warning(
                        "Ollama /api/chat erreur %s: %s",
                        resp.status_code,
                        err,
                    )
                    if get_config().get("debug"):
                        try:
                            err_data = resp.json()
                        except Exception:
                            err_data = resp.text or ""
                        logger.info("DEBUG [ollama] reçu (non-stream, erreur): %s", debug_json(err_data if isinstance(err_data, dict) else {"_raw": str(err_data)[:2000]}))
                    raise BackendRequestFailed(resp.status_code, err)
                data = resp.json()
                if get_config().get("debug"):
                    logger.info("DEBUG [ollama] reçu (non-stream): %s", debug_json(data))
                set_last_metrics(data)
                # Adapter la réponse Ollama -> format OpenAI completions
                openai_style = self._ollama_response_to_openai(data)
                return BackendResult(resp.status_code, openai_style)

        # Stream: lire le flux Ollama (newline-delimited JSON) et émettre en SSE OpenAI
        async def stream_generator():
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                async with client.stream("POST", self.chat_url, json=ollama_body) as resp:
                    if resp.status_code >= 400:
                        err_body = (await resp.aread()).decode("utf-8", errors="replace")
                        err = err_body[:500]
                        logger.warning(
                            "Ollama /api/chat erreur %s (stream): %s",
                            resp.status_code,
                            err,
                        )
                        if get_config().get("debug"):
                            try:
                                err_data = json.loads(err_body)
                            except json.JSONDecodeError:
                                err_data = {"_raw": err_body[:2000]}
                            logger.info("DEBUG [ollama] reçu (stream, erreur): %s", debug_json(err_data))
                        raise BackendRequestFailed(resp.status_code, err)
                    buffer = ""
                    async for chunk in resp.aiter_text():
                        buffer += chunk
                        while "\n" in buffer:
                            line, buffer = buffer.split("\n", 1)
                            line = line.strip()
                            if line:
                                try:
                                    obj = json.loads(line)
                                    if isinstance(obj, dict) and obj.get("done"):
                                        set_last_metrics(obj)
                                        if get_config().get("debug"):
                                            logger.info("DEBUG [ollama] reçu (stream, ligne done): %s", debug_json(obj))
                                except json.JSONDecodeError:
                                    pass
                            sse = self._ollama_chunk_to_openai_sse(line)
                            if sse:
                                yield sse
                    if buffer.strip():
                        line = buffer.strip()
                        try:
                            obj = json.loads(line)
                            if isinstance(obj, dict) and obj.get("done"):
                                set_last_metrics(obj)
                                if get_config().get("debug"):
                                    logger.info("DEBUG [ollama] reçu (stream, buffer done): %s", debug_json(obj))
                        except json.JSONDecodeError:
                            pass
                        sse = self._ollama_chunk_to_openai_sse(line)
                        if sse:
                            yield sse
                    yield "data: [DONE]\n\n"

        return stream_generator()

    def _ollama_response_to_openai(self, data: dict) -> dict:
        """Convertit la réponse non-stream Ollama en format OpenAI."""
        message = data.get("message", {})
        content = message.get("content", "")
        eval_count = data.get("eval_count", 0)
        if isinstance(eval_count, dict):
            eval_count = eval_count.get("count", 0)
        return {
            "id": "ollama-" + data.get("id", "unknown"),
            "object": "chat.completion",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": data.get("prompt_eval_count", 0),
                "completion_tokens": eval_count,
                "total_tokens": data.get("prompt_eval_count", 0) + eval_count,
            },
        }
