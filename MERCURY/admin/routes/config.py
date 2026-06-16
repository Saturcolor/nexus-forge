"""Routes admin : version, debug, config (GET/POST)."""
import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from routing.router import get_config, load_config, set_debug
from config.version import __version__
from data.db import SETTINGS_KEYS, set_settings, set_model_mapping, set_model_routes, set_hidden_models
from routing.router import apply_db_overrides
from admin.common import (
    json_safe,
    sanitize_config_for_get,
    merge_credits_for_post,
    load_config_raw,
    save_config,
)

logger = logging.getLogger("mercury")
router = APIRouter()


@router.get("/version")
def get_version():
    """Retourne la version du middleware + nombre de modèles chargés (running)."""
    from admin.routes.lm_studio import get_running_models_count
    return JSONResponse(content={
        "version": __version__,
        "models_loaded": get_running_models_count(),
    })


@router.get("/debug")
def get_debug():
    """Retourne l'état du mode debug (logs des JSON reçus/envoyés)."""
    config = get_config()
    return JSONResponse(content={"debug": bool(config.get("debug", False))})


@router.patch("/debug")
async def set_debug_route(request: Request):
    """Active/désactive le mode debug. Body: {"debug": true|false}. Pris en compte immédiatement."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("Body doit être un objet JSON")
        enabled = body.get("debug")
        if enabled is None:
            raise ValueError("Champ 'debug' requis (true/false)")
        set_debug(bool(enabled))
        return JSONResponse(content={"debug": bool(get_config().get("debug", False))})
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/config")
def get_config_route():
    try:
        config = get_config()
        sanitized = sanitize_config_for_get(config)
        return JSONResponse(content=sanitized)
    except Exception as e:
        logger.exception("GET /admin/config: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.post("/config")
async def post_config(request: Request):
    """Enregistre la config dans config.yaml. Les clés credits (API keys, snapshots) sont conservées depuis le fichier."""
    try:
        body = await request.json()
        incoming = json_safe(body)
        current = load_config_raw()
        incoming.pop("admin_token_set", None)
        incoming.pop("openrouter_api_key_set", None)
        incoming.pop("atlas_atlasmind_api_key_set", None)
        if "admin_token" not in incoming and "admin_token" in current:
            incoming["admin_token"] = current["admin_token"]
        if "openrouter_api_key" not in incoming and "openrouter_api_key" in current:
            incoming["openrouter_api_key"] = current["openrouter_api_key"]
        # Atlas API key : préserver depuis le fichier (GET /config la masque en _set)
        if "atlas_atlasmind_api_key" not in incoming and "atlas_atlasmind_api_key" in current:
            incoming["atlas_atlasmind_api_key"] = current["atlas_atlasmind_api_key"]
        # Audio provider API keys : préserver depuis le fichier (même pattern)
        for audio_key in ("audio_openai_api_key", "audio_groq_api_key", "audio_elevenlabs_api_key"):
            if audio_key not in incoming and audio_key in current:
                incoming[audio_key] = current[audio_key]
        config = dict(current)
        for k, v in (incoming or {}).items():
            if k == "credits":
                continue
            config[k] = v
        if "credits" in incoming:
            config["credits"] = merge_credits_for_post(current.get("credits"), incoming.get("credits"))
        elif current.get("credits"):
            config["credits"] = current["credits"]
        # Options migrées en DB : persister dans db.json (priorité sur config.yaml au rechargement)
        db_updates = {k: config[k] for k in SETTINGS_KEYS if k in config}
        if db_updates:
            set_settings(db_updates)
        if "model_mapping" in incoming:
            set_model_mapping(config.get("model_mapping") or {})
        if "model_routes" in incoming:
            set_model_routes(config.get("model_routes") or [])
        if "hidden_models" in incoming:
            set_hidden_models(config.get("hidden_models") or [])
        await asyncio.to_thread(save_config, config)
        await asyncio.to_thread(apply_db_overrides)  # flush models_cache inclus
        return JSONResponse(content={"ok": True, "message": "Config saved"})
    except Exception as e:
        logger.exception("POST /admin/config: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})
