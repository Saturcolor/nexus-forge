"""Routes Quant : passthrough vers brain-daemon /quant/* avec feature flag + whitelist.

Atlasmind (app dédiée sur le VPS) tape Mercury sur /quant/* — Mercury proxy
vers le brain-daemon (où vit le module quantize qui orchestre llama-imatrix
et llama-quantize via toolbox).

Activation :
    mercury config.yaml:
      quant_enabled: true
      quant_brain_url: http://127.0.0.1:4321
      quant_timeout_sec: 60          # routes sync ; les streams ont leur propre timeout

Whitelist des routes (quant_allowed_routes) — DEUX modes, cf _check_route_allowed :

  • Clé ABSENTE = mode défaut. Autorise _DEFAULT_ALLOWED (routes exactes) PLUS
    _DEFAULT_ALLOWED_PATTERNS (routes paramétrées, matchées par regex). C'est le
    SEUL mode où les routes paramétrées passent.
      exactes      : /health /toolboxes /models /outputs /calibrations /imatrices
                     /presets/canonical /family-catalog /surgical/preview
                     /surgical/custom-preview /validate-gguf /cartography /jobs
      paramétrées  : /imatrices/{name} /jobs/{id} /jobs/{id}/cancel
                     /jobs/{id}/log /jobs/{id}/stream

  • Clé PRÉSENTE = mode custom. EXACT-MATCH ONLY, aucun fallback regex
    (`use_patterns = not custom`). Les routes PARAMÉTRÉES ne sont donc PAS
    whitelistables : un `/jobs/{id}` littéral ne matche jamais un vrai
    `/jobs/abc123` → 403. Si tu as besoin des routes paramétrées (l'UI AtlasMind
    lit /jobs/{id}, /jobs/{id}/stream, /jobs/{id}/log, /imatrices/{name} et
    appelle cancel/delete), NE METS PAS la clé. Une liste custom ne sert qu'à
    restreindre au sous-ensemble des routes NON paramétrées.

Pattern aligné sur core/routes_atlas.py.
"""
from __future__ import annotations

import json
import logging
import re

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from auth import resolve_user
from routing.router import get_config

logger = logging.getLogger("mercury.quant")

# Phase 1 = read-only. Phase 2 ajoutera /jobs, /jobs/{id}, /jobs/{id}/stream,
# /jobs/{id}/cancel, /jobs/{id}/log.
_DEFAULT_ALLOWED = [
    "/health",
    "/toolboxes",
    "/models",
    "/outputs",
    "/calibrations",
    "/imatrices",
    "/presets/canonical",
    "/family-catalog",
    "/surgical/preview",
    "/surgical/custom-preview",
    "/validate-gguf",
    "/cartography",
    "/jobs",
]
# Routes paramétrées (matchent avec regex après normalisation)
_DEFAULT_ALLOWED_PATTERNS = [
    re.compile(r"^/imatrices/[^/]+$"),
    re.compile(r"^/jobs/[^/]+$"),
    re.compile(r"^/jobs/[^/]+/cancel$"),
    re.compile(r"^/jobs/[^/]+/log$"),
    re.compile(r"^/jobs/[^/]+/stream$"),
]
_DEFAULT_TIMEOUT = 60   # routes sync légères (scan FS, parse imatrix, job create)
_DEFAULT_STREAM_TIMEOUT = 7200  # 2h pour le stream NDJSON d'un quant complet
_DEFAULT_BRAIN_URL = "http://127.0.0.1:4321"


def _check_enabled(config: dict) -> None:
    if not config.get("quant_enabled", False):
        raise HTTPException(
            status_code=501,
            detail="Quant feature not enabled. Requires brain-daemon with quantize module. Set quant_enabled: true in mercury config.",
        )


