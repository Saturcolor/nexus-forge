"""
Route POST /v1/responses : proxy vers LM Studio (API openai-responses), stateful, reasoning.
"""
import json
import logging
import time
import uuid

import httpx
from fastapi import Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse

from routing.router import get_config, resolve_model
from routing.models_cache import is_stale, refresh_shared as refresh_models_cache_shared
from auth import resolve_user
from app_queue.request_queue import (
    log_api_request,
    register_api_request_in_progress,
    unregister_api_request_in_progress,
)
from providers.lm_studio.handler import is_reasoning_on_off_error
from providers.lm_studio.load_cache import should_skip_load, mark_load_done, is_model_loaded_in_response, get_load_lock
from core.response_id_cache import clear_response_id, get_previous_response_id, set_response_id
from core.responses_helpers import (
    extract_usage_from_chunk,
    extract_last_user_input,
    normalize_reasoning_for_responses,
    build_stateful_body,
    sanitize_input_roles,
    normalize_input_items,
    strip_unsupported_fields,
    ensure_input_has_user_message,
    sanitize_include_for_lm_studio,
    is_previous_response_not_found,
    REASONING_EFFORT_ON,
)
from core.prompt_cache import (
    cache_body_for_model,
    get_injected_response_id,
    clear_injected_response_id,
)
from utils.debug import debug_json

logger = logging.getLogger(__name__)


