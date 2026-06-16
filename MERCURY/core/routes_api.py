"""
Routes /api/* : tags, chat (Ollama-compatible), show.
"""
import json
import logging
import os
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse

from providers.base import BackendResult, BackendRequestFailed
from providers.http_client import get_client
from providers.openrouter.backend import sanitize_body_for_openrouter, stream_openrouter_sse_to_ndjson
from providers.anthropic.backend import convert_openai_to_anthropic, stream_anthropic_sse_to_ndjson
from routing.router import get_config, resolve_and_prepare, resolve_model, get_openrouter_fallback, get_anthropic_fallback, get_ordered_cloud_fallback
from routing.models_cache import get_cached_models, is_stale, refresh_shared as refresh_models_cache_shared
from auth import resolve_user
from app_queue.request_queue import (
    log_rejection,
    log_api_request,
    register_api_request_in_progress,
    unregister_api_request_in_progress,
)
from utils.debug import debug_json, lazy_json
from providers import (
    get_backend,
    stream_ollama_chat,
    request_ollama_chat_sync,
    build_lm_studio_body,
    stream_lm_studio_response,
    request_lm_studio_sync,
    get_model_show,
)

logger = logging.getLogger(__name__)


# ── Helpers factorisés pour le fallback OpenRouter ──────────────────────


def _error_ndjson(canonical_model: str, message: str) -> str:
    """Formate un message d'erreur en ndjson pour le client."""
    return json.dumps({
        "model": canonical_model,
        "message": {"role": "assistant", "content": message},
        "done": True,
    }, ensure_ascii=False) + "\n"


async def _fallback_stream(
    fallback, body, canonical_model, request_id, user_id, config,
):
    """Stream fallback vers OpenRouter ou Anthropic avec retry configurable. Yield les lignes ndjson."""
    fb_backend, fb_model_id = fallback
    cfg = config or get_config()
    max_retries = int(cfg.get("max_retry_on_fallback", 1))
    last_err = None
    for attempt in range(max(1, max_retries)):
        try:
            backend_inst = get_backend(fb_backend, cfg)
            if fb_backend == "openrouter":
                fb_body = sanitize_body_for_openrouter(body, fb_model_id)
                fb_body["model"] = fb_model_id
                gen = await backend_inst.chat(fb_body, stream=True)
                async for line in stream_openrouter_sse_to_ndjson(gen, canonical_model, fb_backend, cfg):
                    yield line
            elif fb_backend == "anthropic":
                fb_body = {**body, "model": fb_model_id}
                anthropic_payload = convert_openai_to_anthropic(fb_body, stream=True)
                raw_gen = await backend_inst.chat_raw_sse(anthropic_payload)
                async for line in stream_anthropic_sse_to_ndjson(raw_gen, canonical_model, cfg):
                    yield line
            else:
                raise ValueError(f"Fallback backend inconnu: {fb_backend}")
            log_api_request(request_id, user_id, canonical_model, fb_backend, "ok")
            return
        except Exception as fb_err:
            last_err = fb_err
            if attempt < max_retries - 1:
                logger.info("[fallback] tentative %d/%d échouée (%s): %s", attempt + 1, max_retries, fb_backend, str(fb_err)[:200])
    log_api_request(request_id, user_id, canonical_model, fb_backend, "error", error_detail=str(last_err)[:500])
    yield _error_ndjson(canonical_model, f"Error: {last_err}")


async def _fallback_sync(
    fallback, body, canonical_model, request_id, user_id, config,
):
    """Sync fallback vers OpenRouter ou Anthropic avec retry configurable. Retourne JSONResponse ou lève HTTPException."""
    fb_backend, fb_model_id = fallback
    max_retries = int(config.get("max_retry_on_fallback", 1))
    last_err = None
    for attempt in range(max(1, max_retries)):
        try:
            backend_inst = get_backend(fb_backend, config)
            if fb_backend == "openrouter":
                fb_body = sanitize_body_for_openrouter(body, fb_model_id)
                fb_body["model"] = fb_model_id
                result = await backend_inst.chat(fb_body, stream=False)
            elif fb_backend == "anthropic":
                fb_body = {**body, "model": fb_model_id}
                result = await backend_inst.chat(fb_body, stream=False)
            else:
                raise ValueError(f"Fallback backend inconnu: {fb_backend}")
            if isinstance(result, BackendResult):
                log_api_request(request_id, user_id, canonical_model, fb_backend, "ok", usage=result.body.get("usage"))
                return JSONResponse(status_code=result.status_code, content=result.body)
            return JSONResponse(content=result.body if hasattr(result, "body") else {})
        except Exception as fb_err:
            last_err = fb_err
            if attempt < max_retries - 1:
                logger.info("[fallback] tentative %d/%d échouée (%s): %s", attempt + 1, max_retries, fb_backend, str(fb_err)[:200])
    log_api_request(request_id, user_id, canonical_model, fb_backend, "error", error_detail=str(last_err)[:500])
    raise HTTPException(status_code=502, detail=f"Fallback {fb_backend}: {last_err}")


