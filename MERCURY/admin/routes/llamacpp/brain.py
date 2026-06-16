"""Routes brain-settings (GET/PUT), reboot, et helpers de push au démarrage."""
import logging

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from data import db as db_module

from ._common import llamacpp_base

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/llamacpp/brain-settings")
async def get_brain_settings():
    """Retourne les settings brain persistés dans la DB Mercury."""
    settings = db_module.get_brain_settings()
    return JSONResponse(content=settings)


@router.put("/llamacpp/brain-settings")
async def put_brain_settings(body: dict):
    """Met à jour les settings brain dans la DB Mercury ET les pousse au brain-daemon.
    Body (partiel) : { "thermal_auto_start": true, "perf_mode": "performance", "thermal_thresholds": {...} }
    """
    settings = db_module.set_brain_settings(body)
    # Pousser au brain-daemon
    push_result = await _push_brain_settings(settings)
    return JSONResponse(content={"settings": settings, "push": push_result})


async def _push_brain_settings(settings: dict) -> dict:
    """Pousse les settings au brain-daemon (thermal config + perf mode + thermal start/stop)."""
    base = llamacpp_base()
    if not base:
        return {"ok": False, "error": "llamacpp disabled"}
    results = {}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            # 1. Thermal thresholds
            thresholds = settings.get("thermal_thresholds")
            if thresholds and isinstance(thresholds, dict):
                try:
                    r = await client.post(f"{base}/thermal/config", json=thresholds)
                    results["thermal_config"] = r.json() if r.status_code == 200 else {"error": r.text[:200]}
                except Exception as e:
                    results["thermal_config"] = {"error": str(e)}

            # 2. Perf mode
            perf_mode = settings.get("perf_mode")
            if perf_mode in ("performance", "turbo", "optimized", "custom", "eco"):
                try:
                    r = await client.post(f"{base}/perf/{perf_mode}")
                    results["perf"] = r.json() if r.status_code == 200 else {"error": r.text[:200]}
                except Exception as e:
                    results["perf"] = {"error": str(e)}

            # 3. Thermal auto start/stop
            thermal_auto = settings.get("thermal_auto_start")
            if thermal_auto is True:
                try:
                    r = await client.post(f"{base}/thermal/start")
                    results["thermal_start"] = r.json() if r.status_code == 200 else {"error": r.text[:200]}
                except Exception as e:
                    results["thermal_start"] = {"error": str(e)}

            # 4. Memory thresholds
            mem_thresholds = settings.get("memory_thresholds")
            if mem_thresholds and isinstance(mem_thresholds, dict):
                try:
                    r = await client.patch(f"{base}/memory/config", json=mem_thresholds)
                    results["memory_config"] = r.json() if r.status_code == 200 else {"error": r.text[:200]}
                except Exception as e:
                    results["memory_config"] = {"error": str(e)}

            # 5. Memory auto start
            memory_auto = settings.get("memory_auto_start")
            if memory_auto is True:
                try:
                    r = await client.post(f"{base}/memory/start")
                    results["memory_start"] = r.json() if r.status_code == 200 else {"error": r.text[:200]}
                except Exception as e:
                    results["memory_start"] = {"error": str(e)}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    # ok = True seulement si AUCUN sous-push n'a remonté d'erreur (AND des sous-résultats).
    # Avant : ok était forcé à True dès que le bloc try n'avait pas levé, masquant les
    # échecs HTTP non-200 (ex. perf_mode rejeté) au caller.
    failed = [k for k, v in results.items() if isinstance(v, dict) and "error" in v]
    results["ok"] = not failed
    if failed:
        logger.warning("Brain settings push: sous-push en échec: %s", failed)
    return results


async def push_brain_settings_on_startup():
    """Appelé au démarrage de Mercury pour appliquer les settings brain persistés."""
    settings = db_module.get_brain_settings()
    if not settings:
        return
    # Ne pousser que si quelque chose est configuré.
    # NB: aligné sur le set de modes accepté par _push_brain_settings (l.53) — sinon
    # un perf_mode persisté turbo/optimized/custom était silencieusement ignoré au boot.
    has_config = (
        settings.get("thermal_auto_start") is True
        or settings.get("perf_mode") in ("performance", "turbo", "optimized", "custom", "eco")
        or settings.get("thermal_thresholds")
        or settings.get("memory_auto_start") is True
        or settings.get("memory_thresholds")
    )
    if has_config:
        result = await _push_brain_settings(settings)
        logger.info("Brain settings pushed on startup: %s", result)


@router.post("/llamacpp/reboot")
async def post_brain_reboot():
    """Proxy vers POST /reboot du brain-daemon (systemctl restart)."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(f"{base}/reboot")
        # Garde r.json() derrière status 200 (cf _push_brain_settings) : une réponse
        # non-200 / non-JSON lèverait sinon dans l'except générique et masquerait l'erreur.
        content = r.json() if r.status_code == 200 else {"error": r.text[:200], "status": r.status_code}
        return JSONResponse(status_code=r.status_code, content=content)
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
