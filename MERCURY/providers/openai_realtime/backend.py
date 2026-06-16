"""OpenAI Realtime WebSocket proxy backend.

Pipeline: Mercury client WS  <-->  Mercury  <-->  OpenAI Realtime WS

Mercury holds the OpenAI API key and injects it on the upstream side. The
client only needs Mercury auth. Frames are forwarded verbatim; the only
Mercury-side interpretation is parsing `response.done` for usage logging.

Concurrency model: one asyncio.Task per direction, joined via gather.
When either side closes (clean or error), we cancel the other and
return — letting the route handler perform final logging + DB write.
"""
import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlencode

import websockets
from fastapi import WebSocket, WebSocketDisconnect
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger("mercury")

OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime"
# Time to wait for the upstream handshake before bailing.
UPSTREAM_CONNECT_TIMEOUT = 15.0


@dataclass
class TurnUsage:
    """Aggregated usage from a single `response.done` event."""
    response_id: Optional[str]
    usage: dict
    received_at: float = field(default_factory=time.time)


class UpstreamConnectError(Exception):
    """Raised when Mercury cannot establish the upstream WS (network/auth/HTTP)."""

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


async def connect_upstream(model: str, api_key: str, extra_query: Optional[dict] = None):
    """Open the WS to OpenAI Realtime. Returns the connected client.

    Caller owns the lifecycle (must close). Raises UpstreamConnectError on
    handshake failure so the route can translate to a clean WS close code.
    """
    query: dict = {"model": model}
    if extra_query:
        # Forward arbitrary passthrough query params (e.g. future OpenAI flags).
        for k, v in extra_query.items():
            if k == "model":
                continue
            query[k] = v
    url = f"{OPENAI_REALTIME_URL}?{urlencode(query)}"
    # No `OpenAI-Beta: realtime=v1` header: that header routes to the legacy
    # beta endpoint which only serves `gpt-4o-realtime-preview-*`. The GA
    # `gpt-realtime*` family (incl. `gpt-realtime-translate`) lives at the
    # same URL but without the header. Dropping the header gives us access
    # to GA models; preview models become unreachable, which is fine for v1.
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        upstream = await asyncio.wait_for(
            websockets.connect(url, additional_headers=headers, max_size=None),
            timeout=UPSTREAM_CONNECT_TIMEOUT,
        )
    except asyncio.TimeoutError as e:
        raise UpstreamConnectError(f"Upstream connect timeout after {UPSTREAM_CONNECT_TIMEOUT}s") from e
    except websockets.InvalidStatus as e:
        status = getattr(e.response, "status_code", None)
        raise UpstreamConnectError(f"Upstream HTTP {status}", status_code=status) from e
    except Exception as e:
        raise UpstreamConnectError(f"Upstream connect failed: {type(e).__name__}: {e}") from e
    return upstream


def extract_usage(message_text: str) -> Optional[TurnUsage]:
    """Parse a server→client frame; return TurnUsage if it's `response.done`, else None.

    Cheap: only parses JSON for frames that mention `response.done`. The marker
    is searched across the whole frame (PAS une fenêtre de 80 chars) car l'ordre
    des clés JSON d'OpenAI n'est pas contractuel : un `event_id` long sérialisé
    avant `type` repoussait `"response.done"` au-delà de l'ancienne fenêtre →
    frame silencieusement droppée, usage perdu. Le `type == "response.done"`
    confirmé après json.loads écarte les faux positifs (mention dans un payload).
    """
    if not message_text or '"response.done"' not in message_text:
        return None
    try:
        data = json.loads(message_text)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict) or data.get("type") != "response.done":
        return None
    response = data.get("response") or {}
    usage = response.get("usage") or {}
    if not isinstance(usage, dict) or not usage:
        return None
    return TurnUsage(response_id=response.get("id"), usage=usage)


async def proxy_session(
    client_ws: WebSocket,
    upstream,
    on_turn_done,
) -> dict:
    """Bidirectional pipe between an accepted client WS and an open upstream WS.

    `on_turn_done(TurnUsage)` is invoked for each `response.done` extracted from
    the upstream stream. The callback may be async.

    Returns a session stats dict on exit: {turns, frames_client_to_upstream,
    frames_upstream_to_client, close_reason}.
    """
    stats = {
        "turns": 0,
        "frames_client_to_upstream": 0,
        "frames_upstream_to_client": 0,
        "close_reason": "ok",
    }

    async def client_to_upstream():
        try:
            while True:
                # FastAPI WS: receive() returns dict with "type" (websocket.receive)
                # and either "text" or "bytes". OpenAI Realtime is text-only by
                # spec, but we forward binary too defensively.
                msg = await client_ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    return
                if "text" in msg and msg["text"] is not None:
                    await upstream.send(msg["text"])
                    stats["frames_client_to_upstream"] += 1
                elif "bytes" in msg and msg["bytes"] is not None:
                    await upstream.send(msg["bytes"])
                    stats["frames_client_to_upstream"] += 1
        except WebSocketDisconnect:
            return
        except ConnectionClosed:
            return
        except Exception as e:
            logger.warning("realtime: client->upstream pump error: %s", e)
            stats["close_reason"] = f"client_pump_error:{type(e).__name__}"
            return

    async def upstream_to_client():
        try:
            async for frame in upstream:
                if isinstance(frame, str):
                    # Try to extract usage before forwarding (zero copy, zero delay)
                    turn = extract_usage(frame)
                    await client_ws.send_text(frame)
                    stats["frames_upstream_to_client"] += 1
                    if turn is not None:
                        stats["turns"] += 1
                        try:
                            res = on_turn_done(turn)
                            if asyncio.iscoroutine(res):
                                await res
                        except Exception as cb_err:
                            logger.warning("realtime: on_turn_done callback failed: %s", cb_err)
                else:
                    await client_ws.send_bytes(frame)
                    stats["frames_upstream_to_client"] += 1
        except ConnectionClosed:
            return
        except WebSocketDisconnect:
            return
        except Exception as e:
            logger.warning("realtime: upstream->client pump error: %s", e)
            stats["close_reason"] = f"upstream_pump_error:{type(e).__name__}"
            return

    pump_client = asyncio.create_task(client_to_upstream(), name="rt-client-to-upstream")
    pump_upstream = asyncio.create_task(upstream_to_client(), name="rt-upstream-to-client")

    # try/finally : on annule TOUJOURS les deux pumps, peu importe le chemin de
    # sortie. Avant, si proxy_session elle-même était cancel (client drop brutal /
    # shutdown serveur pendant qu'on est parké sur asyncio.wait), le CancelledError
    # remontait sans toucher aux tâches enfants → pumps + sockets orphelins.
    try:
        await asyncio.wait(
            {pump_client, pump_upstream},
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        for task in (pump_client, pump_upstream):
            task.cancel()
        # Drain : gather avale CancelledError + erreurs, et re-yield la
        # cancellation du parent une fois les enfants nettoyés.
        await asyncio.gather(pump_client, pump_upstream, return_exceptions=True)

    return stats
