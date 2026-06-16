"""Routes /thermal/* et /perf/* — controle thermique et modes de performance."""
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from thermal import perf_manager

logger = logging.getLogger("brain-daemon")
router = APIRouter()

# Reference au thermal controller (initialisee par daemon.py)
_thermal_controller = None


def set_thermal_controller(controller):
    global _thermal_controller
    _thermal_controller = controller


# ── Thermal ───────────────────────────────────────────────────────────────────

@router.get("/thermal/status")
async def thermal_status():
    if _thermal_controller is None:
        return JSONResponse(content={"running": False, "error": "controller not initialized"})
    return JSONResponse(content=_thermal_controller.get_status())


@router.post("/thermal/start")
async def thermal_start():
    if _thermal_controller is None:
        return JSONResponse(status_code=500, content={"error": "controller not initialized"})
    _thermal_controller.start()
    return JSONResponse(content={"status": "started"})


@router.post("/thermal/stop")
async def thermal_stop():
    if _thermal_controller is None:
        return JSONResponse(status_code=500, content={"error": "controller not initialized"})
    _thermal_controller.stop()
    return JSONResponse(content={"status": "stopped"})


@router.post("/thermal/config")
async def thermal_config(body: dict):
    """Modifie les seuils thermiques a chaud.
    Body: { "throttle_start_c": 65, "throttle_full_c": 85, "emergency_c": 95, "resume_c": 60 }
    """
    if _thermal_controller is None:
        return JSONResponse(status_code=500, content={"error": "controller not initialized"})
    if "throttle_start_c" in body:
        _thermal_controller.T_THROTTLE_START = int(body["throttle_start_c"])
    if "throttle_full_c" in body:
        _thermal_controller.T_THROTTLE_FULL = int(body["throttle_full_c"])
    if "emergency_c" in body:
        _thermal_controller.T_EMERGENCY = int(body["emergency_c"])
    if "resume_c" in body:
        _thermal_controller.T_RESUME = int(body["resume_c"])
    logger.info("Thermal config updated: start=%d full=%d emergency=%d resume=%d",
                _thermal_controller.T_THROTTLE_START, _thermal_controller.T_THROTTLE_FULL,
                _thermal_controller.T_EMERGENCY, _thermal_controller.T_RESUME)
    return JSONResponse(content=_thermal_controller.get_status())


# ── Performance ───────────────────────────────────────────────────────────────

@router.post("/perf/{mode}")
async def perf_set(mode: str):
    """Set perf mode: performance, optimized, eco."""
    if mode not in ("performance", "turbo", "optimized", "custom", "eco"):
        return JSONResponse(status_code=400, content={"error": f"mode invalide: {mode}"})
    # Auto-start thermal pour tout sauf eco
    if mode in ("performance", "turbo", "optimized", "custom"):
        if _thermal_controller is not None and not _thermal_controller.running:
            _thermal_controller.start()
            logger.info("Thermal auto-started (mode %s requires thermal protection)", mode)
    result = await perf_manager.set_mode(mode)
    result["thermal_auto_started"] = mode in ("performance", "optimized")
    return JSONResponse(content=result)


@router.get("/perf/status")
async def perf_status():
    result = await perf_manager.get_status()
    return JSONResponse(content=result)


@router.post("/perf/custom")
async def perf_custom(body: dict):
    """Applique le mode custom avec STAPM et tctl specifiques.
    Body: { "stapm_w": 150, "tctl_c": 95 }
    """
    stapm = body.get("stapm_w")
    tctl = body.get("tctl_c")

    if stapm is not None:
        stapm = int(stapm)
        if stapm < 30 or stapm > 300:
            return JSONResponse(status_code=400, content={"error": f"stapm hors limites (30-300W): {stapm}"})
        perf_manager.set_custom_stapm(stapm)
    if tctl is not None:
        tctl = int(tctl)
        if tctl < 60 or tctl > 105:
            return JSONResponse(status_code=400, content={"error": f"tctl hors limites (60-105°C): {tctl}"})
        perf_manager.set_custom_tctl(tctl)

    # Auto-start thermal
    if _thermal_controller is not None and not _thermal_controller.running:
        _thermal_controller.start()

    result = await perf_manager.set_mode("custom")
    result["custom_stapm_w"] = perf_manager._custom_stapm_w
    result["custom_tctl_c"] = perf_manager._custom_tctl_c
    return JSONResponse(content=result)