# ── Routes ──────────────────────────────────────────────────────────────


def register(app):
    """Enregistre GET /api/tags, POST /api/chat, POST /api/show sur l'app."""

    @app.get("/api/tags")
    async def api_tags():
        if os.environ.get("MERCURY_DEMO_MODE"):
            return {"models": [
                {"name": "demo/demo-model", "modified_at": "", "size": 0},
                {"name": "demo/demo-embed", "modified_at": "", "size": 0},
            ]}
        config = get_config()
        mapping = config.get("model_mapping") or {}
        hidden_models = config.get("hidden_models") or []
        hidden_set = set(hidden_models) if isinstance(hidden_models, (list, set, tuple)) else set()
        ttl = float(config.get("models_cache_ttl_seconds", 60))
        if is_stale(ttl):
            # Single-flight : si /v1/responses (ou un autre /api/tags) refresh déjà,
            # on partage SA tâche au lieu de relancer un poll complet des backends.
            await refresh_models_cache_shared(config)

        cache_models = list(get_cached_models())
        cache_set = {m.get("name") for m in cache_models if isinstance(m, dict)}

        # Cas limite : si le cache dynamique est vide mais qu'un mapping est défini,
        # on conserve l'ancien comportement "mapping-only".
        if not cache_models and isinstance(mapping, dict) and mapping:
            models = [{"name": name, "modified_at": "", "size": 0} for name in sorted(mapping) if name not in hidden_set]
            return {"models": models}

        models = [m for m in cache_models if isinstance(m, dict) and m.get("name") not in hidden_set]

        # Re-injection des tags "backend/backend" côté client (utilisés pour routage explicite).
        # On les met en tête uniquement si le cache dynamique n'est pas vide.
        if models:
            # Tags magiques "premier modèle de <backend>" — gatés par config enabled
            # (sinon vllm/vllm apparaît même si vllm_enabled=false → user clique →
            # "Aucun modèle vllm disponible" évitable). Les autres backends sont
            # enabled par défaut donc le bug existait latent mais sans impact visible
            # tant que personne ne désactivait. On gate tout pour cohérence.
            magic_aliases = [
                ("mlx/mlx",            config.get("mlx_enabled", True)),
                ("llamacpp/llamacpp",  config.get("llamacpp_enabled", True)),
                ("vllm/vllm",          config.get("vllm_enabled", False)),
                ("lm_studio/lm_studio", config.get("lm_studio_enabled", True)),
                ("ollama/ollama",      config.get("ollama_enabled", True)),
            ]
            for name, enabled in magic_aliases:
                if not enabled:
                    continue
                if name not in cache_set and name not in hidden_set:
                    models.insert(0, {"name": name, "modified_at": "", "size": 0})

        # Union : ajouter les entrées du mapping qui ne sont pas déjà dans le cache dynamique.
        if isinstance(mapping, dict) and mapping:
            for canonical in sorted(mapping):
                if canonical and canonical not in cache_set and canonical not in hidden_set:
                    models.append({"name": canonical, "modified_at": "", "size": 0})

        if not models:
            raise HTTPException(status_code=503, detail="Aucun backend disponible (ollama / lm_studio / mlx / openrouter)")

        # Déduplication par `name` (protection en cas d'entrées redondantes).
        seen = set()
        deduped = []
        for m in models:
            if not isinstance(m, dict):
                continue
            n = m.get("name")
            if not n or n in seen:
                continue
            seen.add(n)
            deduped.append(m)

        return {"models": deduped}

    @app.post("/api/chat")
    async def api_chat(request: Request):
        authorization = request.headers.get("Authorization")
        user_id, _priority, _threshold = resolve_user(authorization)
        config = get_config()
        if config.get("require_api_key") and user_id in ("anonymous", "unknown"):
            detail = "Token API invalide ou manquant. Utilisez une clé utilisateur valide (Authorization: Bearer <api_key>)."
            log_rejection(
                request_id=uuid.uuid4().hex,
                user_id=user_id,
                model="—",
                status="401",
                error_detail=detail,
            )
            raise HTTPException(status_code=401, detail=detail)

        # Slot guard: même contrat que /v1/chat/completions — sinon le slot exclusive
        # ne réserverait que les clients OpenAI-format alors qu'/api/chat consomme le
        # même GPU (F1 du rapport fonctionnel).
        from scheduler import state as slot_state
        rej = slot_state.build_slot_rejection(user_id)
        if rej is not None:
            log_rejection(
                request_id=uuid.uuid4().hex,
                user_id=user_id,
                model="—",
                status="503",
                error_detail=rej["detail"],
            )
            return JSONResponse(**rej["response"])

        try:
            body = await request.json()
        except Exception as e:
            logger.warning("Body JSON invalide /api/chat: %s", e)
            raise HTTPException(status_code=400, detail="JSON invalide")
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body doit être un objet JSON")
        config = get_config()
        if config.get("debug"):
            logger.info("DEBUG [api/chat] reçu: %s", debug_json(body))
            keys = list(body.keys()) if isinstance(body, dict) else []
            opts = body.get("options") or {}
            reasoning_val = body.get("reasoning")
            thinking_val = body.get("thinking")
            reasoning_in_opts = opts.get("reasoning") if isinstance(opts, dict) else None
            thinking_in_opts = opts.get("thinking") if isinstance(opts, dict) else None
            logger.info(
                "DEBUG [api/chat] clés reçues: %s | reasoning=%s | thinking=%s | options.reasoning=%s | options.thinking=%s (si absents, dérivés du prompt plus bas)",
                keys, reasoning_val, thinking_val, reasoning_in_opts, thinking_in_opts,
            )
        model = (body.get("model") or "").strip()
        if not model:
            raise HTTPException(status_code=400, detail="Champ 'model' requis")
        config = get_config()
        # F5 : /api/chat ne sait handler que ollama, lm_studio, mlx, openrouter (cf. branches
        # plus bas). Plutôt que de découvrir le mismatch après register et renvoyer 400, on dit
        # à resolve_and_prepare quels backends sont hors-scope → ValueError → 503 propre.
        _API_CHAT_UNSUPPORTED = {"llamacpp", "vllm", "lucebox", "anthropic"}
        try:
            backend, backend_model_id, body_for_backend, canonical_model = await resolve_and_prepare(
                body, excluded_backends=_API_CHAT_UNSUPPORTED,
            )
        except ValueError as e:
            raise HTTPException(status_code=503, detail=str(e) or "Aucun backend activé")
        fallback = None
        if backend not in ("openrouter", "anthropic"):
            fallback = get_ordered_cloud_fallback()
        timeout = config.get("backend_timeout", 300)

        request_id = uuid.uuid4().hex
        await register_api_request_in_progress(request_id, canonical_model, user_id, backend)

        if backend == "lm_studio" and config.get("lm_studio_proxy_only"):
            await unregister_api_request_in_progress(request_id)
            raise HTTPException(
                status_code=503,
                detail="Utilisez POST /v1/chat/completions pour LM Studio (mode proxy).",
            )

        if backend == "ollama":
            return await _handle_ollama(
                body, body_for_backend, config, canonical_model,
                fallback, timeout, request_id, user_id, backend,
            )

        if backend == "lm_studio":
            return await _handle_lm_studio(
                body, body_for_backend, backend_model_id, model, config, canonical_model,
                fallback, timeout, request_id, user_id, backend,
            )

        if backend == "mlx":
            return await _handle_generic_sse(
                "mlx", body, body_for_backend, config, canonical_model,
                fallback, timeout, request_id, user_id,
            )

        if backend == "openrouter":
            forward_body = sanitize_body_for_openrouter(body, backend_model_id)
            forward_body["model"] = backend_model_id
            return await _handle_generic_sse(
                "openrouter", body, forward_body, config, canonical_model,
                None, timeout, request_id, user_id,
            )

        await unregister_api_request_in_progress(request_id)
        raise HTTPException(
            status_code=400,
            detail=f"Modèle routé vers {backend}. Utilisez /v1/chat/completions pour ce modèle.",
        )

    # ── Handlers par backend ────────────────────────────────────────

    async def _handle_ollama(
        body, forward_body, config, canonical_model,
        fallback, timeout, request_id, user_id, backend,
    ):
        ollama_url = (config.get("ollama_url") or "http://localhost:11434").rstrip("/")
        stream = forward_body.get("stream", True)
        if config.get("debug"):
            logger.debug("DEBUG [api/chat] envoyé vers ollama: %s", debug_json(forward_body))

        if stream:
            async def _gen():
                try:
                    try:
                        client = get_client("ollama", timeout=float(timeout))
                        async for part in stream_ollama_chat(
                            client, ollama_url, forward_body, canonical_model, config,
                            request_id, user_id, backend, log_api_request, debug_json,
                        ):
                            yield part
                    except (BackendRequestFailed, httpx.TimeoutException) as e:
                        err_detail = f"Timeout ({timeout}s)" if isinstance(e, httpx.TimeoutException) else e.detail
                        if fallback is None:
                            log_api_request(request_id, user_id, canonical_model, backend, "error", error_detail=err_detail[:500])
                            yield _error_ndjson(canonical_model, f"Error: {err_detail}")
                            return
                        logger.info("[api/chat] ollama erreur (%s), bascule sur OpenRouter fallback (stream)", err_detail[:200])
                        async for line in _fallback_stream(fallback, body, canonical_model, request_id, user_id, config):
                            yield line
                finally:
                    await unregister_api_request_in_progress(request_id)

            return StreamingResponse(
                _gen(),
                media_type="application/x-ndjson",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
            )

        try:
            client = get_client("ollama", timeout=float(timeout))
            data = await request_ollama_chat_sync(
                client, ollama_url, forward_body, canonical_model, config,
                request_id, user_id, backend, log_api_request, debug_json,
            )
            return JSONResponse(content=data)
        except (HTTPException, httpx.TimeoutException) as exc:
            is_timeout = isinstance(exc, httpx.TimeoutException)
            can_fallback = (is_timeout or exc.status_code >= 400) if not is_timeout else True
            if can_fallback and fallback is not None:
                logger.info("[api/chat] ollama sync erreur, bascule sur OpenRouter fallback")
                return await _fallback_sync(fallback, body, canonical_model, request_id, user_id, config)
            if is_timeout:
                log_api_request(request_id, user_id, canonical_model, backend, "error", error_detail=f"Timeout ({timeout}s)")
                raise HTTPException(status_code=504, detail=f"Backend timeout ({timeout}s)")
            raise
        finally:
            await unregister_api_request_in_progress(request_id)

    async def _handle_lm_studio(
        body, body_for_backend, backend_model_id, model, config, canonical_model,
        fallback, timeout, request_id, user_id, backend,
    ):
        lm_studio_url = (config.get("lm_studio_url") or "http://localhost:1234").rstrip("/")
        stream = body.get("stream", True)
        messages = body.get("messages") or []
        model_id = backend_model_id
        system_prompt = ""
        input_parts = []
        for m in messages:
            role = (m.get("role") or "").strip().lower()
            content = m.get("content")
            if role in ("system", "developer"):
                system_prompt = content if isinstance(content, str) else str(content or "")
            elif role == "user":
                input_parts.append(content if isinstance(content, str) else str(content or ""))
        input_val = input_parts[-1] if len(input_parts) == 1 else "\n".join(input_parts) if input_parts else ""
        ls_body = build_lm_studio_body(
            body, model, model_id, system_prompt, input_val, config, debug_json,
        )
        if config.get("debug"):
            logger.info("DEBUG [api/chat] envoyé vers lm_studio: %s", debug_json(ls_body))

        if stream:
            ls_body["stream"] = True

            async def _gen():
                try:
                    try:
                        client = get_client("lm_studio", timeout=float(timeout))
                        async for part in stream_lm_studio_response(
                            client, lm_studio_url, ls_body, canonical_model, model_id, model, config,
                            request_id, user_id, backend, log_api_request, debug_json,
                        ):
                            yield part
                    except httpx.RemoteProtocolError as e:
                        logger.warning("LM Studio stream interrompu (connexion fermée): %s", e, exc_info=False)
                        yield json.dumps({
                            "model": canonical_model,
                            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                            "message": {"role": "assistant", "content": "[Stream interrompu]"},
                            "done": True,
                        }, ensure_ascii=False) + "\n"
                        return
                    except (BackendRequestFailed, httpx.TimeoutException) as e:
                        err_detail = f"Timeout ({timeout}s)" if isinstance(e, httpx.TimeoutException) else e.detail
                        if fallback is None:
                            log_api_request(request_id, user_id, canonical_model, backend, "error", error_detail=err_detail[:500])
                            yield _error_ndjson(canonical_model, f"Error: {err_detail}")
                            return
                        logger.info("[api/chat] lm_studio erreur (%s), bascule sur OpenRouter fallback (stream)", err_detail[:200])
                        async for line in _fallback_stream(fallback, body, canonical_model, request_id, user_id, config):
                            yield line
                finally:
                    await unregister_api_request_in_progress(request_id)

            return StreamingResponse(
                _gen(),
                media_type="application/x-ndjson",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
            )

        try:
            client = get_client("lm_studio", timeout=float(timeout))
            out = await request_lm_studio_sync(
                client, lm_studio_url, ls_body, canonical_model, model_id, model, config,
                request_id, user_id, backend, log_api_request, debug_json,
            )
            return JSONResponse(content=out)
        except (HTTPException, httpx.TimeoutException) as exc:
            is_timeout = isinstance(exc, httpx.TimeoutException)
            can_fallback = (is_timeout or exc.status_code >= 400) if not is_timeout else True
            if can_fallback and fallback is not None:
                logger.info("[api/chat] lm_studio sync erreur, bascule sur OpenRouter fallback")
                return await _fallback_sync(fallback, body, canonical_model, request_id, user_id, config)
            if is_timeout:
                log_api_request(request_id, user_id, canonical_model, backend, "error", error_detail=f"Timeout ({timeout}s)")
                raise HTTPException(status_code=504, detail=f"Backend timeout ({timeout}s)")
            raise
        finally:
            await unregister_api_request_in_progress(request_id)

    async def _handle_generic_sse(
        backend_name, body, forward_body, config, canonical_model,
        fallback, timeout, request_id, user_id,
    ):
        """Handler générique pour backends utilisant SSE (mlx, openrouter)."""
        stream = forward_body.get("stream", True)
        try:
            backend_inst = get_backend(backend_name, config)
        except ValueError as e:
            await unregister_api_request_in_progress(request_id)
            raise HTTPException(status_code=503, detail=str(e))
        logger.debug("DEBUG [api/chat] envoyé vers %s: %s", backend_name, lazy_json(forward_body))

        if stream:
            async def _gen():
                try:
                    try:
                        gen = await backend_inst.chat(forward_body, stream=True)
                        async for line in stream_openrouter_sse_to_ndjson(gen, canonical_model, backend_name, config):
                            yield line
                        log_api_request(request_id, user_id, canonical_model, backend_name, "ok")
                    except Exception as e:
                        if fallback is None:
                            log_api_request(request_id, user_id, canonical_model, backend_name, "error", error_detail=str(e)[:500])
                            yield _error_ndjson(canonical_model, f"Error: {e}")
                            return
                        logger.info("[api/chat] %s erreur, bascule sur OpenRouter fallback (stream)", backend_name)
                        async for line in _fallback_stream(fallback, body, canonical_model, request_id, user_id, config):
                            yield line
                finally:
                    await unregister_api_request_in_progress(request_id)

            return StreamingResponse(
                _gen(),
                media_type="application/x-ndjson",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
            )

        try:
            result = await backend_inst.chat(forward_body, stream=False)
            if isinstance(result, BackendResult):
                log_api_request(request_id, user_id, canonical_model, backend_name, "ok", usage=result.body.get("usage"))
                return JSONResponse(status_code=result.status_code, content=result.body)
            return JSONResponse(content=result.body if hasattr(result, "body") else {})
        except Exception as e:
            if fallback is not None:
                logger.info("[api/chat] %s sync erreur, bascule sur OpenRouter fallback", backend_name)
                return await _fallback_sync(fallback, body, canonical_model, request_id, user_id, config)
            log_api_request(request_id, user_id, canonical_model, backend_name, "error", error_detail=str(e)[:500])
            raise HTTPException(status_code=502, detail=str(e))
        finally:
            await unregister_api_request_in_progress(request_id)

    @app.post("/api/show")
    async def api_show(request: Request):
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="JSON invalide")
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body doit être un objet JSON")
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Champ 'name' requis")
        config = get_config()
        try:
            backend, backend_model_id = resolve_model(name)
        except ValueError:
            raise HTTPException(status_code=503, detail="Aucun backend activé")
        return await get_model_show(backend, backend_model_id, name, config)
