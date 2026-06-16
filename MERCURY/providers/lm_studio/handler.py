"""
Handler chat LM Studio : construction du body, stream, requête sync, reasoning on/off.
"""
import json
import logging
from datetime import datetime, timezone

import httpx

from providers.base import BackendRequestFailed
from data import db as db_module
from utils.prompt import parse_runtime_from_system_prompt, reasoning_from_system_prompt

logger = logging.getLogger(__name__)


def norm_reasoning(val) -> str | None:
    """Normalise reasoning (bool/string) -> 'on'|'off'|'low'|'medium'|'high'."""
    if val is None:
        return None
    if isinstance(val, bool):
        return "on" if val else "off"
    r = str(val).strip().lower()
    if r in ("off", "low", "medium", "high", "on"):
        return r
    if r in ("true", "1", "yes"):
        return "on"
    if r in ("false", "0", "no", ""):
        return "off"
    return "on"


def is_reasoning_on_off_error(err_text: str) -> bool:
    """True si le message d'erreur LM Studio indique que le reasoning low/medium/high n'est pas supporté (on/off seulement)."""
    if not err_text:
        return False
    lower = err_text.lower()
    if "reasoning" not in lower:
        return False
    # Détection exacte : message LM Studio connu
    normalized = err_text.replace('"', "'").lower()
    if "supported settings:" in lower and "'on', 'off'" in normalized:
        return True
    # Fallback plus souple : 400 mentionnant reasoning + on/off dans le même message
    if "on/off" in lower or ("'on'" in normalized and "'off'" in normalized):
        logger.debug("is_reasoning_on_off_error: détection souple pour: %s", err_text[:200])
        return True
    return False


def _ls_body_without_reasoning(ls_body: dict) -> dict:
    """Copie du body sans la clé reasoning (pour retry quand le modèle ne supporte pas le param)."""
    out = {k: v for k, v in ls_body.items() if k != "reasoning"}
    return out


def build_lm_studio_body(
    body: dict,
    model: str,
    model_id: str,
    system_prompt: str,
    input_val: str,
    config: dict,
    debug_json_fn,
) -> dict:
    """Construit le body LM Studio (model, input, system_prompt, temperature, max_output_tokens, reasoning)."""
    stream = body.get("stream", True)
    opts = body.get("options") or {}
    ls_body = {
        "model": model_id,
        "input": input_val,
        "stream": stream,
    }
    if system_prompt:
        ls_body["system_prompt"] = system_prompt
    if "temperature" in opts:
        ls_body["temperature"] = float(opts["temperature"])
    if "num_predict" in opts:
        ls_body["max_output_tokens"] = int(opts["num_predict"])

    # Option "Forcer le reasoning" (frontend) : si active, elle prime sur le param de la requête
    global_reasoning = config.get("lm_studio_reasoning")
    if global_reasoning is not None and str(global_reasoning).strip():
        ls_body["reasoning"] = norm_reasoning(global_reasoning)
    else:
        reasoning = (
            body.get("reasoning") if body.get("reasoning") is not None
            else body.get("thinking") if body.get("thinking") is not None
            else opts.get("reasoning") if opts.get("reasoning") is not None
            else opts.get("thinking")
        )
        if reasoning is not None:
            ls_body["reasoning"] = norm_reasoning(reasoning)
        else:
            runtime_params = parse_runtime_from_system_prompt(system_prompt)
            reasoning_from_prompt = reasoning_from_system_prompt(system_prompt)
            if reasoning_from_prompt is not None:
                ls_body["reasoning"] = reasoning_from_prompt
                if config.get("debug"):
                    logger.info(
                        "DEBUG [api/chat] reasoning dérivé du prompt: %s (runtime: %s)",
                        reasoning_from_prompt,
                        debug_json_fn(runtime_params) if runtime_params else "—",
                    )
        if "reasoning" not in ls_body:
            mapping = config.get("model_mapping") or {}
            entry = mapping.get(model) if isinstance(mapping, dict) else {}
            if isinstance(entry, dict) and entry.get("reasoning") is not None:
                ls_body["reasoning"] = norm_reasoning(entry["reasoning"])

    # LM Studio : ne pas envoyer la clé "reasoning" quand c'est "off" — certains modèles
    # (ex. qwen3.5-4b) refusent le paramètre et renvoient 400 même avec reasoning: "off".
    if ls_body.get("reasoning") == "off":
        del ls_body["reasoning"]
        if config.get("debug"):
            logger.info(
                "DEBUG [api/chat] reasoning=off → clé omise pour lm_studio (model=%s)",
                model,
            )
    return ls_body


