"""
Handler chat Ollama : stream et requête sync.
"""
import json
import logging

import httpx

from providers.base import BackendRequestFailed
from providers.ollama.last_metrics import set_last_metrics

logger = logging.getLogger(__name__)


def _ollama_response_to_usage(obj: dict) -> tuple[dict, float | None]:
    """Construit usage normalisé + duration_ms à partir d'une réponse Ollama (prompt_eval_count, eval_count, eval_duration ns)."""
    usage = {}
    inp = obj.get("prompt_eval_count")
    out = obj.get("eval_count")
    eval_duration_ns = obj.get("eval_duration")
    if inp is not None:
        usage["input_tokens"] = int(inp)
    if out is not None:
        usage["output_tokens"] = int(out)
    if eval_duration_ns is not None and eval_duration_ns > 0 and out is not None:
        usage["tokens_per_second"] = round(out / (eval_duration_ns / 1e9), 2)
    duration_ms = (eval_duration_ns / 1e6) if eval_duration_ns is not None else None
    return usage, duration_ms


async def stream_ollama_chat(
    client: httpx.AsyncClient,
    url: str,
    forward_body: dict,
    canonical_model: str,
    config: dict,
    request_id: str,
    user_id: str,
    backend: str,
    log_api_request,
    debug_json_fn,
):
    """Génère les chunks NDJSON du chat Ollama (stream)."""
    stream_logged = False
    accumulated_content: list[str] = []  # pour log debug de la réponse complète en fin de stream
    try:
        async with client.stream("POST", f"{url}/api/chat", json=forward_body) as resp:
            if resp.status_code != 200:
                err_text = await resp.aread()
                err_msg = err_text.decode("utf-8", errors="replace")[:500]
                log_api_request(request_id, user_id, canonical_model, backend, str(resp.status_code), None, err_msg)
                raise BackendRequestFailed(resp.status_code, err_msg)
            buffer = ""
            async for chunk in resp.aiter_text():
                buffer += chunk
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    obj = dict(obj)
                    if "response" in obj:
                        content = obj.pop("response", "") or ""
                        accumulated_content.append(content)
                        obj.setdefault("message", {})["role"] = "assistant"
                        obj["message"]["content"] = content
                    if "model" not in obj or not obj.get("model"):
                        obj["model"] = canonical_model
                    if config.get("debug") and obj.get("done"):
                        full_reply = "".join(accumulated_content)
                        preview = (full_reply[:500] + "...") if len(full_reply) > 500 else full_reply
                        logger.info("DEBUG [api/chat] réponse ollama (stream, %d chars): %s", len(full_reply), preview)
                    if obj.get("done"):
                        # Chunk final avec content vide pour éviter doublon (client a déjà accumulé les deltas)
                        if "message" in obj and isinstance(obj["message"], dict):
                            obj["message"]["content"] = ""
                        set_last_metrics(obj)
                        try:
                            usage, duration_ms = _ollama_response_to_usage(obj)
                            log_api_request(
                                request_id, user_id, canonical_model, backend, "ok", duration_ms, None,
                                usage=usage if usage else None,
                            )
                        except Exception as e:
                            logger.warning("Ollama stream fin (log): %s", e)
                            log_api_request(request_id, user_id, canonical_model, backend, "ok")
                        stream_logged = True
                    yield json.dumps(obj, ensure_ascii=False) + "\n"
            if buffer.strip():
                try:
                    obj = json.loads(buffer.strip())
                    obj = dict(obj)
                    if "response" in obj:
                        content = obj.pop("response", "") or ""
                        accumulated_content.append(content)
                        obj.setdefault("message", {})["role"] = "assistant"
                        obj["message"]["content"] = content
                    if "model" not in obj or not obj.get("model"):
                        obj["model"] = canonical_model
                    if config.get("debug") and obj.get("done"):
                        full_reply = "".join(accumulated_content)
                        preview = (full_reply[:500] + "...") if len(full_reply) > 500 else full_reply
                        logger.info("DEBUG [api/chat] réponse ollama (stream buffer, %d chars): %s", len(full_reply), preview)
                    if obj.get("done"):
                        if "message" in obj and isinstance(obj["message"], dict):
                            obj["message"]["content"] = ""
                        set_last_metrics(obj)
                        try:
                            usage, duration_ms = _ollama_response_to_usage(obj)
                            log_api_request(
                                request_id, user_id, canonical_model, backend, "ok", duration_ms, None,
                                usage=usage if usage else None,
                            )
                        except Exception as e:
                            logger.warning("Ollama stream fin buffer (log): %s", e)
                            log_api_request(request_id, user_id, canonical_model, backend, "ok")
                        stream_logged = True
                    yield json.dumps(obj, ensure_ascii=False) + "\n"
                except json.JSONDecodeError:
                    pass
            if not stream_logged:
                logger.info("Ollama stream terminé sans chunk done:true, log minimal")
                log_api_request(request_id, user_id, canonical_model, backend, "ok")
                stream_logged = True
    finally:
        if not stream_logged:
            try:
                log_api_request(request_id, user_id, canonical_model, backend, "ok")
            except Exception as e:
                logger.warning("Ollama stream finally (log): %s", e)


async def request_ollama_chat_sync(
    client: httpx.AsyncClient,
    url: str,
    forward_body: dict,
    canonical_model: str,
    config: dict,
    request_id: str,
    user_id: str,
    backend: str,
    log_api_request,
    debug_json_fn,
):
    """Requête Ollama non-stream. Retourne le dict ou lève HTTPException."""
    from fastapi import HTTPException

    r = await client.post(f"{url}/api/chat", json=forward_body)
    if r.status_code != 200:
        detail = (r.text or str(r.status_code))[:500]
        log_api_request(request_id, user_id, canonical_model, backend, str(r.status_code), None, detail)
        raise HTTPException(status_code=r.status_code, detail=detail)
    data = r.json()
    if config.get("debug"):
        logger.info("DEBUG [api/chat] reçu ollama (non-stream): %s", debug_json_fn(data))
    if "response" in data and "message" not in data:
        data = dict(data)
        data["message"] = {"role": "assistant", "content": data.get("response", "")}
        del data["response"]
    data["model"] = canonical_model
    set_last_metrics(data)
    usage, duration_ms = _ollama_response_to_usage(data)
    log_api_request(
        request_id, user_id, canonical_model, backend, "ok", duration_ms, None,
        usage=usage if usage else None,
    )
    return data
