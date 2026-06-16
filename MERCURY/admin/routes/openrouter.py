"""Routes admin : santé / métriques / config dynamique pour le backend OpenRouter.

Endpoints :
- GET  /admin/openrouter/models                   liste modèles OR (api standard)
- GET  /admin/openrouter/health                   last_metrics + circuit breaker
- POST /admin/openrouter/circuit_breaker/reset    flush blacklist circuit breaker
- GET  /admin/openrouter/credits                  solde / quota OR (best effort)
"""
import logging

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from routing.router import get_config
from providers.openrouter import last_metrics, circuit_breaker

logger = logging.getLogger(__name__)
router = APIRouter()

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"


@router.get("/openrouter/models")
async def get_openrouter_models():
    """
    Récupère la liste des modèles OpenRouter (GET openrouter.ai/api/v1/models).
    Utilise openrouter_api_key (clé standard), pas la clé OpenBill/credits.
    """
    config = get_config()
    api_key = (config.get("openrouter_api_key") or "").strip()
    if not api_key:
        return JSONResponse(
            status_code=400,
            content={"detail": "Clé API OpenRouter manquante (openrouter_api_key dans la config)."},
        )
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                OPENROUTER_MODELS_URL,
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if resp.status_code != 200:
            text = (resp.text or "")[:500]
            logger.warning("OpenRouter GET /models: %s %s", resp.status_code, text)
            return JSONResponse(
                status_code=resp.status_code,
                content={"detail": f"OpenRouter API: {resp.status_code}", "data": []},
            )
        data = resp.json() if resp.content else {}
        if isinstance(data, dict) and "data" in data:
            return JSONResponse(content=data)
        return JSONResponse(content={"data": data if isinstance(data, list) else []})
    except Exception as e:
        logger.exception("OpenRouter GET models: %s", e)
        return JSONResponse(
            status_code=500,
            content={"detail": str(e), "data": []},
        )


@router.get("/openrouter/health")
async def get_openrouter_health():
    """Snapshot live du backend OpenRouter pour la UI :
    - last_metrics (par modèle, par upstream provider, in-flight)
    - circuit breaker (providers blacklisted + fail counts)
    - config fallback model courante
    - statut clé API présente (sans exposer la clé)
    """
    config = get_config()
    fb_cfg = config.get("openrouter_model_fallback") or {}
    return {
        "metrics": last_metrics.get_last_metrics(),
        "circuit_breaker": {
            "config": {
                "failure_window_s": circuit_breaker.FAILURE_WINDOW_S,
                "failure_threshold": circuit_breaker.FAILURE_THRESHOLD,
                "tracked_categories": sorted(circuit_breaker._PROVIDER_FAIL_CATEGORIES),
            },
            "providers": circuit_breaker.snapshot(),
            "blacklist": sorted(circuit_breaker.get_blacklist()),
        },
        "fallback": {
            "enabled": bool(fb_cfg.get("enabled")),
            "triggers": fb_cfg.get("triggers") or [],
            "chain": fb_cfg.get("chain") or [],
        },
        "api_key_set": bool((config.get("openrouter_api_key") or "").strip()),
    }


@router.post("/openrouter/circuit_breaker/reset")
async def reset_openrouter_circuit_breaker():
    """Vide la blacklist circuit breaker (admin manuel — utile si on a recovered
    plus vite que la fenêtre 5min, ou pour un test)."""
    circuit_breaker.reset()
    return {"reset": True, "providers": circuit_breaker.snapshot()}


@router.get("/openrouter/credits")
async def get_openrouter_credits():
    """Snapshot du solde OR (best effort — l'endpoint OR /credits peut bouger).
    Utile pour anticiper le 'Insufficient Balance' avant qu'il pète.
    """
    config = get_config()
    api_key = (config.get("openrouter_api_key") or "").strip()
    if not api_key:
        return JSONResponse(
            status_code=400,
            content={"detail": "Clé API OpenRouter manquante (openrouter_api_key dans la config)."},
        )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                OPENROUTER_CREDITS_URL,
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if resp.status_code != 200:
            text = (resp.text or "")[:300]
            logger.info("OpenRouter GET /credits: %s %s", resp.status_code, text)
            return JSONResponse(
                status_code=resp.status_code,
                content={"detail": f"OpenRouter API: {resp.status_code}", "raw": text},
            )
        data = resp.json() if resp.content else {}
        return JSONResponse(content=data)
    except Exception as e:
        logger.warning("OpenRouter GET credits: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e)})