def register(app):
    """Enregistre POST /v1/responses sur l'app."""

    @app.post("/v1/responses")
    async def openai_responses(request: Request):
        config = get_config()
        if not config.get("lm_studio_enabled"):
            raise HTTPException(status_code=404, detail="Endpoint /v1/responses disponible uniquement si LM Studio est activé.")
        try:
            body = await request.json()
        except Exception as e:
            logger.warning("Body JSON invalide /v1/responses: %s", e)
            raise HTTPException(status_code=400, detail="JSON invalide")
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body doit être un objet JSON")

        authorization = request.headers.get("Authorization")
        user_id, _, _ = resolve_user(authorization)
        if config.get("require_api_key") and user_id in ("anonymous", "unknown"):
            raise HTTPException(
                status_code=401,
                detail="Token API invalide ou manquant (Authorization: Bearer <api_key>).",
            )

        # Slot guard (F1 rapport fonctionnel) : /v1/responses consomme LM Studio = GPU local.
        from scheduler import state as slot_state
        rej = slot_state.build_slot_rejection(user_id)
        if rej is not None:
            return JSONResponse(**rej["response"])

        model_in = (body.get("model") or "").strip()
        if not model_in:
            raise HTTPException(status_code=400, detail="Champ 'model' requis dans le body.")
        # F4 : `auto` / `auto/auto` ne sont plus magic-remap ici. Le tag explicite est
        # attendu (lm_studio/lm_studio, etc.). resolve_model lèvera une ValueError parlante.
        try:
            if is_stale(float(config.get("models_cache_ttl_seconds", 60))):
                # Single-flight : partage la tâche refresh en vol (ex. /api/tags concurrent)
                # plutôt que de relancer un poll complet des backends en parallèle.
                await refresh_models_cache_shared(config)
            backend_name, backend_model_id = resolve_model(model_in)
        except ValueError as e:
            logger.info("POST /v1/responses -> 400 (résolution): %s", e)
            raise HTTPException(status_code=400, detail=str(e))
        if backend_name != "lm_studio":
            logger.info(
                "POST /v1/responses -> 400 (backend %s) ; /v1/responses exige lm_studio.",
                backend_name,
            )
            raise HTTPException(
                status_code=400,
                detail=f"Modèle résolu vers {backend_name} ; /v1/responses proxy uniquement vers LM Studio.",
            )
        body_for_lm = {**body, "model": backend_model_id}
        sanitize_input_roles(body_for_lm)
        normalize_input_items(body_for_lm)
        strip_unsupported_fields(body_for_lm)
        reasoning_val = normalize_reasoning_for_responses(
            body_for_lm, backend_model_id, model_in, config
        )
        if reasoning_val is not None:
            body_for_lm["reasoning"] = reasoning_val
        elif "reasoning" in body_for_lm:
            del body_for_lm["reasoning"]
        if "include" in body_for_lm and isinstance(body_for_lm["include"], list):
            body_for_lm["include"] = sanitize_include_for_lm_studio(body_for_lm["include"])
        ensure_input_has_user_message(body_for_lm)
        static_hash = None
        full_body = dict(body_for_lm)

        # Cache le body pour injection manuelle ultérieure (dashboard)
        cache_body_for_model(backend_model_id, full_body)

        stateful_enabled = config.get("stateful_responses_enabled", True)
        session_header = (config.get("stateful_responses_session_header") or "").strip()
        base_session_key = request.headers.get(session_header) if session_header else f"{user_id}:{model_in}"
        session_key = f"{base_session_key}:{static_hash}" if static_hash else base_session_key
        ttl_stateful = float(config.get("stateful_responses_ttl_seconds", 600))
        send_max_age = config.get("stateful_responses_send_max_age_seconds")
        send_max_age_float = ttl_stateful if send_max_age is None else (None if send_max_age == 0 else float(send_max_age))
        previous_id = (
            get_previous_response_id(session_key, ttl_stateful, send_max_age_float)
            if stateful_enabled
            else None
        )
        if not stateful_enabled:
            logger.info("stateful /v1/responses: désactivé (config)")
        else:
            if previous_id:
                new_input = extract_last_user_input(body)
                if new_input is not None:
                    body_for_lm = build_stateful_body(body_for_lm, previous_id, new_input)
                    new_preview = (new_input[:80] + "…") if isinstance(new_input, str) and len(new_input) > 80 else new_input
                    logger.info("stateful /v1/responses: envoi avec previous_response_id session_key=%s input_preview=%s", session_key[:60], new_preview)
                else:
                    previous_id = None
                    logger.info("stateful /v1/responses: previous_id en cache mais impossible d'extraire le dernier message user (body keys=%s)", list(body.keys()))
            elif not previous_id and stateful_enabled:
                # Vérifier s'il y a un response_id injecté manuellement (dashboard)
                injected_id = get_injected_response_id(backend_model_id)
                if injected_id:
                    new_input = extract_last_user_input(body)
                    if new_input is not None:
                        body_for_lm = build_stateful_body(body_for_lm, injected_id, new_input)
                        previous_id = injected_id
                        set_response_id(session_key, injected_id)
                        logger.info(
                            "inject-prompt: utilisation du response_id injecté manuellement (id=%s, model=%s)",
                            injected_id[:40], backend_model_id,
                        )
                    else:
                        logger.info("inject-prompt: response_id injecté disponible mais impossible d'extraire le user input")
                elif send_max_age_float > 0 and get_previous_response_id(session_key, ttl_stateful, None):
                    logger.info("stateful /v1/responses: previous_id en cache mais trop vieux (>%.0fs), envoi body complet (évite 400)", send_max_age_float)
                else:
                    logger.info("stateful /v1/responses: pas de previous_id en cache (session_key=%s), envoi body complet", session_key[:60])

        request_id = uuid.uuid4().hex
        t0 = time.perf_counter()
        canonical_model = model_in
        # NOTE: register est fait DANS stream_out() pour le path streaming (voir ci-dessous)
        # afin d'éviter un leak si le générateur n'est jamais itéré (déconnexion précoce du client).
        # Pour le path non-stream, register est appelé juste avant le bloc try/finally ci-après.

        base = (config.get("lm_studio_url") or "http://localhost:1234").rstrip("/")
        if not base.lower().endswith("/v1"):
            base = f"{base}/v1"
        responses_url = f"{base}/responses"
        timeout = float(config.get("backend_timeout", 300))
        stream = body_for_lm.get("stream", False)

        native_base = base[:-2].rstrip("/") if base.lower().endswith("/v1") else base
        # Lock par (native_base, model_id) pour sérialiser les requêtes concurrentes :
        # deux appels simultanés sur un modèle non chargé ne postent plus deux load.
        # Le second attend que le premier ait appelé mark_load_done, puis should_skip_load
        # retourne True et le POST est sauté.
        async with get_load_lock(native_base, backend_model_id):
            need_load = True
            try:
                async with httpx.AsyncClient(timeout=10.0) as get_client:
                    r = await get_client.get(f"{native_base}/api/v1/models")
                if r.status_code == 200:
                    data = r.json()
                    if is_model_loaded_in_response(data, backend_model_id):
                        need_load = False
                        mark_load_done(native_base, backend_model_id)
            except Exception:
                pass
            if need_load and not should_skip_load(native_base, backend_model_id):
                load_url = f"{native_base}/api/v1/models/load"
                logger.info(
                    "load_cache: POST /api/v1/models/load pour %s (base=%s)",
                    backend_model_id, native_base,
                )
                try:
                    async with httpx.AsyncClient(timeout=60.0) as load_client:
                        await load_client.post(load_url, json={"model": backend_model_id})
                except Exception:
                    pass
                mark_load_done(native_base, backend_model_id)
            else:
                logger.debug(
                    "load_cache: skip load pour %s (need_load=%s, should_skip=%s)",
                    backend_model_id, need_load, not need_load or should_skip_load(native_base, backend_model_id),
                )

        if stream:
            async def stream_out():
                # Register ICI (et non avant le return StreamingResponse) : si FastAPI
                # ne démarre jamais l'itération du générateur (déconnexion client avant
                # le premier yield), le finally ci-dessous fire quand même et unregister
                # est appelé correctement. Miroir du path cloud-direct dans routes_chat_completions.py.
                await register_api_request_in_progress(request_id, canonical_model, user_id, "lm_studio")
                try:
                    async with httpx.AsyncClient(timeout=timeout) as client:
                        body_to_send = body_for_lm
                        for attempt in range(3):
                            if get_config().get("debug"):
                                logger.info("stateful /v1/responses envoi LM Studio (attempt %s): %s", attempt + 1, debug_json(body_to_send))
                            async with client.stream("POST", responses_url, json=body_to_send) as resp:
                                if resp.status_code != 200:
                                    err = await resp.aread()
                                    err_text = err.decode("utf-8", errors="replace")
                                    if attempt < 2 and stateful_enabled:
                                        try:
                                            err_data = json.loads(err_text)
                                        except Exception:
                                            err_data = {}
                                        if is_previous_response_not_found(err_data):
                                            clear_response_id(session_key)
                                            clear_injected_response_id(backend_model_id)
                                            logger.info("stateful /v1/responses: previous_response_not_found, retry avec body complet")
                                            body_to_send = full_body
                                            continue
                                    if attempt < 2 and resp.status_code == 400 and is_reasoning_on_off_error(err_text):
                                        r = body_to_send.get("reasoning")
                                        effort = r.get("effort") if isinstance(r, dict) else r
                                        if effort in ("low", "medium", "high"):
                                            logger.info("stateful /v1/responses: reasoning %s non supporté, retry avec reasoning.effort=%s", effort, REASONING_EFFORT_ON)
                                            body_to_send = {**body_to_send, "reasoning": {"effort": REASONING_EFFORT_ON}}
                                            continue
                                    if attempt < 2 and resp.status_code == 400 and "No user query found" in err_text:
                                        if body_to_send.get("reasoning") is not None:
                                            logger.info(
                                                "stateful /v1/responses: erreur template jinja 'No user query' avec reasoning, "
                                                "retry sans reasoning (model=%s)", body_to_send.get("model"),
                                            )
                                            body_to_send = {k: v for k, v in body_to_send.items() if k != "reasoning"}
                                            continue
                                    log_api_request(
                                        request_id, user_id, canonical_model, "lm_studio",
                                        str(resp.status_code), (time.perf_counter() - t0) * 1000,
                                        error_detail=err_text[:500],
                                    )
                                    # F3 : on est dans media_type="text/event-stream",
                                    # yield brut casse le format SSE côté client. Wrap
                                    # en data: {...}\n\n + [DONE].
                                    err_payload = {
                                        "error": {
                                            "message": err_text[:500] or f"HTTP {resp.status_code}",
                                            "code": resp.status_code,
                                            "type": "lm_studio_error",
                                        }
                                    }
                                    yield f"data: {json.dumps(err_payload, ensure_ascii=False)}\n\n"
                                    yield "data: [DONE]\n\n"
                                    return
                                usage_from_stream = None
                                response_id_captured = None
                                line_buf = ""
                                async for chunk in resp.aiter_text():
                                    if not chunk:
                                        continue
                                    line_buf += chunk
                                    while "\n" in line_buf:
                                        line, line_buf = line_buf.split("\n", 1)
                                        raw = line.strip()
                                        try:
                                            if raw.startswith("data: "):
                                                obj = json.loads(raw[6:])
                                            elif raw.startswith("{") and raw.endswith("}"):
                                                obj = json.loads(raw)
                                            else:
                                                obj = None
                                            if isinstance(obj, dict):
                                                u = extract_usage_from_chunk(obj)
                                                if u is not None:
                                                    usage_from_stream = u
                                                if response_id_captured is None:
                                                    rid_candidate = None
                                                    if isinstance(obj.get("response"), dict):
                                                        rid_candidate = (obj.get("response") or {}).get("id")
                                                    event_type = obj.get("type", "")
                                                    if get_config().get("debug"):
                                                        logger.info(
                                                            "stateful stream chunk: type=%s has_response_id=%s rid=%s",
                                                            event_type,
                                                            rid_candidate is not None,
                                                            (rid_candidate[:50] + "…") if rid_candidate and len(str(rid_candidate)) > 50 else rid_candidate,
                                                        )
                                                    if get_config().get("debug") and obj.get("response") is not None:
                                                        logger.info("stateful stream chunk (event avec response): %s", debug_json(obj))
                                                    if rid_candidate and str(rid_candidate).strip().lower().startswith("resp_"):
                                                        response_id_captured = str(rid_candidate).strip()
                                                        if response_id_captured and stateful_enabled:
                                                            set_response_id(session_key, response_id_captured)
                                                            logger.info("stateful /v1/responses: response_id enregistré (stream) session_key=%s id=%s", session_key[:60], response_id_captured[:40])
                                        except (json.JSONDecodeError, ValueError):
                                            pass
                                        yield line + "\n"
                                if line_buf:
                                    yield line_buf
                                log_api_request(
                                    request_id, user_id, canonical_model, "lm_studio",
                                    "ok", (time.perf_counter() - t0) * 1000,
                                    usage=usage_from_stream,
                                )
                                return
                finally:
                    await unregister_api_request_in_progress(request_id)
            return StreamingResponse(
                stream_out(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
            )
        # Path non-stream : register ici, protégé par le try/finally ci-dessous.
        # (Le path stream enregistre dans stream_out() pour éviter le leak précoce.)
        await register_api_request_in_progress(request_id, canonical_model, user_id, "lm_studio")
        # try/finally autour de TOUT le non-stream : si client.post / resp.json /
        # logique de retry raise (timeout, ConnectError, etc.), l'unregister manuel
        # L365 ne fire jamais → request_id leak dans la map in-progress.
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                if get_config().get("debug"):
                    logger.info("stateful /v1/responses envoi LM Studio (non-stream): %s", debug_json(body_for_lm))
                resp = await client.post(responses_url, json=body_for_lm)
                duration_ms = (time.perf_counter() - t0) * 1000
                try:
                    data = resp.json()
                except Exception:
                    data = {"error": (resp.text or str(resp.status_code))[:1000]}
                body_used = body_for_lm
                if resp.status_code == 400 and stateful_enabled and is_previous_response_not_found(data):
                    clear_response_id(session_key)
                    clear_injected_response_id(backend_model_id)
                    retry_body = full_body
                    logger.info("stateful /v1/responses: previous_response_not_found, retry avec body complet")
                    if get_config().get("debug"):
                        logger.info("stateful /v1/responses retry (non-stream): %s", debug_json(retry_body))
                    resp = await client.post(responses_url, json=retry_body)
                    duration_ms = (time.perf_counter() - t0) * 1000
                    body_used = retry_body
                    try:
                        data = resp.json()
                    except Exception:
                        data = {"error": (resp.text or str(resp.status_code))[:1000]}
                r = body_used.get("reasoning")
                effort = r.get("effort") if isinstance(r, dict) else r
                if resp.status_code == 400 and is_reasoning_on_off_error(resp.text or "") and effort in ("low", "medium", "high"):
                    logger.info("stateful /v1/responses: reasoning %s non supporté (non-stream), retry avec reasoning.effort=%s", effort, REASONING_EFFORT_ON)
                    resp = await client.post(responses_url, json={**body_used, "reasoning": {"effort": REASONING_EFFORT_ON}})
                    duration_ms = (time.perf_counter() - t0) * 1000
                    try:
                        data = resp.json()
                    except Exception:
                        data = {"error": (resp.text or str(resp.status_code))[:1000]}
                err_text_ns = resp.text or ""
                if resp.status_code == 400 and "No user query found" in err_text_ns and body_used.get("reasoning") is not None:
                    logger.info(
                        "stateful /v1/responses: erreur template jinja 'No user query' avec reasoning (non-stream), "
                        "retry sans reasoning (model=%s)", body_used.get("model"),
                    )
                    body_no_reasoning = {k: v for k, v in body_used.items() if k != "reasoning"}
                    resp = await client.post(responses_url, json=body_no_reasoning)
                    duration_ms = (time.perf_counter() - t0) * 1000
                    try:
                        data = resp.json()
                    except Exception:
                        data = {"error": (resp.text or str(resp.status_code))[:1000]}
                if stateful_enabled and resp.status_code == 200 and isinstance(data, dict):
                    rid = None
                    if isinstance(data.get("response"), dict) and data["response"].get("id"):
                        rid = str(data["response"]["id"]).strip()
                    elif data.get("id"):
                        rid = str(data["id"]).strip()
                    if rid and rid.lower().startswith("resp_"):
                        set_response_id(session_key, rid)
                        logger.info("stateful /v1/responses: response_id enregistré (JSON) session_key=%s id=%s", session_key[:60], rid[:40])
                if resp.status_code != 200:
                    err_msg = resp.text or str(resp.status_code)
                    if isinstance(data.get("error"), dict):
                        err_msg = data["error"].get("message", err_msg) or err_msg
                    elif data.get("error"):
                        err_msg = str(data["error"])[:500] or err_msg
                    log_api_request(
                        request_id, user_id, canonical_model, "lm_studio",
                        str(resp.status_code), duration_ms, error_detail=err_msg[:500],
                    )
                else:
                    log_api_request(
                        request_id, user_id, canonical_model, "lm_studio",
                        "ok", duration_ms, usage=data.get("usage") if isinstance(data, dict) else None,
                    )
                return JSONResponse(content=data, status_code=resp.status_code)
        finally:
            await unregister_api_request_in_progress(request_id)
