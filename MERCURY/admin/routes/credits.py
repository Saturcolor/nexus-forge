"""Routes admin : credits, credits/totals."""
import logging

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from routing.router import get_config
from credits.credits import fetch_all_credits
from admin.common import json_safe

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/credits")
async def get_credits(
    providers: str | None = Query(None, description="openrouter,openai,anthropic"),
    timeout_ms: int = Query(30000, ge=5000, le=120000),
):
    """Rapport crédits (OPENBILL). Nécessite credits.enabled et clés dans config."""
    try:
        config = get_config()
        if not (config.get("credits") or {}).get("enabled", False):
            return JSONResponse(
                status_code=403,
                content={"detail": "Crédits désactivés (credits.enabled dans config)"},
            )
        plist = [p.strip() for p in providers.split(",")] if providers else None
        report = await fetch_all_credits(providers=plist, timeout_ms=timeout_ms)
        return JSONResponse(content=json_safe(report))
    except Exception as e:
        logger.exception("GET /admin/credits: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.get("/credits/totals")
async def get_credits_totals(
    providers: str | None = Query(None, description="openrouter,openai,anthropic"),
    timeout_ms: int = Query(30000, ge=5000, le=120000),
):
    """Totaux crédits (restant total + par provider)."""
    try:
        config = get_config()
        if not (config.get("credits") or {}).get("enabled", False):
            return JSONResponse(
                status_code=403,
                content={"detail": "Crédits désactivés (credits.enabled dans config)"},
            )
        plist = [p.strip() for p in providers.split(",")] if providers else None
        report = await fetch_all_credits(providers=plist, timeout_ms=timeout_ms)
        p = report.get("providers") or {}
        remaining = {}
        total_remaining = None
        # ElevenLabs reporte en caractères (pas USD) — exclu du total USD
        _USD_PROVIDERS = {"openrouter", "openai", "anthropic"}
        for name in ["openrouter", "openai", "anthropic", "elevenlabs"]:
            prov = p.get(name)
            r = None
            if prov and prov.get("ok") and "remaining" in prov and prov["remaining"] is not None:
                try:
                    r = float(prov["remaining"])
                    if name in _USD_PROVIDERS:
                        total_remaining = (total_remaining or 0) + r
                except (TypeError, ValueError):
                    pass
            remaining[name] = r
        return JSONResponse(content=json_safe({
            "fetchedAt": report.get("fetchedAt"),
            "totalRemaining": total_remaining,
            "remaining": remaining,
            "errors": report.get("errors") or [],
        }))
    except Exception as e:
        logger.exception("GET /admin/credits/totals: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})