def _check_route_allowed(suffix: str, config: dict) -> None:
    # Liste exacte : config-driven. Si l'opérateur la fournit, c'est SA liste
    # qui fait foi (cf config.yaml "faut tout lister sinon 403").
    custom = config.get("quant_allowed_routes")
    allowed = custom or _DEFAULT_ALLOWED
    norm = "/" + suffix.lstrip("/")
    if norm.endswith("/") and len(norm) > 1:
        norm = norm.rstrip("/")
    # Exact match
    if norm in allowed:
        logger.debug("quant route allowed (exact): %s", norm)
        return
    # Pattern match (routes paramétrées style /imatrices/{name}, /jobs/{id}/...).
    # BUG FIX : les patterns sont le fallback du DÉFAUT uniquement. Quand une
    # whitelist custom est configurée, elle contrôle TOUT l'accès (exact-match
    # seul, comme routes_atlas.py) — sinon les routes destructives paramétrées
    # (/jobs/{id}/cancel, DELETE /jobs/{id}, ...) passaient en douce malgré une
    # liste restrictive, fail-open sur les routes les plus dangereuses.
    use_patterns = not custom
    if use_patterns:
        for pat in _DEFAULT_ALLOWED_PATTERNS:
            if pat.match(norm):
                logger.debug("quant route allowed (pattern %s): %s", pat.pattern, norm)
                return
    # Message d'erreur honnête : reflète le set d'autorisation RÉELLEMENT en
    # vigueur (exact + patterns si défaut), pas juste la liste exacte.
    if use_patterns:
        effective = allowed + [p.pattern for p in _DEFAULT_ALLOWED_PATTERNS]
    else:
        effective = allowed
    logger.warning("quant route DENIED: %s (allowed=%s)", norm, effective)
    raise HTTPException(
        status_code=403,
        detail=f"Route /quant{norm} not in allowed list. Allowed: {effective}",
    )


def _check_job_id(job_id: str) -> None:
    """Valide job_id avant de le forwarder au brain-daemon (anti path-traversal)."""
    import re as _re
    if not _re.fullmatch(r"[A-Za-z0-9_-]+", job_id):
        raise HTTPException(400, "job_id invalide (caractères autorisés : A-Z a-z 0-9 _ -)")


def _brain_url(config: dict, suffix: str) -> str:
    base = (config.get("quant_brain_url") or _DEFAULT_BRAIN_URL).rstrip("/")
    suf = "/" + suffix.lstrip("/")
    return f"{base}/quant{suf}"


def _maybe_auth(request: Request, config: dict) -> str:
    """Optional auth check. Accepte les API keys utilisateurs + admin_token.

    Pattern strictement identique à routes_atlas._maybe_auth.
    """
    authorization = request.headers.get("Authorization")
    user_id, _priority, _threshold = resolve_user(authorization)
    if config.get("require_api_key") and user_id in ("anonymous", "unknown"):
        admin_token = (config.get("admin_token") or "").strip()
        if admin_token and authorization:
            auth = authorization.strip()
            if auth.lower().startswith("bearer ") and auth[7:].strip() == admin_token:
                return "admin"
        raise HTTPException(status_code=401, detail="Token API invalide ou manquant")
    return user_id


async def _proxy_get(suffix: str, request: Request) -> JSONResponse:
    """Helper passthrough GET → brain."""
    config = get_config()
    _check_enabled(config)
    _check_route_allowed(suffix, config)
    _maybe_auth(request, config)
    try:
        timeout = int(config.get("quant_timeout_sec", _DEFAULT_TIMEOUT))
        async with httpx.AsyncClient(timeout=min(timeout, 60)) as client:
            resp = await client.get(_brain_url(config, suffix))
        return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"brain timeout after {timeout}s")
    except httpx.RequestError as e:
        logger.exception("quant proxy GET %s error (réseau)", suffix)
        raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
    except Exception:
        logger.exception("quant proxy GET %s erreur inattendue", suffix)
        raise


