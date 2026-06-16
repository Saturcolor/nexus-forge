"""Routes KV cache (save / delete)."""
import logging

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ._common import llamacpp_base

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/llamacpp/kv-cache/save/{model_id:path}")
async def post_llamacpp_kv_cache_save(model_id: str):
    """Sauvegarde manuellement le KV cache (slot 0) d'un modèle en cours d'exécution."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "llamacpp désactivé"})
    if not model_id:
        return JSONResponse(status_code=400, content={"detail": "model_id requis"})
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(f"{base}/mgmt/kv-cache/save/{model_id}")
        try:
            resp_body = r.json()
        except Exception:
            resp_body = {"error": r.text[:200] or str(r.status_code)}
        return JSONResponse(status_code=r.status_code, content=resp_body)
    except Exception as e:
        logger.exception("POST /admin/llamacpp/kv-cache/save/%s: %s", model_id, e)
        return JSONResponse(status_code=500, content={"detail": str(e)})


@router.delete("/llamacpp/kv-cache/{model_id:path}")
async def delete_llamacpp_kv_cache(model_id: str):
    """Supprime le fichier KV cache sauvegardé pour ce modèle."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "llamacpp désactivé"})
    if not model_id:
        return JSONResponse(status_code=400, content={"detail": "model_id requis"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.delete(f"{base}/mgmt/kv-cache/{model_id}")
        try:
            resp_body = r.json()
        except Exception:
            resp_body = {"error": r.text[:200] or str(r.status_code)}
        return JSONResponse(status_code=r.status_code, content=resp_body)
    except Exception as e:
        logger.exception("DELETE /admin/llamacpp/kv-cache/%s: %s", model_id, e)
        return JSONResponse(status_code=500, content={"detail": str(e)})
