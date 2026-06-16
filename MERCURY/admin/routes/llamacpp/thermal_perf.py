"""Routes thermal / perf / brain-stats (proxy vers brain-daemon)."""
import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ._common import llamacpp_base

router = APIRouter()


@router.get("/llamacpp/thermal/status")
async def get_thermal_status():
    """Proxy vers GET /thermal/status du brain-daemon."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/thermal/status")
        # Garde r.json() derrière status 200 : une réponse non-200 / non-JSON
        # (erreur brain, HTML, body vide) lèverait sinon dans l'except générique
        # et masquerait l'erreur upstream réelle. cf get_brain_stats + brain.py.
        content = r.json() if r.status_code == 200 else {"error": r.text[:200], "status": r.status_code}
        return JSONResponse(status_code=r.status_code, content=content)
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/llamacpp/thermal/start")
async def post_thermal_start():
    """Proxy vers POST /thermal/start du brain-daemon."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(f"{base}/thermal/start")
        # Garde r.json() derrière status 200 : une réponse non-200 / non-JSON
        # (erreur brain, HTML, body vide) lèverait sinon dans l'except générique
        # et masquerait l'erreur upstream réelle. cf get_brain_stats + brain.py.
        content = r.json() if r.status_code == 200 else {"error": r.text[:200], "status": r.status_code}
        return JSONResponse(status_code=r.status_code, content=content)
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/llamacpp/thermal/stop")
async def post_thermal_stop():
    """Proxy vers POST /thermal/stop du brain-daemon."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(f"{base}/thermal/stop")
        # Garde r.json() derrière status 200 : une réponse non-200 / non-JSON
        # (erreur brain, HTML, body vide) lèverait sinon dans l'except générique
        # et masquerait l'erreur upstream réelle. cf get_brain_stats + brain.py.
        content = r.json() if r.status_code == 200 else {"error": r.text[:200], "status": r.status_code}
        return JSONResponse(status_code=r.status_code, content=content)
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/llamacpp/thermal/config")
async def post_thermal_config(body: dict):
    """Proxy vers POST /thermal/config du brain-daemon (modifier seuils à chaud)."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(f"{base}/thermal/config", json=body)
        # Garde r.json() derrière status 200 : une réponse non-200 / non-JSON
        # (erreur brain, HTML, body vide) lèverait sinon dans l'except générique
        # et masquerait l'erreur upstream réelle. cf get_brain_stats + brain.py.
        content = r.json() if r.status_code == 200 else {"error": r.text[:200], "status": r.status_code}
        return JSONResponse(status_code=r.status_code, content=content)
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/llamacpp/perf/custom")
async def post_perf_custom(body: dict):
    """Proxy vers POST /perf/custom du brain-daemon. Body: { stapm_w, tctl_c }"""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(f"{base}/perf/custom", json=body)
        # Garde r.json() derrière status 200 : une réponse non-200 / non-JSON
        # (erreur brain, HTML, body vide) lèverait sinon dans l'except générique
        # et masquerait l'erreur upstream réelle. cf get_brain_stats + brain.py.
        content = r.json() if r.status_code == 200 else {"error": r.text[:200], "status": r.status_code}
        return JSONResponse(status_code=r.status_code, content=content)
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/llamacpp/perf/status")
async def get_perf_status():
    """Proxy vers GET /perf/status du brain-daemon."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/perf/status")
        # Garde r.json() derrière status 200 : une réponse non-200 / non-JSON
        # (erreur brain, HTML, body vide) lèverait sinon dans l'except générique
        # et masquerait l'erreur upstream réelle. cf get_brain_stats + brain.py.
        content = r.json() if r.status_code == 200 else {"error": r.text[:200], "status": r.status_code}
        return JSONResponse(status_code=r.status_code, content=content)
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/llamacpp/perf/{mode}")
async def post_perf_mode(mode: str):
    """Proxy vers POST /perf/{performance|turbo|optimized|eco} du brain-daemon."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    if mode not in ("performance", "turbo", "optimized", "eco"):
        return JSONResponse(status_code=400, content={"error": f"mode invalide: {mode}"})
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(f"{base}/perf/{mode}")
        # Garde r.json() derrière status 200 : une réponse non-200 / non-JSON
        # (erreur brain, HTML, body vide) lèverait sinon dans l'except générique
        # et masquerait l'erreur upstream réelle. cf get_brain_stats + brain.py.
        content = r.json() if r.status_code == 200 else {"error": r.text[:200], "status": r.status_code}
        return JSONResponse(status_code=r.status_code, content=content)
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/llamacpp/brain-stats")
async def get_brain_stats():
    """Proxy vers GET /stats du brain-daemon (stats système unifiées)."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(content={"configured": False})
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/stats")
        if r.status_code != 200:
            return JSONResponse(content={"configured": True, "error": r.text[:200]})
        return JSONResponse(content={"configured": True, **r.json()})
    except httpx.ConnectError:
        return JSONResponse(content={"configured": True, "error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(content={"configured": True, "error": str(e)})
