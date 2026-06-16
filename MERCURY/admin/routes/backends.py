"""Routes admin : backends (statut), models (liste par backend), priorité des providers (mode auto)."""
import logging

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from routing.router import get_config, apply_db_overrides
from core.backends_health import BACKEND_CHECK_TIMEOUT_DEFAULT

logger = logging.getLogger(__name__)
router = APIRouter()

ALLOWED_BACKEND_NAMES = frozenset({"ollama", "mlx", "lm_studio", "llamacpp", "vllm", "lucebox", "openrouter"})
ALLOWED_CLOUD_PROVIDERS = frozenset({"openrouter", "anthropic"})


@router.get("/backends")
async def get_backends():
    try:
        config = get_config()
        timeout = float(config.get("health_check_timeout", BACKEND_CHECK_TIMEOUT_DEFAULT))
        ollama_url = config.get("ollama_url", "http://localhost:11434")
        mlx_url = config.get("mlx_url", "http://localhost:8080")
        result = []
        if config.get("ollama_enabled", True):
            url = str(ollama_url).rstrip("/")
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    r = await client.get(url)
                result.append({"name": "ollama", "url": url, "status": "up", "status_code": r.status_code})
            except Exception as e:
                result.append({"name": "ollama", "url": url, "status": "down", "error": str(e)})
        if config.get("mlx_enabled", True):
            url = str(mlx_url).rstrip("/")
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    r = await client.get(url)
                result.append({"name": "mlx", "url": url, "status": "up", "status_code": r.status_code})
            except Exception as e:
                result.append({"name": "mlx", "url": url, "status": "down", "error": str(e)})
        if config.get("lm_studio_enabled", True):
            lm_studio_url = str(config.get("lm_studio_url", "http://localhost:1234")).rstrip("/")
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    r = await client.get(f"{lm_studio_url}/api/v1/models")
                result.append({"name": "lm_studio", "url": lm_studio_url, "status": "up", "status_code": r.status_code})
            except Exception as e:
                result.append({"name": "lm_studio", "url": lm_studio_url, "status": "down", "error": str(e)})
        if config.get("llamacpp_enabled", True):
            llamacpp_url = str(config.get("llamacpp_url", "http://localhost:4321")).rstrip("/")
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    r = await client.get(f"{llamacpp_url}/health")
                result.append({"name": "llamacpp", "url": llamacpp_url, "status": "up", "status_code": r.status_code})
            except Exception as e:
                result.append({"name": "llamacpp", "url": llamacpp_url, "status": "down", "error": str(e)})
        if config.get("vllm_enabled", False):
            # vllm = backend brain-daemon (toolbox kyuz0/vllm-therock-gfx1151). URL par
            # défaut = llamacpp_url (même daemon). Override via vllm_url si daemon dédié.
            vllm_url = str(config.get("vllm_url") or config.get("llamacpp_url") or "http://localhost:4321").rstrip("/")
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    r = await client.get(f"{vllm_url}/health")
                result.append({"name": "vllm", "url": vllm_url, "status": "up", "status_code": r.status_code})
            except Exception as e:
                result.append({"name": "vllm", "url": vllm_url, "status": "down", "error": str(e)})
        if config.get("lucebox_enabled", False):
            # lucebox = backend natif extra brain-daemon (`native-lucebox`). URL par défaut
            # = llamacpp_url (même daemon). Override possible via lucebox_url.
            lucebox_url = str(config.get("lucebox_url") or config.get("llamacpp_url") or "http://localhost:4321").rstrip("/")
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    r = await client.get(f"{lucebox_url}/health")
                result.append({"name": "lucebox", "url": lucebox_url, "status": "up", "status_code": r.status_code})
            except Exception as e:
                result.append({"name": "lucebox", "url": lucebox_url, "status": "down", "error": str(e)})
        if config.get("audio_local_enabled"):
            audio_local_url = str(config.get("audio_local_url", "")).strip().rstrip("/")
            if audio_local_url:
                try:
                    async with httpx.AsyncClient(timeout=timeout) as client:
                        r = await client.get(f"{audio_local_url}/audio/health")
                    result.append({"name": "audio_local", "url": audio_local_url, "status": "up", "status_code": r.status_code})
                except Exception as e:
                    result.append({"name": "audio_local", "url": audio_local_url, "status": "down", "error": str(e)})
        if config.get("openrouter_enabled") and (config.get("openrouter_api_key") or "").strip():
            result.append({"name": "openrouter", "url": "https://openrouter.ai", "status": "up", "status_code": 200})
        # Priorité (1..N) pour le mode auto : ordre dans provider_priority
        try:
            from data import db as db_module
            order = db_module.get_provider_priority()
        except Exception:
            order = None
        if not order:
            order = [b["name"] for b in result]
        for b in result:
            name = b.get("name", "")
            b["priority"] = (order.index(name) + 1) if name in order else (len(order) + 1)
        return JSONResponse(content=result)
    except Exception as e:
        logger.exception("GET /admin/backends: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.put("/provider-priority")
async def set_provider_priority(body: dict):
    """Met à jour l'ordre de priorité des providers pour le mode auto. Body: {"order": ["ollama", "lm_studio", ...]}."""
    try:
        order = body.get("order")
        if not isinstance(order, list):
            return JSONResponse(status_code=400, content={"detail": "order doit être une liste de noms de backends"})
        names = [str(x).strip() for x in order if x]
        if not all(n in ALLOWED_BACKEND_NAMES for n in names):
            return JSONResponse(
                status_code=400,
                content={"detail": f"order ne peut contenir que: {', '.join(sorted(ALLOWED_BACKEND_NAMES))}"},
            )
        from data import db as db_module
        db_module.set_provider_priority(names)
        apply_db_overrides()
        return JSONResponse(content={"ok": True})
    except Exception as e:
        logger.exception("PUT /admin/provider-priority: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.put("/cloud-fallback-order")
async def set_cloud_fallback_order(body: dict):
    """
    Met à jour l'ordre des providers cloud fallback. Body: {"order": ["anthropic", "openrouter"]}.
    Le premier provider disponible dans la liste est utilisé quand tous les backends locaux sont down.
    """
    try:
        order = body.get("order")
        if not isinstance(order, list):
            return JSONResponse(status_code=400, content={"detail": "order doit être une liste de providers cloud"})
        names = [str(x).strip() for x in order if x]
        if not all(n in ALLOWED_CLOUD_PROVIDERS for n in names):
            return JSONResponse(
                status_code=400,
                content={"detail": "order ne peut contenir que: openrouter, anthropic"},
            )
        from data import db as db_module
        db_module.set_setting("fallback_providers_order", names)
        apply_db_overrides()
        return JSONResponse(content={"ok": True})
    except Exception as e:
        logger.exception("PUT /admin/cloud-fallback-order: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.get("/models")
async def get_models():
    """Liste les modèles disponibles sur les backends activés (Ollama / MLX / LM Studio)."""
    try:
        config = get_config()
        ollama_url = str(config.get("ollama_url", "http://localhost:11434")).rstrip("/")
        mlx_url = str(config.get("mlx_url", "http://localhost:8080")).rstrip("/")
        out = {}

        if config.get("ollama_enabled", True):
            out["ollama"] = []
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    r = await client.get(f"{ollama_url}/api/tags")
                if r.status_code == 200:
                    data = r.json()
                    for m in data.get("models", []):
                        name = m.get("name") or m.get("model") or "unknown"
                        out["ollama"].append({
                            "id": f"ollama/{name}",
                            "name": name,
                            "size": m.get("size"),
                            "modified_at": m.get("modified_at"),
                        })
            except Exception as e:
                out["ollama_error"] = str(e)

        if config.get("mlx_enabled", True):
            out["mlx"] = []
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    r = await client.get(f"{mlx_url}/v1/models")
                if r.status_code == 200:
                    data = r.json()
                    for m in data.get("data", []):
                        mid = m.get("id") or "unknown"
                        out["mlx"].append({
                            "id": f"mlx/{mid}",
                            "name": m.get("id") or mid,
                        })
            except Exception as e:
                out["mlx_error"] = str(e)

        if config.get("lm_studio_enabled", True):
            lm_studio_url = str(config.get("lm_studio_url", "http://localhost:1234")).rstrip("/")
            out["lm_studio"] = []
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    r = await client.get(f"{lm_studio_url}/api/v1/models")
                if r.status_code == 200:
                    data = r.json()
                    items = data.get("models", data.get("data", [])) if isinstance(data, dict) else data or []
                    if not isinstance(items, list):
                        items = []
                    for m in items:
                        mid = m.get("key") or m.get("id") or m.get("name")
                        if not mid:
                            continue
                        loaded = (m.get("loaded_instances") or [])
                        out["lm_studio"].append({
                            "id": f"lm_studio/{mid}",
                            "name": m.get("display_name") or mid,
                            "current": bool(loaded),
                            "size_bytes": m.get("size_bytes"),
                        })
            except Exception as e:
                out["lm_studio_error"] = str(e)

        if config.get("llamacpp_enabled", True):
            llamacpp_url = str(config.get("llamacpp_url", "http://localhost:4321")).rstrip("/")
            out["llamacpp"] = []
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    r = await client.get(f"{llamacpp_url}/mgmt/models")
                if r.status_code == 200:
                    for m in r.json():
                        mid = m.get("id") or "unknown"
                        out["llamacpp"].append({
                            "id": f"llamacpp/{mid}",
                            "name": mid,
                            "running": m.get("running", False),
                            "size_gb": m.get("size_gb"),
                            "ctx_size": m.get("ctx_size"),
                        })
            except Exception as e:
                out["llamacpp_error"] = str(e)

        return JSONResponse(content=out)
    except Exception as e:
        logger.exception("GET /admin/models: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})
