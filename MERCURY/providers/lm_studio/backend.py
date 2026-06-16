"""
Backend LM Studio : POST {base_url}/api/v1/chat (API native).
Convertit OpenAI -> LM Studio natif et réponse/stream LM Studio -> OpenAI.
"""
import json
import logging
import time
from typing import Any

import httpx

from providers.base import BackendBase, BackendResult
from providers.lm_studio.last_metrics import update_metrics
from utils.debug import debug_json

logger = logging.getLogger(__name__)


class LMStudioBackend(BackendBase):
    def __init__(self, base_url: str, timeout: float = 300.0):
        super().__init__(base_url, timeout)
        self.chat_url = f"{self.base_url}/api/v1/chat"
        self.load_url = f"{self.base_url}/api/v1/models/load"

    def _openai_to_lm_studio_body(self, body: dict) -> dict:
        """Convertit le body OpenAI (messages, model, stream, ...) en format LM Studio natif."""
        messages = self._openai_to_messages(body)
        model = (body.get("model") or "").strip()
        if model.startswith("lm_studio/"):
            model = model[10:]
        system_prompt = ""
        input_parts = []
        for m in messages:
            role = (m.get("role") or "").strip().lower()
            content = m.get("content")
            if role == "system":
                if isinstance(content, str):
                    system_prompt = content
                elif isinstance(content, list):
                    system_prompt = " ".join(
                        p.get("text", "") if isinstance(p, dict) else str(p)
                        for p in content
                    )
                else:
                    system_prompt = str(content or "")
            elif role == "user":
                if isinstance(content, str):
                    input_parts.append({"type": "message", "content": content})
                elif isinstance(content, list):
                    for p in content:
                        if isinstance(p, dict):
                            if p.get("type") == "text" and "text" in p:
                                input_parts.append({"type": "message", "content": p["text"]})
                            elif p.get("type") == "image_url" and "image_url" in p:
                                url = p["image_url"].get("url") if isinstance(p["image_url"], dict) else p["image_url"]
                                if isinstance(url, str) and url.startswith("data:"):
                                    input_parts.append({"type": "image", "data_url": url})
                                else:
                                    input_parts.append({"type": "message", "content": f"[image: {url}]"})
                        else:
                            input_parts.append({"type": "message", "content": str(p)})
                else:
                    input_parts.append({"type": "message", "content": str(content or "")})
        if not input_parts:
            input_parts.append({"type": "message", "content": ""})
        # LM Studio input: string (single message) or array of {type, content} / {type, data_url}
        if len(input_parts) == 1 and input_parts[0].get("type") == "message":
            input_val = input_parts[0].get("content", "")
        else:
            input_val = input_parts

        out = {
            "model": model,
            "input": input_val,
            "stream": body.get("stream", False),
        }
        if system_prompt:
            out["system_prompt"] = system_prompt
        if "temperature" in body and body["temperature"] is not None:
            out["temperature"] = float(body["temperature"])
        if "max_tokens" in body and body["max_tokens"] is not None:
            out["max_output_tokens"] = int(body["max_tokens"])
        # LM Studio: reasoning ("off" | "low" | "medium" | "high" | "on"). Le client peut envoyer reasoning ou thinking.
        r = body.get("reasoning") if body.get("reasoning") is not None else body.get("thinking")
        if r is not None:
            if isinstance(r, bool):
                out["reasoning"] = "on" if r else "off"
            else:
                s = str(r).strip().lower()
                if s in ("off", "low", "medium", "high", "on"):
                    out["reasoning"] = s
                elif s in ("true", "1", "yes"):
                    out["reasoning"] = "on"
                elif s in ("false", "0", "no", ""):
                    out["reasoning"] = "off"
                else:
                    out["reasoning"] = "on"
        if "reasoning" not in out:
            # Config globale lm_studio_reasoning (fallback si le client ne l'envoie pas)
            from routing.router import get_config
            global_r = get_config().get("lm_studio_reasoning")
            if global_r is not None and str(global_r).strip():
                s = str(global_r).strip().lower()
                if s in ("off", "low", "medium", "high", "on"):
                    out["reasoning"] = s
                elif s in ("true", "1", "yes"):
                    out["reasoning"] = "on"
                else:
                    out["reasoning"] = "off" if s in ("false", "0", "no", "") else "on"
        return out

    def _lm_studio_response_to_openai(self, data: dict) -> dict:
        """Convertit la réponse non-stream LM Studio (output, stats) en format OpenAI."""
        output = data.get("output") or []
        content_parts = []
        for item in output:
            if isinstance(item, dict):
                if item.get("type") == "message" and "content" in item:
                    content_parts.append(item["content"])
                elif item.get("type") == "reasoning" and "content" in item:
                    content_parts.append(item["content"])
        content = "".join(content_parts)
        stats = data.get("stats") or {}
        input_tokens = stats.get("input_tokens", 0)
        total_output = stats.get("total_output_tokens", 0)
        return {
            "id": "lmstudio-" + (data.get("response_id") or "unknown")[:16],
            "object": "chat.completion",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": input_tokens,
                "completion_tokens": total_output,
                "total_tokens": input_tokens + total_output,
            },
        }

    async def _ensure_model_loaded(self, client: httpx.AsyncClient, model: str) -> None:
        """Optionnel : charge le modèle si pas déjà chargé (ignore les erreurs)."""
        try:
            await client.post(self.load_url, json={"model": model}, timeout=60.0)
        except Exception:
            pass

    async def chat(self, body: dict, stream: bool):
        from routing.router import get_config
        ls_body = self._openai_to_lm_studio_body(body)
        model_id = ls_body.get("model", "")
        if get_config().get("debug"):
            js = json.dumps(ls_body, ensure_ascii=False)
            logger.info("DEBUG [lm_studio] envoyé: %s", (js[:4000] + "...") if len(js) > 4000 else js)

        if not stream:
            t0 = time.monotonic()
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                await self._ensure_model_loaded(client, model_id)
                ls_body["stream"] = False
                resp = await client.post(self.chat_url, json=ls_body)
                try:
                    data = resp.json()
                except Exception:
                    data = {"error": resp.text}
                if get_config().get("debug"):
                    logger.info("DEBUG [lm_studio] reçu (non-stream): %s", debug_json(data))
                if resp.status_code != 200:
                    return BackendResult(resp.status_code, data)
                openai_style = self._lm_studio_response_to_openai(data)
                duration = time.monotonic() - t0
                update_metrics(openai_style.get("usage"), duration)
                return BackendResult(200, openai_style)

        # Stream: client doit rester ouvert pendant toute la consommation du générateur
        async def stream_gen():
            client = httpx.AsyncClient(timeout=self.timeout)
            try:
                await self._ensure_model_loaded(client, model_id)
                async with client.stream("POST", self.chat_url, json=ls_body) as resp:
                    if resp.status_code != 200:
                        err = await resp.aread()
                        err_text = err.decode("utf-8", errors="replace")
                        if get_config().get("debug"):
                            try:
                                err_data = json.loads(err_text)
                            except json.JSONDecodeError:
                                err_data = {"_raw": err_text[:2000]}
                            logger.info("DEBUG [lm_studio] reçu (stream, erreur): %s", debug_json(err_data))
                        yield f"data: {json.dumps({'error': {'message': err_text[:500]}})}\n\n"
                        # Sans [DONE], le client SSE attend indéfiniment des chunks supplémentaires.
                        yield "data: [DONE]\n\n"
                        return
                    buffer = ""
                    current_event = None
                    async for chunk in resp.aiter_text():
                        buffer += chunk
                        while "\n" in buffer:
                            line, buffer = buffer.split("\n", 1)
                            raw = line
                            line = line.strip()
                            if line.startswith("event:"):
                                current_event = line[6:].strip()
                                continue
                            if line.startswith("data:"):
                                data_str = line[5:].strip()
                                if data_str == "[DONE]":
                                    yield "data: [DONE]\n\n"
                                    current_event = None
                                    continue
                                try:
                                    evt = json.loads(data_str)
                                except json.JSONDecodeError:
                                    current_event = None
                                    continue
                                if current_event == "message.delta" or (current_event is None and evt.get("content") is not None):
                                    delta = evt.get("content", "") if isinstance(evt.get("content"), str) else ""
                                    if delta:
                                        sse = {
                                            "id": "lmstudio",
                                            "object": "chat.completion.chunk",
                                            "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}],
                                        }
                                        yield f"data: {json.dumps(sse)}\n\n"
                                if current_event == "chat.end" or (evt.get("stats") is not None and evt.get("output") is not None):
                                    if get_config().get("debug"):
                                        logger.info("DEBUG [lm_studio] reçu (stream, fin): %s", debug_json(evt))
                                    yield "data: [DONE]\n\n"
                                    current_event = None
                                    return
                                current_event = None
                    yield "data: [DONE]\n\n"
            finally:
                await client.aclose()

        return stream_gen()
