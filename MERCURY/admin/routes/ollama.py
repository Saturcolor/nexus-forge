"""Routes admin Ollama : liste modèles, pull, create modelfile, unload, delete, ps."""
import asyncio
import json
import logging
import time
from typing import Any

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from data import db as db_module
from routing.router import get_config, apply_db_overrides
from providers.ollama.pull_cache import invalidate as invalidate_pull_cache
from providers.ollama.last_metrics import get_last_metrics as get_ollama_proxy_metrics

logger = logging.getLogger(__name__)
router = APIRouter()


# Paramètres Ollama qui doivent être envoyés en int ou float (sinon string).
_OLLAMA_PARAM_INT = frozenset({"num_ctx", "num_predict", "num_gpu", "top_k", "seed"})
_OLLAMA_PARAM_FLOAT = frozenset({"temperature", "top_p", "repeat_penalty"})


def _coerce_ollama_parameter(key: str, val: str):
    """Convertit une valeur de paramètre Modelfile vers le type attendu par l'API Ollama."""
    key_lower = key.lower()
    if key_lower in _OLLAMA_PARAM_INT:
        try:
            return int(float(val))
        except (ValueError, TypeError):
            return val
    if key_lower in _OLLAMA_PARAM_FLOAT:
        try:
            return float(val)
        except (ValueError, TypeError):
            return val
    return val


def _parse_modelfile_to_create_payload(modelfile: str) -> dict | None:
    """Convertit le contenu d'un Modelfile en payload pour POST /api/create (from, system, parameters, etc.)."""
    lines = [ln.strip() for ln in modelfile.split("\n") if ln.strip()]
    from_model = None
    system = None
    template = None
    parameters = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        upper = line.upper()
        if upper.startswith("FROM "):
            from_model = line[5:].strip()
            i += 1
        elif upper.startswith("SYSTEM "):
            system = line[7:].strip()
            i += 1
        elif upper.startswith("TEMPLATE "):
            rest = line[9:].strip()
            if rest.startswith('"""') and rest.endswith('"""'):
                template = rest[3:-3]
            else:
                template = rest
            i += 1
        elif upper.startswith("PARAMETER "):
            rest = line[10:].strip()
            parts = rest.split(None, 1)
            if len(parts) >= 2:
                key, val = parts[0], parts[1]
                if val.startswith('"') and val.endswith('"'):
                    val = val[1:-1].replace('\\"', '"')
                parameters[key] = _coerce_ollama_parameter(key, val)
            i += 1
        else:
            i += 1
    if not from_model:
        return None
    payload = {"from": from_model}
    if system:
        payload["system"] = system
    if template:
        payload["template"] = template
    if parameters:
        payload["parameters"] = parameters
    return payload


def _ollama_base() -> str:
    config = get_config()
    if not config.get("ollama_enabled"):
        return ""
    return str(config.get("ollama_url", "http://localhost:11434")).rstrip("/")


# Note: l'endpoint GET /ollama/probe a été retiré (stats machine désormais
# exposées par brain-daemon). Le service `probe/` standalone est archivé dans
# le repo mais n'est plus consommé par l'API admin.