def _lm_studio_stats_to_usage(stats: dict) -> dict:
    """Construit le dict usage normalisé à partir de result.stats LM Studio."""
    usage = {}
    if stats.get("input_tokens") is not None:
        usage["input_tokens"] = int(stats["input_tokens"])
    if stats.get("total_output_tokens") is not None:
        usage["output_tokens"] = int(stats["total_output_tokens"])
    if stats.get("reasoning_output_tokens") is not None:
        usage["reasoning_tokens"] = int(stats["reasoning_output_tokens"])
    if stats.get("time_to_first_token_seconds") is not None:
        usage["ttft_seconds"] = float(stats["time_to_first_token_seconds"])
    if stats.get("tokens_per_second") is not None:
        usage["tokens_per_second"] = float(stats["tokens_per_second"])
    return usage


def _make_ndjson_chunk(
    canonical_model: str,
    message: dict,
    done: bool = False,
    event: str | None = None,
    progress: float | None = None,
    prompt_eval_count: int | None = None,
    eval_count: int | None = None,
    total_duration: int | None = None,
) -> str:
    """Construit une ligne NDJSON (format Ollama-compatible)."""
    out = {
        "model": canonical_model,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "message": message,
        "done": done,
    }
    if event is not None:
        out["event"] = event
    if progress is not None:
        out["progress"] = progress
    if prompt_eval_count is not None:
        out["prompt_eval_count"] = prompt_eval_count
    if eval_count is not None:
        out["eval_count"] = eval_count
    if total_duration is not None:
        out["total_duration"] = total_duration
    return json.dumps(out, ensure_ascii=False) + "\n"


# Événements LM Studio pour progression du chargement (streamer de manière partielle)
_PROGRESS_EVENTS = frozenset({
    "model_load.start", "model_load.progress", "model_load.end",
    "prompt_processing.start", "prompt_processing.progress", "prompt_processing.end",
})


def _event_type(current_event: str | None, evt: dict) -> str | None:
    """Type d'événement : ligne SSE 'event:' ou champ 'type' dans le JSON (fallback)."""
    if current_event:
        return current_event
    t = evt.get("type")
    return str(t).strip() if isinstance(t, str) else None


