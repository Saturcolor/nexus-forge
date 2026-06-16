"""Routes admin : statut pour AMREVOLT (pilotage des calls LLM)."""
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app_queue.request_queue import get_queue_stats
from routing.router import get_config
from admin.common import json_safe

logger = logging.getLogger("mercury")
router = APIRouter(prefix="/amrevolt")


@router.get("/status")
def amrevolt_status():
    """Statut Mercury pour AMREVOLT : autorise/bloque les calls, modèles dispo, fallback.

    AMREVOLT poll cet endpoint avant chaque cycle de reasoning pour savoir
    s'il peut envoyer des calls LLM.
    """
    try:
        config = get_config()
        queue = get_queue_stats()

        queue_size = int(queue.get("size", 0) or 0)
        in_progress = int(queue.get("in_progress", 0) or 0)
        queue_max = int(config.get("queue_max_size", 100))
        threshold_active = queue.get("threshold_active", False)

        # can_call : queue pas pleine et pas de threshold actif
        can_call = (in_progress + queue_size) < queue_max and not threshold_active

        # Modèles disponibles (depuis le cache Mercury)
        available_models = []
        try:
            from routing.models_cache import get_cached_models
            cached = get_cached_models()
            available_models = [m.get("name") or m.get("model") for m in cached if (m.get("name") or m.get("model"))]
        except Exception:
            pass

        # Fallback cloud disponible ?
        fallback_available = False
        openrouter_enabled = config.get("openrouter_enabled", False)
        openrouter_key = (config.get("openrouter_api_key") or "").strip()
        if openrouter_enabled and openrouter_key:
            fallback_available = True
        if not fallback_available:
            anthropic_enabled = config.get("anthropic_enabled", False)
            if anthropic_enabled:
                fallback_available = True

        # Backend actif (premier backend local up)
        active_backend = "none"
        try:
            from core.backends_health import is_backend_up
            import asyncio
            for name in ("lm_studio", "llamacpp", "ollama", "mlx"):
                if config.get(f"{name}_enabled", True if name != "mlx" else False):
                    active_backend = name
                    break
        except Exception:
            pass

        return JSONResponse(content=json_safe({
            "can_call": can_call,
            "queue_size": queue_size,
            "queue_max": queue_max,
            "in_progress": in_progress,
            "threshold_active": threshold_active,
            "active_backend": active_backend,
            "available_models": available_models,
            "fallback_available": fallback_available,
        }))
    except Exception as e:
        logger.exception("GET /admin/amrevolt/status: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e)})