async def _proxy_post(suffix: str, request: Request, timeout_override: int | None = None) -> JSONResponse:
    """Helper passthrough POST → brain (sync, body forwardé).

    `timeout_override` : pour les routes plus longues que les sync légères (ex:
    /cartography qui peut scanner le blob de poids ~30-60s sur un 35B).
    """
    config = get_config()
    _check_enabled(config)
    _check_route_allowed(suffix, config)
    _maybe_auth(request, config)
    body = await request.body()
    try:
        payload = json.loads(body) if body else {}
    except Exception:
        raise HTTPException(status_code=400, detail="JSON invalide")
    try:
        timeout = timeout_override or int(config.get("quant_timeout_sec", _DEFAULT_TIMEOUT))
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(_brain_url(config, suffix), json=payload)
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                detail = resp.text
            raise HTTPException(status_code=resp.status_code, detail=detail)
        return JSONResponse(content=resp.json())
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"brain timeout after {timeout}s")
    except httpx.RequestError as e:
        logger.exception("quant proxy POST %s error (réseau)", suffix)
        raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
    except Exception:
        logger.exception("quant proxy POST %s erreur inattendue", suffix)
        raise


def register(app: FastAPI):
    """Enregistre les routes quant sur l'app Mercury."""

    @app.get("/quant/health")
    async def quant_health(request: Request):
        """Toujours répond, même désactivé (status info)."""
        config = get_config()
        if not config.get("quant_enabled", False):
            return {"enabled": False, "configured_brain_url": config.get("quant_brain_url")}
        try:
            timeout = int(config.get("quant_timeout_sec", _DEFAULT_TIMEOUT))
            async with httpx.AsyncClient(timeout=min(timeout, 10)) as client:
                resp = await client.get(_brain_url(config, "/health"))
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except Exception as e:
            logger.warning("quant_health upstream unreachable: %s", e)
            return JSONResponse(
                content={"enabled": True, "upstream_error": str(e)},
                status_code=502,
            )

    @app.get("/quant/toolboxes")
    async def quant_toolboxes(request: Request):
        return await _proxy_get("/toolboxes", request)

    @app.get("/quant/models")
    async def quant_models(request: Request):
        return await _proxy_get("/models", request)

    @app.get("/quant/outputs")
    async def quant_outputs(request: Request):
        return await _proxy_get("/outputs", request)

    @app.get("/quant/calibrations")
    async def quant_calibrations(request: Request):
        return await _proxy_get("/calibrations", request)

    @app.get("/quant/imatrices")
    async def quant_imatrices(request: Request):
        return await _proxy_get("/imatrices", request)

    @app.get("/quant/imatrices/{name}")
    async def quant_imatrix_detail(name: str, request: Request):
        # Sécurité minimum côté Mercury aussi (le brain refait la vérif).
        if "/" in name or "\\" in name or ".." in name:
            raise HTTPException(400, "imatrix name invalid")
        return await _proxy_get(f"/imatrices/{name}", request)

    @app.get("/quant/presets/canonical")
    async def quant_presets_canonical(request: Request):
        return await _proxy_get("/presets/canonical", request)

    @app.get("/quant/family-catalog")
    async def quant_family_catalog(request: Request):
        return await _proxy_get("/family-catalog", request)

    @app.post("/quant/surgical/preview")
    async def quant_surgical_preview(request: Request):
        # source=cartography → scan de poids côté brain (~30-60s) → timeout long.
        cfg = get_config()
        to = None
        try:
            payload = json.loads(await request.body() or b"{}")
            if payload.get("source") == "cartography":
                to = int(cfg.get("quant_cartography_timeout_sec", 600))
        except Exception:
            to = None
        return await _proxy_post("/surgical/preview", request, timeout_override=to)

    @app.post("/quant/surgical/custom-preview")
    async def quant_surgical_custom_preview(request: Request):
        # source=cartography → scan de poids côté brain (~30-60s) → timeout long
        # (même piège que /surgical/preview et /cartography).
        cfg = get_config()
        to = None
        try:
            payload = json.loads(await request.body() or b"{}")
            if payload.get("source") == "cartography":
                to = int(cfg.get("quant_cartography_timeout_sec", 600))
        except Exception:
            to = None
        return await _proxy_post("/surgical/custom-preview", request, timeout_override=to)

    @app.post("/quant/validate-gguf")
    async def quant_validate_gguf(request: Request):
        return await _proxy_post("/validate-gguf", request)

    @app.post("/quant/cartography")
    async def quant_cartography(request: Request):
        # with_health=True lit le blob de poids (~30-60s sur 35B) → timeout dédié
        # généreux. with_health=False (header only) reste rapide, ce timeout l'OK aussi.
        cfg = get_config()
        to = int(cfg.get("quant_cartography_timeout_sec", 600))
        return await _proxy_post("/cartography", request, timeout_override=to)

    # ── Jobs (Phase 2) ──────────────────────────────────────────────────────
    @app.post("/quant/jobs")
    async def quant_jobs_create(request: Request):
        return await _proxy_post("/jobs", request)

    @app.get("/quant/jobs")
    async def quant_jobs_list(request: Request):
        return await _proxy_get("/jobs", request)

    @app.get("/quant/jobs/{job_id}")
    async def quant_job_get(job_id: str, request: Request):
        _check_job_id(job_id)
        return await _proxy_get(f"/jobs/{job_id}", request)

    @app.post("/quant/jobs/{job_id}/cancel")
    async def quant_job_cancel(job_id: str, request: Request):
        _check_job_id(job_id)
        return await _proxy_post(f"/jobs/{job_id}/cancel", request)

    @app.delete("/quant/jobs/{job_id}")
    async def quant_job_delete(job_id: str, request: Request):
        _check_job_id(job_id)
        config = get_config()
        _check_enabled(config)
        _check_route_allowed(f"/jobs/{job_id}", config)
        _maybe_auth(request, config)
        try:
            timeout = int(config.get("quant_timeout_sec", _DEFAULT_TIMEOUT))
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.delete(_brain_url(config, f"/jobs/{job_id}"))
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail=f"brain timeout after {timeout}s")
        except httpx.RequestError as e:
            logger.exception("quant job delete error (réseau)")
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
        except Exception:
            logger.exception("quant job delete erreur inattendue")
            raise

    @app.get("/quant/jobs/{job_id}/log")
    async def quant_job_log(job_id: str, request: Request, lines: int = 200):
        _check_job_id(job_id)
        config = get_config()
        _check_enabled(config)
        _check_route_allowed(f"/jobs/{job_id}/log", config)
        _maybe_auth(request, config)
        try:
            timeout = int(config.get("quant_timeout_sec", _DEFAULT_TIMEOUT))
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get(
                    _brain_url(config, f"/jobs/{job_id}/log"),
                    params={"lines": lines},
                )
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail=f"brain timeout after {timeout}s")
        except httpx.RequestError as e:
            logger.exception("quant job log error (réseau)")
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
        except Exception:
            logger.exception("quant job log erreur inattendue")
            raise

    @app.get("/quant/jobs/{job_id}/stream")
    async def quant_job_stream(job_id: str, request: Request):
        """Relay NDJSON depuis brain pour le suivi live d'un job de quant.

        Long-lived stream — peut durer 30min+ pour un quant complet. Le brain
        émet un heartbeat toutes les 20s pour éviter le timeout idle Caddy.
        """
        _check_job_id(job_id)
        config = get_config()
        _check_enabled(config)
        _check_route_allowed(f"/jobs/{job_id}/stream", config)
        _maybe_auth(request, config)
        stream_timeout = int(config.get("quant_stream_timeout_sec", _DEFAULT_STREAM_TIMEOUT))
        url = _brain_url(config, f"/jobs/{job_id}/stream")

        async def relay():
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(stream_timeout, connect=10.0),
                ) as client:
                    async with client.stream("GET", url) as resp:
                        if resp.status_code >= 400:
                            text = await resp.aread()
                            yield (
                                json.dumps({"event": "error", "message": text.decode("utf-8", "replace")[:500]}) + "\n"
                            ).encode("utf-8")
                            return
                        async for line in resp.aiter_lines():
                            if not line:
                                continue
                            yield (line + "\n").encode("utf-8")
            except httpx.TimeoutException:
                yield (json.dumps({"event": "error", "message": f"brain timeout after {stream_timeout}s"}) + "\n").encode("utf-8")
            except Exception as e:
                logger.exception("quant stream relay error")
                yield (json.dumps({"event": "error", "message": str(e)}) + "\n").encode("utf-8")

        return StreamingResponse(relay(), media_type="application/x-ndjson")
