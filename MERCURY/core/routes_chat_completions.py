"""
Route POST /v1/chat/completions (file + worker).
Les requêtes cloud (openrouter/anthropic) peuvent bypass la file séquentielle.
"""
import asyncio
import json
import logging
import os
import time
import uuid

from fastapi import Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse

from providers import get_backend
from providers.base import BackendResult, BackendRequestFailed
from routing.router import get_config, resolve_and_prepare, CLOUD_BACKENDS
from auth import resolve_user
from app_queue.request_queue import (
    enqueue,
    log_rejection,
    log_api_request,
    register_api_request_in_progress,
    unregister_api_request_in_progress,
    cancel_request_if_current,
)
from utils.debug import debug_json

logger = logging.getLogger(__name__)


async def _dispatch_cloud_direct(
    body_for_backend: dict,
    backend_name: str,
    canonical_model: str,
    stream: bool,
    request_id: str,
    user_id: str,
    config: dict,
):
    """Dispatch direct vers un backend cloud (openrouter/anthropic) sans passer par la queue."""
    backend = get_backend(backend_name, config)

    if stream:
        async def _gen():
            try:
                await register_api_request_in_progress(request_id, canonical_model, user_id, backend_name)
                t0 = time.perf_counter()
                result = await backend.chat(body_for_backend, stream=True)
                # Les backends cloud (openrouter/anthropic) renvoient un async generator
                # nu — PAS un StreamWithUsage — donc getattr(result, "usage") est toujours
                # None. Le bloc usage arrive dans l'avant-dernier event SSE (OpenRouter
                # force stream_options.include_usage=True). On le sniff au vol pour ne pas
                # perdre le comptage tokens. Sniff cheap : on ne parse que les chunks qui
                # contiennent la sous-chaîne "usage" (cf. même approche backend openrouter).
                captured_usage: dict | None = None
                async for chunk in result:
                    if captured_usage is None and chunk and '"usage"' in chunk:
                        try:
                            for raw in chunk.split("\n"):
                                raw = raw.strip()
                                if not raw.startswith("data:"):
                                    continue
                                data_str = raw[5:].strip()
                                if not data_str or data_str == "[DONE]":
                                    continue
                                evt = json.loads(data_str)
                                if isinstance(evt, dict) and isinstance(evt.get("usage"), dict) and evt["usage"]:
                                    captured_usage = evt["usage"]
                                    break
                        except (json.JSONDecodeError, ValueError):
                            pass
                    yield chunk
                duration_ms = (time.perf_counter() - t0) * 1000
                # Priorité au usage sniffé du stream ; fallback sur l'attribut au cas où
                # un backend renverrait un StreamWithUsage (chemin non-cloud théorique).
                usage = captured_usage if captured_usage is not None else getattr(result, "usage", None)
                log_api_request(request_id, user_id, canonical_model, backend_name, "ok", duration_ms, usage=usage)
            except asyncio.CancelledError:
                logger.info("Client déconnecté pendant le stream cloud (requête %s)", request_id)
                return
            except BackendRequestFailed as e:
                # Préserver le vrai status upstream (429/402/5xx…) au lieu de le clamper en 502
                # (les backends cloud lèvent maintenant BackendRequestFailed sur 4xx/5xx — contrat).
                log_api_request(request_id, user_id, canonical_model, backend_name, "error", error_detail=(e.detail or str(e))[:500])
                yield f"data: {json.dumps({'error': {'message': e.detail or str(e), 'code': e.status_code}}, ensure_ascii=False)}\n\n"
            except Exception as e:
                log_api_request(request_id, user_id, canonical_model, backend_name, "error", error_detail=str(e)[:500])
                yield f"data: {json.dumps({'error': {'message': str(e), 'code': 502}}, ensure_ascii=False)}\n\n"
            finally:
                await unregister_api_request_in_progress(request_id)

        return StreamingResponse(
            _gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    # Non-streaming
    await register_api_request_in_progress(request_id, canonical_model, user_id, backend_name)
    try:
        t0 = time.perf_counter()
        result = await backend.chat(body_for_backend, stream=False)
        duration_ms = (time.perf_counter() - t0) * 1000
        if isinstance(result, BackendResult):
            log_api_request(request_id, user_id, canonical_model, backend_name, "ok", duration_ms, usage=result.body.get("usage"))
            return JSONResponse(content=result.body, status_code=result.status_code)
        log_api_request(request_id, user_id, canonical_model, backend_name, "ok", duration_ms)
        return JSONResponse(content=result.body if hasattr(result, "body") else {})
    except BackendRequestFailed as e:
        # Préserver le vrai status upstream (429/402/5xx…) au lieu de le clamper en 502.
        log_api_request(request_id, user_id, canonical_model, backend_name, "error", error_detail=(e.detail or str(e))[:500])
        raise HTTPException(status_code=e.status_code, detail=e.detail or str(e))
    except Exception as e:
        log_api_request(request_id, user_id, canonical_model, backend_name, "error", error_detail=str(e)[:500])
        raise HTTPException(status_code=502, detail=str(e))
    finally:
        await unregister_api_request_in_progress(request_id)


def register(app):
    """Enregistre POST /v1/chat/completions sur l'app."""

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request):
        try:
            body = await request.json()
        except Exception as e:
            logger.warning("Body JSON invalide: %s", e)
            raise HTTPException(status_code=400, detail="JSON invalide")

        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Le body doit être un objet JSON")
        config = get_config()
        if config.get("debug"):
            logger.info("DEBUG [v1/chat/completions] reçu: %s", debug_json(body))
        model = body.get("model")
        if not model or not isinstance(model, str):
            raise HTTPException(status_code=400, detail="Champ 'model' requis (string)")
        messages = body.get("messages")
        if not isinstance(messages, list) or len(messages) == 0:
            raise HTTPException(status_code=400, detail="Champ 'messages' requis (tableau non vide)")

        authorization = request.headers.get("Authorization")
        user_id, priority, threshold = resolve_user(authorization)
        config = get_config()
        if config.get("require_api_key") and user_id in ("anonymous", "unknown"):
            detail = "Token API invalide ou manquant. Utilisez une clé utilisateur valide (Authorization: Bearer <api_key>)."
            log_rejection(
                request_id=uuid.uuid4().hex,
                user_id=user_id,
                model=model or "—",
                status="401",
                error_detail=detail,
            )
            raise HTTPException(status_code=401, detail=detail)

        # Slot guard: reject requests from consumers not allowed during exclusive slot
        from scheduler import state as slot_state
        rej = slot_state.build_slot_rejection(user_id)
        if rej is not None:
            log_rejection(
                request_id=uuid.uuid4().hex,
                user_id=user_id,
                model=model or "—",
                status="503",
                error_detail=rej["detail"],
            )
            return JSONResponse(**rej["response"])

        stream = body.get("stream", False)
        logger.info("Chat completions: model=%s stream=%s user=%s", model, stream, user_id)

        # ── DEMO_MODE : réponse canned, aucun vrai backend requis ───────────────
        if os.environ.get("MERCURY_DEMO_MODE"):
            request_id = str(uuid.uuid4())[:8]
            logger.info("DEMO_MODE: canned completion model=%s stream=%s (request %s)", model, stream, request_id)
            return await _dispatch_cloud_direct(
                body_for_backend=body,
                backend_name="demo",
                canonical_model=model,
                stream=stream,
                request_id=request_id,
                user_id=user_id,
                config=config,
            )

        # Cloud bypass : résoudre le backend avant d'enqueue.
        # Si c'est un backend cloud, dispatch direct (pas de sérialisation nécessaire).
        if config.get("cloud_bypass_queue", True):
            try:
                backend_name, _backend_model_id, body_for_backend, canonical_model = await resolve_and_prepare(body)
            except ValueError as e:
                raise HTTPException(status_code=503, detail=str(e) or "Aucun backend activé")
            if backend_name in CLOUD_BACKENDS:
                request_id = str(uuid.uuid4())[:8]
                logger.info("Cloud bypass: model=%s backend=%s user=%s (request %s)", model, backend_name, user_id, request_id)
                return await _dispatch_cloud_direct(
                    body_for_backend=body_for_backend,
                    backend_name=backend_name,
                    canonical_model=canonical_model,
                    stream=stream,
                    request_id=request_id,
                    user_id=user_id,
                    config=config,
                )

        try:
            if stream:
                stream_queue: asyncio.Queue = asyncio.Queue()
                item = await enqueue(body, stream=True, stream_queue=stream_queue, user_id=user_id, priority=priority, threshold=threshold)

                async def stream_response():
                    # completed=True une fois le stream drainé normalement (sentinelle None
                    # reçue + erreur worker éventuelle forwardée). S'il reste False quand le
                    # générateur se termine (return sur déconnexion détectée, GeneratorExit
                    # quand Starlette finalise le générateur sur drop TCP, ou CancelledError),
                    # c'est que le client est parti avant la fin → on annule le worker pour ne
                    # pas gaspiller le GPU et ne pas bloquer la file sérielle en tête de ligne.
                    completed = False
                    try:
                        while True:
                            try:
                                chunk = await asyncio.wait_for(stream_queue.get(), timeout=1.0)
                            except asyncio.TimeoutError:
                                if await request.is_disconnected():
                                    logger.info("Client déconnecté pendant le stream (requête %s)", item.request_id)
                                    return
                                continue
                            if chunk is None:
                                break
                            yield chunk
                        # Si le worker a levé (ex. 400 Ollama), renvoyer l'erreur en SSE pour que le client la reçoive
                        try:
                            await asyncio.wait_for(item.response_future, timeout=0.5)
                        except Exception:
                            pass
                        if item.response_future.done() and item.response_future.exception() is not None:
                            err = item.response_future.exception()
                            if isinstance(err, BackendRequestFailed):
                                yield f"data: {json.dumps({'error': {'message': err.detail or str(err), 'code': err.status_code}}, ensure_ascii=False)}\n\n"
                            elif not isinstance(err, asyncio.CancelledError):
                                # Toute autre exception worker (réseau, parse, RuntimeError…)
                                # était silencieusement avalée : le client recevait un stream
                                # tronqué sans event d'erreur et rien n'était logué côté route.
                                # On log en verbose ET on émet un event d'erreur SSE terminal.
                                logger.exception(
                                    "Erreur worker pendant le stream (requête %s): %s",
                                    item.request_id, err,
                                )
                                yield f"data: {json.dumps({'error': {'message': str(err) or 'Erreur interne worker', 'code': 500}}, ensure_ascii=False)}\n\n"
                        completed = True
                    except asyncio.CancelledError:
                        return
                    finally:
                        # Convergence unique (return / GeneratorExit / CancelledError / fin
                        # normale). cancel_request_if_current est idempotent et ciblé : il ne
                        # tue le worker que s'il traite ENCORE cette requête (pas de course
                        # avec une autre requête déjà dépilée).
                        if not completed:
                            cancel_request_if_current(item.request_id)

                return StreamingResponse(
                    stream_response(),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
                )
            else:
                item = await enqueue(body, stream=False, user_id=user_id, priority=priority, threshold=threshold)
                result = await item.response_future
                if isinstance(result, Exception):
                    raise result
                if not isinstance(result, BackendResult):
                    raise HTTPException(status_code=500, detail="Invalid backend result")
                return JSONResponse(content=result.body, status_code=result.status_code)
        except ValueError as e:
            if "Queue full" in str(e):
                logger.warning("File pleine")
                raise HTTPException(status_code=503, detail="Queue full")
            raise HTTPException(status_code=400, detail=str(e))
        except asyncio.CancelledError:
            raise
        except BackendRequestFailed as e:
            raise HTTPException(status_code=e.status_code, detail=e.detail or str(e))
        except Exception as e:
            logger.exception("Erreur chat completions: %s", e)
            raise HTTPException(status_code=500, detail=str(e))