@router.get("/ollama/models")
async def get_ollama_models():
    """Liste des modèles Ollama avec état chargé en mémoire (via /api/ps)."""
    base = _ollama_base()
    if not base:
        return JSONResponse(content={"models": [], "error": "Ollama désactivé"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/api/tags")
            if r.status_code != 200:
                return JSONResponse(
                    status_code=r.status_code,
                    content={"models": [], "error": r.text[:500] or str(r.status_code)},
                )
            data = r.json()
            models = data.get("models", [])

            # Récupérer les modèles chargés en mémoire
            running = set()
            try:
                ps_r = await client.get(f"{base}/api/ps")
                if ps_r.status_code == 200:
                    ps_data = ps_r.json()
                    for m in ps_data.get("models", []):
                        running.add(m.get("name", ""))
            except Exception:
                pass

            out = []
            for m in models:
                name = m.get("name") or m.get("model") or "unknown"
                out.append({
                    "name": name,
                    "size": m.get("size"),
                    "modified_at": m.get("modified_at"),
                    "digest": m.get("digest"),
                    "details": m.get("details"),
                    "running": name in running,
                })
            return JSONResponse(content={"models": out})
    except (httpx.ConnectError, httpx.TimeoutException) as e:
        logger.warning("GET /admin/ollama/models: %s", e)
        return JSONResponse(status_code=503, content={"models": [], "error": str(e)})
    except Exception as e:
        logger.exception("GET /admin/ollama/models: %s", e)
        return JSONResponse(status_code=500, content={"models": [], "error": str(e)})


@router.get("/ollama/ps")
async def get_ollama_ps():
    """Modèles actuellement chargés en mémoire (RAM/VRAM)."""
    base = _ollama_base()
    if not base:
        return JSONResponse(content={"models": [], "error": "Ollama désactivé"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/api/ps")
        if r.status_code != 200:
            return JSONResponse(
                status_code=r.status_code,
                content={"models": [], "error": r.text[:500] or str(r.status_code)},
            )
        return JSONResponse(content=r.json())
    except (httpx.ConnectError, httpx.TimeoutException) as e:
        logger.warning("GET /admin/ollama/ps: %s", e)
        return JSONResponse(status_code=503, content={"models": [], "error": str(e)})
    except Exception as e:
        logger.exception("GET /admin/ollama/ps: %s", e)
        return JSONResponse(status_code=500, content={"models": [], "error": str(e)})


async def _build_ollama_session_payload(model_name: str) -> dict[str, Any]:
    """Snapshot : POST /api/show + entrée /api/ps si chargé + métriques proxy (globales)."""
    base = _ollama_base()
    if not base:
        return {"_error": "Ollama désactivé", "_http": 400}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            show_r = await client.post(f"{base}/api/show", json={"name": model_name})
            if show_r.status_code == 404:
                return {"_error": f"Modèle inconnu: {model_name}", "_http": 404}
            if show_r.status_code != 200:
                return {"_error": (show_r.text or "")[:500], "_http": show_r.status_code}
            try:
                show_data = show_r.json()
            except Exception:
                show_data = {}
            ps_entry = None
            try:
                ps_r = await client.get(f"{base}/api/ps")
                if ps_r.status_code == 200:
                    ps_data = ps_r.json()
                    for m in ps_data.get("models", []):
                        if not isinstance(m, dict):
                            continue
                        n = m.get("name") or ""
                        if n == model_name or str(n).lower() == str(model_name).lower():
                            ps_entry = m
                            break
            except Exception:
                pass
        num_ctx: int | None = None
        if isinstance(show_data, dict):
            params = show_data.get("parameters")
            if isinstance(params, dict) and params.get("num_ctx") is not None:
                try:
                    num_ctx = int(params["num_ctx"])
                except (TypeError, ValueError):
                    num_ctx = None
        proxy = get_ollama_proxy_metrics()
        return {
            "model_name": model_name,
            "ts": time.time(),
            "show": show_data,
            "ps": ps_entry,
            "context_length": num_ctx,
            "proxy_metrics": proxy,
            "show_http_status": show_r.status_code,
        }
    except httpx.ConnectError as e:
        return {"_error": str(e), "_http": 503}
    except Exception as e:
        logger.warning("_build_ollama_session_payload: %s", e)
        return {"_error": str(e), "_http": 500}


@router.get("/ollama/session/{model_name:path}")
async def get_ollama_session(model_name: str):
    """Détails modèle (show) + entrée ps si chargé + métriques proxy."""
    payload = await _build_ollama_session_payload(model_name)
    err = payload.pop("_error", None)
    http = payload.pop("_http", 200)
    if err:
        status = int(http) if isinstance(http, int) else 500
        return JSONResponse(status_code=status, content={"detail": err})
    return JSONResponse(content=payload)


@router.get("/ollama/session-stream/{model_name:path}")
async def get_ollama_session_stream(model_name: str):
    """SSE : même snapshot ~1/s."""
    base = _ollama_base()
    if not base:

        async def err_gen():
            yield f"data: {json.dumps({'error': 'Ollama désactivé'})}\n\n"

        return StreamingResponse(err_gen(), media_type="text/event-stream")

    async def generate():
        while True:
            payload = await _build_ollama_session_payload(model_name)
            err = payload.pop("_error", None)
            http = payload.pop("_http", 200)
            if err:
                out: dict[str, Any] = {
                    "model_name": model_name,
                    "ts": time.time(),
                    "error": err,
                    "http_status": http,
                }
            else:
                out = payload
            yield f"data: {json.dumps(out, default=str)}\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/ollama/pull")
async def post_ollama_pull(body: dict):
    """Pull un modèle Ollama. Stream NDJSON de la progression.
    Body: { "model": "llama3:8b" }."""
    base = _ollama_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "Ollama désactivé"})
    model = (body.get("model") or "").strip()
    if not model:
        return JSONResponse(status_code=400, content={"detail": "Champ 'model' requis"})

    async def stream_pull():
        try:
            async with httpx.AsyncClient(timeout=600.0) as client:
                async with client.stream(
                    "POST", f"{base}/api/pull", json={"model": model, "stream": True}
                ) as resp:
                    if resp.status_code != 200:
                        err = await resp.aread()
                        yield json.dumps({"error": err.decode("utf-8", errors="replace")[:500]}) + "\n"
                        return
                    buffer = ""
                    async for chunk in resp.aiter_text():
                        buffer += chunk
                        while "\n" in buffer:
                            line, buffer = buffer.split("\n", 1)
                            line = line.strip()
                            if line:
                                yield line + "\n"
                    if buffer.strip():
                        yield buffer.strip() + "\n"
        except Exception as e:
            logger.exception("POST /admin/ollama/pull stream: %s", e)
            yield json.dumps({"error": str(e)}) + "\n"

    return StreamingResponse(
        stream_pull(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.post("/ollama/create")
async def post_ollama_create(body: dict):
    """Créer un modèle depuis un Modelfile.
    Body: { "name": "mon-modele", "modelfile": "FROM llama3\\nSYSTEM Tu es..." }."""
    base = _ollama_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "Ollama désactivé"})
    name = (body.get("name") or "").strip()
    modelfile = (body.get("modelfile") or "").strip()
    if not name:
        return JSONResponse(status_code=400, content={"detail": "Champ 'name' requis"})
    if not modelfile:
        return JSONResponse(status_code=400, content={"detail": "Champ 'modelfile' requis"})
    # L'API Ollama n'accepte pas "modelfile" : elle attend model, from, system, parameters, etc.
    create_payload = _parse_modelfile_to_create_payload(modelfile)
    if not create_payload:
        return JSONResponse(
            status_code=400,
            content={"detail": "Le modelfile doit contenir une ligne FROM (modèle de base)."},
        )

    payload = {"model": name, "stream": True, **create_payload}

    async def stream_create():
        try:
            async with httpx.AsyncClient(timeout=600.0) as client:
                async with client.stream(
                    "POST", f"{base}/api/create",
                    json=payload,
                ) as resp:
                    if resp.status_code != 200:
                        err = await resp.aread()
                        yield json.dumps({"error": err.decode("utf-8", errors="replace")[:500]}) + "\n"
                        return
                    buffer = ""
                    async for chunk in resp.aiter_text():
                        buffer += chunk
                        while "\n" in buffer:
                            line, buffer = buffer.split("\n", 1)
                            line = line.strip()
                            if line:
                                yield line + "\n"
                    if buffer.strip():
                        yield buffer.strip() + "\n"
            # Création réussie (200 + stream consommé) → persister l'état SEULEMENT
            # maintenant : sinon un échec Ollama laisserait Mercury en état
            # incohérent (template_configured + models_cache flushé pour un modèle
            # inexistant). Persist : la présence d'une ligne "TEMPLATE ..." dans le
            # Modelfile => badge UI "TPL" (ex. tri par tag / repérage rapide).
            try:
                db_module.set_ollama_template_configured(f"ollama/{name}", bool(create_payload.get("template")))
            except Exception:
                logger.exception("POST /admin/ollama/create: impossible d'enregistrer template_configured (ollama/%s)", name)
            # Nouveau modèle créé → models_cache stale (entrée à ajouter).
            apply_db_overrides()
        except Exception as e:
            logger.exception("POST /admin/ollama/create stream: %s", e)
            yield json.dumps({"error": str(e)}) + "\n"

    return StreamingResponse(
        stream_create(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.post("/ollama/load")
async def post_ollama_load(body: dict):
    """Charger un modèle en mémoire. Body: { "model": "llama3:8b" }.
    Envoie POST /api/generate avec un prompt minimal pour déclencher le chargement."""
    base = _ollama_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "Ollama désactivé"})
    model = (body.get("model") or "").strip()
    if not model:
        return JSONResponse(status_code=400, content={"detail": "Champ 'model' requis"})
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{base}/api/generate",
                json={"model": model, "prompt": " ", "stream": False},
            )
        try:
            resp_body = r.json()
        except Exception:
            resp_body = {"detail": r.text or str(r.status_code)}
        # Modèle nouvellement chargé → models_cache stale (loaded state changé).
        # apply_db_overrides flushe models_cache comme side-effect (cf. router.py).
        apply_db_overrides()
        return JSONResponse(status_code=r.status_code, content=resp_body)
    except Exception as e:
        logger.exception("POST /admin/ollama/load: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e)})


@router.post("/ollama/unload")
async def post_ollama_unload(body: dict):
    """Décharger un modèle de la mémoire. Body: { "model": "llama3:8b" }.
    Envoie POST /api/generate avec keep_alive=0 pour forcer le déchargement."""
    base = _ollama_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "Ollama désactivé"})
    model = (body.get("model") or "").strip()
    if not model:
        return JSONResponse(status_code=400, content={"detail": "Champ 'model' requis"})
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{base}/api/generate",
                json={"model": model, "keep_alive": 0},
            )
        try:
            resp_body = r.json()
        except Exception:
            resp_body = {"detail": r.text or str(r.status_code)}
        # Modèle déchargé → models_cache stale (loaded=False désormais).
        apply_db_overrides()
        return JSONResponse(status_code=r.status_code, content=resp_body)
    except Exception as e:
        logger.exception("POST /admin/ollama/unload: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e)})


@router.delete("/ollama/model")
async def delete_ollama_model(body: dict):
    """Supprimer un modèle Ollama. Body: { "model": "llama3:8b" }."""
    base = _ollama_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "Ollama désactivé"})
    model = (body.get("model") or "").strip()
    if not model:
        return JSONResponse(status_code=400, content={"detail": "Champ 'model' requis"})
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.request(
                "DELETE", f"{base}/api/delete", json={"name": model},
            )
        try:
            resp_body = r.json()
        except Exception:
            resp_body = {"detail": r.text or str(r.status_code)}
        if r.status_code == 200:
            resp_body = {"ok": True}
            invalidate_pull_cache(model)
            try:
                db_module.set_ollama_template_configured(f"ollama/{model}", False)
            except Exception:
                logger.exception("DELETE /admin/ollama/model: impossible de nettoyer template_configured (ollama/%s)", model)
            # Modèle supprimé → models_cache stale (entrée à retirer).
            apply_db_overrides()
        return JSONResponse(status_code=r.status_code, content=resp_body)
    except Exception as e:
        logger.exception("DELETE /admin/ollama/model: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e)})