async def _stream_from_resp(
    resp,
    canonical_model: str,
    config: dict,
    debug_json_fn,
    request_id: str,
    user_id: str,
    backend: str,
    log_api_request,
):
    """Génère les chunks NDJSON à partir de la réponse stream LM Studio.

    Relaye : progression load/prompt_processing (event + progress), reasoning.delta,
    tool_call.* (format Ollama), message.delta, error, chat.end.
    """
    current_event = None
    buffer = ""
    # Accumulation tool_calls : liste de { "name": str, "arguments": dict }
    acc_tool_calls: list[dict] = []

    # Chunk initial pour signaler que le stream a démarré (aperçu traitement en cours)
    yield _make_ndjson_chunk(
        canonical_model,
        {"role": "assistant", "content": ""},
        done=False,
        event="stream.start",
    )

    async for chunk in resp.aiter_text():
        buffer += chunk
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if line.startswith("event:"):
                current_event = line[6:].strip()
                continue
            if line.startswith("data:"):
                data_str = line[5:].strip()
                if not data_str:
                    continue
                try:
                    evt = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                ev_type = _event_type(current_event, evt)

                # 1) Progression du chargement (model_load / prompt_processing)
                if ev_type in _PROGRESS_EVENTS:
                    progress = None
                    if ev_type in ("model_load.progress", "prompt_processing.progress"):
                        p = evt.get("progress")
                        if isinstance(p, (int, float)):
                            progress = float(p)
                    yield _make_ndjson_chunk(
                        canonical_model,
                        {"role": "assistant", "content": ""},
                        done=False,
                        event=ev_type,
                        progress=progress,
                    )
                    current_event = None
                    continue

                # 2) Erreur en cours de stream
                if ev_type == "error":
                    err = evt.get("error") or {}
                    err_msg = err.get("message", "Unknown error") if isinstance(err, dict) else str(err)
                    log_api_request(request_id, user_id, canonical_model, backend, "error", error_detail=err_msg[:500])
                    yield _make_ndjson_chunk(
                        canonical_model,
                        {"role": "assistant", "content": f"[Erreur LM Studio: {err_msg}]"},
                        done=True,
                    )
                    return

                # 3) Reasoning (stream thinking)
                if ev_type == "reasoning.start":
                    yield _make_ndjson_chunk(
                        canonical_model,
                        {"role": "assistant", "content": "", "reasoning": ""},
                        done=False,
                        event="reasoning.start",
                    )
                    current_event = None
                    continue
                if ev_type == "reasoning.delta":
                    delta = evt.get("content", "") if isinstance(evt.get("content"), str) else ""
                    if delta:
                        yield _make_ndjson_chunk(
                            canonical_model,
                            {"role": "assistant", "content": "", "reasoning": delta},
                            done=False,
                        )
                    current_event = None
                    continue

                # 4) Tool calls (accumulation + émission par appel complet, format Ollama)
                if ev_type == "tool_call.start":
                    name = evt.get("tool", "") if isinstance(evt.get("tool"), str) else ""
                    acc_tool_calls.append({"name": name, "arguments": {}})
                    current_event = None
                    continue
                if ev_type in ("tool_call.arguments", "tool_call.success"):
                    args = evt.get("arguments")
                    tool_name = evt.get("tool") if isinstance(evt.get("tool"), str) else None
                    if isinstance(args, dict) and acc_tool_calls:
                        updated_tc = None
                        for tc in reversed(acc_tool_calls):
                            if tool_name is None or tc["name"] == tool_name:
                                tc["arguments"] = args
                                updated_tc = tc
                                break
                        # Un chunk par appel complété (le client accumule côté frontend)
                        if updated_tc and updated_tc.get("arguments"):
                            yield _make_ndjson_chunk(
                                canonical_model,
                                {
                                    "role": "assistant",
                                    "content": "",
                                    "tool_calls": [
                                        {"function": {"name": updated_tc["name"], "arguments": updated_tc["arguments"]}}
                                    ],
                                },
                                done=False,
                            )
                    current_event = None
                    continue
                if ev_type == "tool_call.failure":
                    # On ignore ou on pourrait émettre un chunk d'erreur pour ce call
                    current_event = None
                    continue

                # 5) Message content (deltas)
                if ev_type == "message.delta" or (
                    evt.get("content") is not None and ev_type != "chat.end"
                ):
                    delta = evt.get("content", "") if isinstance(evt.get("content"), str) else ""
                    if delta:
                        yield _make_ndjson_chunk(
                            canonical_model,
                            {"role": "assistant", "content": delta},
                            done=False,
                        )
                    current_event = None
                    continue

                # 6) Fin du stream (chat.end)
                if ev_type == "chat.end" or (
                    evt.get("output") is not None and evt.get("stats") is not None
                ):
                    container = evt.get("result", evt)
                    stats = container.get("stats") or {}
                    content_parts = []
                    for item in (container.get("output") or evt.get("output") or []):
                        if isinstance(item, dict) and item.get("type") == "message" and "content" in item:
                            content_parts.append(item["content"])
                    if config.get("debug") and content_parts:
                        full_reply = "".join(content_parts)
                        preview = (full_reply[:500] + "...") if len(full_reply) > 500 else full_reply
                        logger.info("DEBUG [api/chat] réponse lm_studio (stream, %d chars): %s", len(full_reply), preview)
                    usage = _lm_studio_stats_to_usage(stats)
                    input_tok = usage.get("input_tokens")
                    out_tok = usage.get("output_tokens") or 0
                    tps = usage.get("tokens_per_second")
                    duration_ms = (out_tok / tps * 1000) if tps and tps > 0 else None
                    log_api_request(
                        request_id, user_id, canonical_model, backend, "ok", duration_ms, None, usage=usage or None
                    )
                    total_dur = None
                    if stats:
                        ttft = stats.get("time_to_first_token_seconds")
                        total_dur = int((ttft or 0) * 1e9) if ttft is not None else None
                    yield _make_ndjson_chunk(
                        canonical_model,
                        {"role": "assistant", "content": ""},
                        done=True,
                        prompt_eval_count=int(input_tok) if input_tok is not None else None,
                        eval_count=int(out_tok) if out_tok else None,
                        total_duration=total_dur,
                    )
                    return

                current_event = None


