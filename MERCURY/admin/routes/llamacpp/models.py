"""Routes modèles / status / probe / daemon-version."""
import logging

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from admin.common import log_probe_warning
from data import db as db_module

from ._common import llamacpp_base, DAEMON_TIMEOUT

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/llamacpp/models")
async def get_llamacpp_models():
    """Liste complète des modèles GGUF (running ou non) depuis le daemon.

    active_preset_id / active_preset_name viennent direct de /mgmt/models côté
    brain (lus depuis load_configs.json — persistés, survivent au restart et
    à l'unload). Permet d'afficher le badge preset assigné même sur des
    modèles non chargés (UX "select preset puis charger plus tard").
    """
    base = llamacpp_base()
    if not base:
        return JSONResponse(content={"models": [], "error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=DAEMON_TIMEOUT) as client:
            r = await client.get(f"{base}/mgmt/models")
        if r.status_code != 200:
            return JSONResponse(content={"models": [], "error": r.text[:500] or str(r.status_code)})
        raw_models = r.json()

        # Normaliser id → model_id et enrichir avec le template DB.
        # `kind` ("gguf"|"hf") est forwardé depuis brain-daemon scan_models —
        # le frontend filtre LlamaCppModelsCard (gguf) vs VllmModelsCard (hf).
        templates = db_module.get_llamacpp_templates()
        models = []
        for m in raw_models:
            mid = m.get("model_id") or m.get("id") or ""
            models.append({
                "model_id": mid,
                "path": m.get("path"),
                "size_gb": m.get("size_gb"),
                "running": m.get("running", False),
                "port": m.get("port"),
                "ctx_size": m.get("ctx_size"),
                "pid": m.get("pid"),
                "template": templates.get(mid),
                "kv_cache_exists": m.get("kv_cache_exists", False),
                "protected": m.get("protected", False),
                "kind": m.get("kind", "gguf"),
                # Preset AtlasMind assigné (None si pas de preset configuré).
                # Source = brain load_configs.json (forwardé via /mgmt/models).
                "active_preset_id": m.get("active_preset_id"),
                "active_preset_name": m.get("active_preset_name"),
                # Multi-select : liste exhaustive des presets cochés. Brain expose
                # déjà avec fallback singleton [active_preset_id] si entry legacy,
                # mais on re-fait le fallback ici par défense au cas où l'entry
                # brain n'aurait pas été touchée depuis le bump multi-LoRA.
                "active_preset_ids": m.get("active_preset_ids") or (
                    [m.get("active_preset_id")] if m.get("active_preset_id") is not None else []
                ),
                # Stack LoRA ordonné [{path, default_scale}]. L'index = id côté
                # llama-server. Sert au dashboard à afficher "0·nom 1·nom" et à
                # mapper les sliders de gradient Mastermind sur le bon adapter.
                "loras": m.get("loras") or [],
            })
        return JSONResponse(content={"models": models})
    except httpx.ConnectError:
        return JSONResponse(content={"models": [], "error": "Daemon inaccessible — vérifiez que llamacpp-daemon tourne et que llamacpp_url est correct."})
    except httpx.TimeoutException:
        return JSONResponse(content={"models": [], "error": "Timeout — le daemon ne répond pas."})
    except Exception as e:
        logger.warning("GET /admin/llamacpp/models: %s", e)
        return JSONResponse(content={"models": [], "error": str(e)})


@router.get("/llamacpp/status")
async def get_llamacpp_status():
    """Instances actives (model_id, port, ctx_size, pid)."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(content={"instances": [], "error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=DAEMON_TIMEOUT) as client:
            r = await client.get(f"{base}/mgmt/status")
        if r.status_code != 200:
            return JSONResponse(content={"instances": [], "error": r.text[:500]})
        return JSONResponse(content={"instances": r.json()})
    except httpx.ConnectError:
        return JSONResponse(content={"instances": [], "error": "Daemon inaccessible."})
    except Exception as e:
        logger.warning("GET /admin/llamacpp/status: %s", e)
        return JSONResponse(content={"instances": [], "error": str(e)})


@router.get("/llamacpp/probe")
async def get_llamacpp_probe():
    """Synthèse : health daemon + instances actives + dernières métriques tokens/s."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(content={"configured": False})
    try:
        from providers.llamacpp.last_metrics import get_last_metrics
        async with httpx.AsyncClient(timeout=DAEMON_TIMEOUT) as client:
            health_r = await client.get(f"{base}/health")
            status_r = await client.get(f"{base}/mgmt/status")

        if health_r.status_code != 200:
            return JSONResponse(content={"configured": True, "error": f"Daemon returned {health_r.status_code}"})

        health = health_r.json()
        instances = status_r.json() if status_r.status_code == 200 else []
        metrics = get_last_metrics()
        by_model = metrics.get("by_model") or {}
        return JSONResponse(content={
            "configured": True,
            "running_models": health.get("running_models", len(instances)),
            "instances": instances,
            "last_generation_tokens_per_second": metrics.get("last_generation_tokens_per_second"),
            "last_prompt_tokens": metrics.get("last_prompt_tokens"),
            "last_generation_tokens": metrics.get("last_generation_tokens"),
            "last_activity_ts": metrics.get("last_activity_ts"),
            "by_model": by_model,
        })
    except httpx.TimeoutException as e:
        log_probe_warning(base, "llamacpp", e)
        return JSONResponse(content={"configured": True, "error": "Timeout", "detail": str(e)})
    except Exception as e:
        log_probe_warning(base, "llamacpp", e)
        return JSONResponse(content={"configured": True, "error": str(e)})


@router.get("/llamacpp/daemon-version")
async def get_llamacpp_daemon_version():
    """Proxy vers GET /mgmt/version du llamacpp-daemon."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/mgmt/version")
        if r.status_code != 200:
            return JSONResponse(
                status_code=503,
                content={"error": f"Daemon returned {r.status_code}", "detail": (r.text or "")[:300]},
            )
        return JSONResponse(content=r.json())
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Daemon inaccessible."})
    except Exception as e:
        logger.warning("GET /admin/llamacpp/daemon-version: %s", e)
        return JSONResponse(status_code=503, content={"error": str(e)})
