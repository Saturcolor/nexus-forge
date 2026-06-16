"""Routes updater (toolbox / backends + Lucebox sub-updater)."""
import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ._common import llamacpp_base

router = APIRouter()


@router.get("/llamacpp/updater/status")
async def get_updater_status():
    """Proxy vers GET /updater/status du brain-daemon."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(f"{base}/updater/status")
        return JSONResponse(status_code=r.status_code, content=r.json())
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/llamacpp/updater/{action}/{backend}")
async def post_updater_action(action: str, backend: str):
    """Proxy vers POST /updater/{pull|build|backup|restore}/{backend} du brain-daemon."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    if action not in ("pull", "build", "backup", "restore"):
        return JSONResponse(status_code=400, content={"error": f"action invalide: {action}"})
    try:
        timeout = 3600.0 if action == "build" else 600.0
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(f"{base}/updater/{action}/{backend}")
        return JSONResponse(status_code=r.status_code, content=r.json())
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ── Lucebox sub-updater ──────────────────────────────────────────────────────
# Le brain-daemon expose un sub-updater dédié pour le fork Lucebox/DFlash :
#   GET  /updater/lucebox/status  → { local_sha, remote_sha, behind, build_exists,
#                                     in_progress, phase, log_tail }
#   POST /updater/lucebox/update  → blocking ~3-5min (git pull + submodule + cmake)
#   POST /updater/lucebox/build   → cmake-only rebuild
#   GET  /updater/lucebox/log     → { log: string[], in_progress, phase }
#
# Le daemon ne gère PAS l'auto-reload des instances Lucebox running après update —
# c'est à Mercury (côté UI, snapshot avant trigger → unload/load après succès).


@router.get("/llamacpp/updater/lucebox/status")
async def get_lucebox_updater_status():
    """Proxy vers GET /updater/lucebox/status (fetch git remote inclus, ~1-3s)."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        # 15s : le daemon git-fetche à chaque appel (réseau).
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(f"{base}/updater/lucebox/status")
        return JSONResponse(status_code=r.status_code, content=r.json())
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/llamacpp/updater/lucebox/log")
async def get_lucebox_updater_log():
    """Proxy vers GET /updater/lucebox/log (buffer 2000 lignes, poll 500ms-1s)."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/updater/lucebox/log")
        return JSONResponse(status_code=r.status_code, content=r.json())
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/llamacpp/updater/lucebox/update")
async def post_lucebox_updater_update():
    """Proxy vers POST /updater/lucebox/update (blocking ~3-5min : git+submodule+cmake)."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        # 10min de marge : 3-5min nominal mais peut allonger sur premier build après wipe.
        async with httpx.AsyncClient(timeout=600.0) as client:
            r = await client.post(f"{base}/updater/lucebox/update")
        return JSONResponse(status_code=r.status_code, content=r.json())
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/llamacpp/updater/lucebox/build")
async def post_lucebox_updater_build():
    """Proxy vers POST /updater/lucebox/build (cmake-only rebuild, skip git pull)."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            r = await client.post(f"{base}/updater/lucebox/build")
        return JSONResponse(status_code=r.status_code, content=r.json())
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