async def stream_lm_studio_response(
    client: httpx.AsyncClient,
    url: str,
    ls_body: dict,
    canonical_model: str,
    model_id: str,
    model: str,
    config: dict,
    request_id: str,
    user_id: str,
    backend: str,
    log_api_request,
    debug_json_fn,
):
    """Génère les chunks NDJSON du chat LM Studio (stream). Gère 400 + retry reasoning on."""
    # Forcer stream pour que LM Studio envoie bien les événements SSE au fur et à mesure
    ls_body = {**ls_body, "stream": True}
    async with client.stream("POST", f"{url}/api/v1/chat", json=ls_body) as resp:
        if resp.status_code != 200:
            err_text = await resp.aread()
            err_msg = err_text.decode("utf-8", errors="replace")[:500]
            log_api_request(request_id, user_id, canonical_model, backend, str(resp.status_code), None, err_msg)
            # Cas 1: 400 avec reasoning low/medium/high → d'abord retry avec "on" (modèles on/off only ou refus de low/medium/high)
            if resp.status_code == 400 and ls_body.get("reasoning") in ("low", "medium", "high"):
                if is_reasoning_on_off_error(err_msg):
                    db_module.add_lm_studio_on_off_only(model_id, model)
                ls_body_on = {**ls_body, "reasoning": "on"}
                async with client.stream("POST", f"{url}/api/v1/chat", json=ls_body_on) as resp2:
                    if resp2.status_code == 200:
                        if config.get("debug"):
                            logger.info(
                                "DEBUG [api/chat] lm_studio 400 avec reasoning low/medium/high → retry avec reasoning=on OK (model=%s)",
                                model,
                            )
                        async for part in _stream_from_resp(
                            resp2, canonical_model, config, debug_json_fn,
                            request_id, user_id, backend, log_api_request,
                        ):
                            yield part
                        return
                    err2 = await resp2.aread()
                    err_msg2 = err2.decode("utf-8", errors="replace")[:500]
                    log_api_request(request_id, user_id, canonical_model, backend, str(resp2.status_code), None, err_msg2)
            # Cas 2: 400 avec reasoning présent (ou retry "on" a échoué) → retry sans reasoning
            if resp.status_code == 400 and "reasoning" in ls_body:
                ls_body_no_reasoning = _ls_body_without_reasoning(ls_body)
                async with client.stream("POST", f"{url}/api/v1/chat", json=ls_body_no_reasoning) as resp3:
                    if resp3.status_code == 200:
                        if config.get("debug"):
                            logger.info(
                                "DEBUG [api/chat] lm_studio 400 avec reasoning → retry sans reasoning OK (model=%s)",
                                model,
                            )
                        async for part in _stream_from_resp(
                            resp3, canonical_model, config, debug_json_fn,
                            request_id, user_id, backend, log_api_request,
                        ):
                            yield part
                        return
            # 4xx/5xx après retries : permettre fallback OpenRouter (server.py catch BackendRequestFailed)
            raise BackendRequestFailed(resp.status_code, err_msg)
        async for part in _stream_from_resp(
            resp, canonical_model, config, debug_json_fn,
            request_id, user_id, backend, log_api_request,
        ):
            yield part


async def request_lm_studio_sync(
    client: httpx.AsyncClient,
    url: str,
    ls_body: dict,
    canonical_model: str,
    model_id: str,
    model: str,
    config: dict,
    request_id: str,
    user_id: str,
    backend: str,
    log_api_request,
    debug_json_fn,
):
    """Requête LM Studio non-stream. Gère 400 + retry reasoning on. Retourne le dict ou lève HTTPException."""
    from fastapi import HTTPException

    r = await client.post(f"{url}/api/v1/chat", json=ls_body)
    if r.status_code != 200:
        detail = (r.text or str(r.status_code))[:500]
        log_api_request(request_id, user_id, canonical_model, backend, str(r.status_code), None, detail)
        # 400 avec reasoning low/medium/high → d'abord retry avec "on"
        if r.status_code == 400 and ls_body.get("reasoning") in ("low", "medium", "high"):
            if is_reasoning_on_off_error(detail):
                db_module.add_lm_studio_on_off_only(model_id, model)
            r = await client.post(f"{url}/api/v1/chat", json={**ls_body, "reasoning": "on"})
            if r.status_code == 200 and config.get("debug"):
                logger.info(
                    "DEBUG [api/chat] lm_studio 400 avec reasoning low/medium/high → retry avec reasoning=on OK (model=%s)",
                    model,
                )
        # 400 avec reasoning (ou retry "on" a échoué) → retry sans reasoning
        if r.status_code == 400 and "reasoning" in ls_body:
            ls_body_no_reasoning = _ls_body_without_reasoning(ls_body)
            r = await client.post(f"{url}/api/v1/chat", json=ls_body_no_reasoning)
            if r.status_code == 200 and config.get("debug"):
                logger.info(
                    "DEBUG [api/chat] lm_studio 400 avec reasoning → retry sans reasoning OK (model=%s)",
                    model,
                )
        if r.status_code != 200:
            detail = (r.text or str(r.status_code))[:500]
            log_api_request(request_id, user_id, canonical_model, backend, str(r.status_code), None, detail)
            raise HTTPException(status_code=r.status_code, detail=detail)
    data = r.json()
    if config.get("debug"):
        logger.info("DEBUG [api/chat] reçu lm_studio (non-stream): %s", debug_json_fn(data))
    result = data.get("result", data)
    output = result.get("output") or data.get("output") or []
    stats = result.get("stats") or data.get("stats") or {}
    content_parts = []
    for item in output:
        if isinstance(item, dict) and item.get("type") == "message" and "content" in item:
            content_parts.append(item["content"])
    usage = _lm_studio_stats_to_usage(stats)
    out_tok = usage.get("output_tokens") or 0
    tps = usage.get("tokens_per_second")
    duration_ms = (out_tok / tps * 1000) if tps and tps > 0 else None
    log_api_request(
        request_id, user_id, canonical_model, backend, "ok", duration_ms, None, usage=usage or None
    )
    return {
        "model": canonical_model,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "message": {"role": "assistant", "content": "".join(content_parts)},
        "done": True,
    }
