"""WebSocket route: `WS /v1/realtime`.

Mercury-side endpoint for the OpenAI Realtime API. Authenticates the client
with the standard Mercury Bearer token, opens an upstream WS to OpenAI
using Mercury's stored `audio_openai_api_key`, then bidirectionally pipes
frames. Per-turn usage is extracted from `response.done` events and logged
as a normal request entry in the dashboard DB (one row per turn — shares
a common `session_id` so the dashboard can aggregate if desired later).
"""
import logging
import time
import uuid

from fastapi import FastAPI, WebSocket
from starlette.websockets import WebSocketState

from auth import resolve_user
from routing.router import get_config
from providers.openai_realtime import connect_upstream, proxy_session
from providers.openai_realtime.backend import UpstreamConnectError, TurnUsage
from app_queue.request_queue import (
    log_api_request,
    register_api_request_in_progress,
    unregister_api_request_in_progress,
)

logger = logging.getLogger("mercury")

# Private WS close codes (4000-4999 range reserved for application use).
WS_CLOSE_AUTH_FAILED = 4401
WS_CLOSE_DISABLED = 4503
WS_CLOSE_BAD_REQUEST = 4400
WS_CLOSE_UPSTREAM_ERROR = 1011  # standard "internal error"

BACKEND_NAME = "openai_realtime"


async def _close_with_reason(ws: WebSocket, code: int, reason: str):
    """Close the WS with a code + reason. Safe to call before or after accept()."""
    try:
        if ws.client_state == WebSocketState.CONNECTING:
            # Pre-accept rejection: starlette closes with 403 by default,
            # but accepting then closing lets us send our custom code+reason.
            await ws.accept()
        if ws.application_state != WebSocketState.DISCONNECTED:
            await ws.close(code=code, reason=reason[:120])
    except Exception as e:
        logger.debug("realtime: close-with-reason failed (%s): %s", code, e)


def register(app: FastAPI):
    """Register the /v1/realtime WS endpoint on the given FastAPI app."""

    @app.websocket("/v1/realtime")
    async def realtime_ws(websocket: WebSocket):
        config = get_config()
        session_id = str(uuid.uuid4())[:12]

        # ── Auth ──────────────────────────────────────────────────────────
        authorization = websocket.headers.get("authorization")
        user_id, _priority, _threshold = resolve_user(authorization)
        # Reject anonymous/unknown AND empty user_id (defensive: a config entry
        # with `user_id: ""` would otherwise pass through).
        if user_id in ("anonymous", "unknown") or not user_id.strip():
            logger.info("realtime: auth failed session=%s", session_id)
            await _close_with_reason(websocket, WS_CLOSE_AUTH_FAILED, "auth failed")
            return

        # Slot guard (F1 rapport fonctionnel) : un slot exclusive doit aussi bloquer
        # le WebSocket Realtime, sinon un consumer non-autorisé contourne via realtime
        # pendant que /v1/chat/completions est bloqué.
        from scheduler import state as slot_state
        if slot_state.build_slot_rejection(user_id) is not None:
            logger.info("realtime: slot guard blocked user=%s session=%s", user_id, session_id)
            await _close_with_reason(websocket, WS_CLOSE_AUTH_FAILED, "slot reserved")
            return

        # ── Feature flag + key check ──────────────────────────────────────
        if not config.get("realtime_enabled", False):
            logger.info("realtime: disabled in config (user=%s session=%s)", user_id, session_id)
            await _close_with_reason(websocket, WS_CLOSE_DISABLED, "realtime disabled")
            return
        api_key = (config.get("audio_openai_api_key") or "").strip()
        if not api_key:
            logger.warning("realtime: no openai api key configured (session=%s)", session_id)
            await _close_with_reason(websocket, WS_CLOSE_DISABLED, "no openai api key")
            return

        # ── Query params ──────────────────────────────────────────────────
        qp = dict(websocket.query_params)
        model = (qp.get("model") or "").strip()
        if not model:
            await _close_with_reason(websocket, WS_CLOSE_BAD_REQUEST, "missing model query param")
            return
        # Forward all extra query params (defensive — future OpenAI flags).
        extra = {k: v for k, v in qp.items() if k != "model"}

        # ── Open upstream BEFORE accepting client (so we can surface errors clean) ──
        try:
            upstream = await connect_upstream(model=model, api_key=api_key, extra_query=extra)
        except UpstreamConnectError as e:
            logger.warning("realtime: upstream connect failed session=%s err=%s", session_id, e)
            await _close_with_reason(websocket, WS_CLOSE_UPSTREAM_ERROR, f"upstream: {e}")
            log_api_request(
                request_id=session_id,
                user_id=user_id,
                model=model,
                backend=BACKEND_NAME,
                status="error",
                error_detail=str(e)[:500],
            )
            return

        # ── Accept client, run the pipe ───────────────────────────────────
        # From here onwards, `upstream` is open — every path below MUST close
        # it. We also track whether the in-progress registration happened so
        # the unregister only fires if needed (avoids ghost entries).
        t0 = time.perf_counter()
        turn_count = {"n": 0}
        registered = False
        stats: dict = {"turns": 0, "close_reason": "ok"}

        async def on_turn_done(turn: TurnUsage):
            turn_count["n"] += 1
            turn_id = f"{session_id}-{turn_count['n']:03d}"
            # Wrap session_id into usage so logs can be grouped per-session.
            usage_logged = dict(turn.usage)
            usage_logged["session_id"] = session_id
            usage_logged["response_id"] = turn.response_id
            log_api_request(
                request_id=turn_id,
                user_id=user_id,
                model=model,
                backend=BACKEND_NAME,
                status="ok",
                duration_ms=None,
                usage=usage_logged,
            )

        try:
            await websocket.accept()
            logger.info(
                "realtime: session opened user=%s model=%s session=%s",
                user_id, model, session_id,
            )
            await register_api_request_in_progress(session_id, model, user_id, BACKEND_NAME)
            registered = True
            stats = await proxy_session(websocket, upstream, on_turn_done=on_turn_done)
        except Exception as e:
            logger.exception("realtime: session crashed session=%s: %s", session_id, e)
            stats = {"turns": 0, "close_reason": f"crash:{type(e).__name__}"}
        finally:
            if registered:
                await unregister_api_request_in_progress(session_id)
            try:
                await upstream.close()
            except Exception:
                pass
            if websocket.application_state != WebSocketState.DISCONNECTED:
                try:
                    await websocket.close()
                except Exception:
                    pass

        duration_ms = (time.perf_counter() - t0) * 1000.0
        logger.info(
            "realtime: session closed user=%s model=%s session=%s turns=%d "
            "c2u=%d u2c=%d duration_ms=%.0f reason=%s",
            user_id, model, session_id,
            stats.get("turns", 0),
            stats.get("frames_client_to_upstream", 0),
            stats.get("frames_upstream_to_client", 0),
            duration_ms,
            stats.get("close_reason", "ok"),
        )
        # Final session-level log (turns logged separately above): mark a closing
        # entry with duration so the dashboard sees the session end.
        # Only if 0 turns happened, log an "empty" line so the session is visible.
        if stats.get("turns", 0) == 0:
            log_api_request(
                request_id=session_id,
                user_id=user_id,
                model=model,
                backend=BACKEND_NAME,
                status="ok",
                duration_ms=duration_ms,
                usage={"session_id": session_id, "turns": 0, "close_reason": stats.get("close_reason", "ok")},
            )
