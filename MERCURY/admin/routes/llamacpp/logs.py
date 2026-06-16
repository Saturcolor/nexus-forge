"""Routes logs : /daemon-logs, /logs/{id}, /logs-stream/{id}."""
import json
import logging

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from ._common import llamacpp_base, DAEMON_TIMEOUT

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/llamacpp/daemon-logs")
async def get_llamacpp_daemon_logs(last: int = 200):
    """Logs internes du daemon llamacpp (démarrage, load/unload, erreurs)."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(content={"logs": [], "error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=DAEMON_TIMEOUT) as client:
            r = await client.get(f"{base}/mgmt/daemon-logs", params={"last": last})
        if r.status_code == 200:
            return JSONResponse(content=r.json())
        return JSONResponse(content={"logs": [], "error": r.text[:200]})
    except httpx.ConnectError:
        return JSONResponse(content={"logs": [], "error": "Daemon inaccessible."})
    except Exception as e:
        return JSONResponse(content={"logs": [], "error": str(e)})


@router.get("/llamacpp/logs/{model_id:path}")
async def get_llamacpp_logs(model_id: str, last: int = 100):
    """Dernières lignes de log d'une instance."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=DAEMON_TIMEOUT) as client:
            r = await client.get(f"{base}/mgmt/logs/{model_id}", params={"last": last})
        if r.status_code == 404:
            return JSONResponse(status_code=404, content={"detail": f"Modèle non chargé: {model_id}"})
        return JSONResponse(content=r.json())
    except Exception as e:
        logger.exception("GET /admin/llamacpp/logs/%s: %s", model_id, e)
        return JSONResponse(status_code=500, content={"detail": str(e)})


@router.get("/llamacpp/logs-stream/{model_id:path}")
async def get_llamacpp_logs_stream(model_id: str):
    """Proxy SSE du stream de logs d'une instance."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "llamacpp désactivé"})

    async def generate():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", f"{base}/mgmt/logs-stream/{model_id}") as resp:
                    if resp.status_code != 200:
                        yield f"data: {json.dumps({'error': f'daemon returned {resp.status_code}'})}\n\n"
                        return
                    async for chunk in resp.aiter_bytes():
                        yield chunk
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)[:200]})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
