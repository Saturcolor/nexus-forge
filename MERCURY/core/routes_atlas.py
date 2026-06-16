"""
Routes Atlas : passthrough vers brain-daemon /atlas/* avec feature flag + whitelist.

Atlasmind (app dédiée sur le VPS) tape Mercury sur /atlas/* — Mercury proxy vers
le brain (où vit le module atlas qui embarque transformers à la demande pour
extraire les hidden states / control vectors).

Activation :
    mercury config.yaml:
      atlas_enabled: true
      atlas_brain_url: http://127.0.0.1:4321
      atlas_allowed_routes:
        - /health
        - /models
        - /extract
        - /extract/stream
        - /test
      atlas_timeout_sec: 1800

Pattern aligné sur core/routes_audio.py (proxy vers brain + feature flag).
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import time
import uuid

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from auth import resolve_user
from routing.router import get_config

logger = logging.getLogger("mercury.atlas")

_DEFAULT_ALLOWED = [
    "/health", "/models", "/backends",
    "/extract", "/extract/stream", "/test",
    "/cancel",  # demande au brain de tuer le subprocess d'extraction en cours (C-02)
    # mgmt/* : passthrough vers brain /mgmt/{load,unload,status} pour le chat
    # multi-turn AtlasMind (load instance avec cocktail control_vector,
    # hot-swap entre conversations).
    "/mgmt/load", "/mgmt/unload", "/mgmt/status",
    "/mgmt/loras",  # liste les .gguf dans le répertoire lora du brain
]
_DEFAULT_TIMEOUT = 1800  # 30 min — extractions peuvent durer longtemps sur 31B
_DEFAULT_BRAIN_URL = "http://127.0.0.1:4321"
# AtlasMind (app FastAPI séparée, port 9300 par défaut — cf ATLASMIND/main.py).
# Source de vérité des presets cocktail control_vector ; Mercury consomme
# /api/atlasmind/presets/* pour exposer la sélection de preset dans le dashboard.
_DEFAULT_ATLASMIND_URL = "http://127.0.0.1:9300"


def _check_enabled(config: dict) -> None:
    if not config.get("atlas_enabled", False):
        raise HTTPException(
            status_code=501,
            detail="Atlas feature not enabled. Requires an AtlasMind instance (separate app). Set atlas_enabled: true in mercury config.",
        )


def _check_route_allowed(suffix: str, config: dict) -> None:
    allowed = config.get("atlas_allowed_routes") or _DEFAULT_ALLOWED
    # Normalize : strip trailing slash, ensure leading
    norm = "/" + suffix.lstrip("/")
    if norm.endswith("/") and len(norm) > 1:
        norm = norm.rstrip("/")
    if norm not in allowed:
        raise HTTPException(
            status_code=403,
            detail=f"Route /atlas{norm} not in allowed list. Allowed: {allowed}",
        )


def _brain_url(config: dict, suffix: str) -> str:
    base = (config.get("atlas_brain_url") or _DEFAULT_BRAIN_URL).rstrip("/")
    suf = "/" + suffix.lstrip("/")
    return f"{base}/atlas{suf}"


def _brain_root_url(config: dict, suffix: str) -> str:
    """Tape la racine du brain-daemon (pas le sous-module /atlas).

    Utilisé pour proxy /atlas/mgmt/* → brain /mgmt/* (load/unload/status d'instance
    llama-server, qui vivent au top-level du daemon, pas dans le sous-module atlas).
    """
    base = (config.get("atlas_brain_url") or _DEFAULT_BRAIN_URL).rstrip("/")
    suf = "/" + suffix.lstrip("/")
    return f"{base}{suf}"


def _atlasmind_url(config: dict, suffix: str) -> str:
    """Tape l'app AtlasMind (presets / vectors metadata)."""
    base = (config.get("atlas_atlasmind_url") or _DEFAULT_ATLASMIND_URL).rstrip("/")
    suf = "/" + suffix.lstrip("/")
    return f"{base}{suf}"


def _atlasmind_headers(config: dict) -> dict:
    """Headers pour les requêtes Mercury → AtlasMind. Inclut le Bearer si
    `atlas_atlasmind_api_key` est configuré (AtlasMind active son middleware
    auth quand `auth.api_key` est set côté config AtlasMind — sinon ouvert).
    """
    key = (config.get("atlas_atlasmind_api_key") or "").strip()
    return {"Authorization": f"Bearer {key}"} if key else {}


def _maybe_auth(request: Request, config: dict) -> str:
    """Optional auth check. If require_api_key is set, enforce. Returns user_id.

    Accepts both:
    - user API keys (config.users[])
    - admin_token (utilisé par le dashboard Mercury qui consomme /atlas/presets
      et /atlas/mgmt/* — sans ça, require_api_key:true → 401 sur le dashboard
      alors que l'utilisateur a les droits admin).
    """
    authorization = request.headers.get("Authorization")
    user_id, _priority, _threshold = resolve_user(authorization)
    if config.get("require_api_key") and user_id in ("anonymous", "unknown"):
        admin_token = (config.get("admin_token") or "").strip()
        if admin_token and authorization:
            auth = authorization.strip()
            if auth.lower().startswith("bearer ") and hmac.compare_digest(auth[7:].strip().encode("utf-8"), admin_token.encode("utf-8")):
                return "admin"
        raise HTTPException(status_code=401, detail="Token API invalide ou manquant")
    return user_id


def register(app: FastAPI):
    """Enregistre les routes atlas sur l'app Mercury."""

    @app.get("/atlas/health")
    async def atlas_health(request: Request):
        config = get_config()
        if not config.get("atlas_enabled", False):
            # health doit toujours répondre, même désactivé (status info)
            return {"enabled": False, "configured_brain_url": config.get("atlas_brain_url")}
        try:
            timeout = int(config.get("atlas_timeout_sec", _DEFAULT_TIMEOUT))
            async with httpx.AsyncClient(timeout=min(timeout, 10)) as client:
                resp = await client.get(_brain_url(config, "/health"))
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except Exception as e:
            logger.warning("atlas_health upstream unreachable: %s", e)
            return JSONResponse(
                content={"enabled": True, "upstream_error": str(e)},
                status_code=502,
            )

    @app.get("/atlas/models")
    async def atlas_models(request: Request):
        config = get_config()
        _check_enabled(config)
        _check_route_allowed("/models", config)
        _maybe_auth(request, config)

        try:
            timeout = int(config.get("atlas_timeout_sec", _DEFAULT_TIMEOUT))
            async with httpx.AsyncClient(timeout=min(timeout, 30)) as client:
                resp = await client.get(_brain_url(config, "/models"))
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except Exception as e:
            logger.exception("atlas_models upstream error")
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")

    @app.get("/atlas/backends")
    async def atlas_backends(request: Request):
        config = get_config()
        _check_enabled(config)
        _check_route_allowed("/backends", config)
        _maybe_auth(request, config)
        try:
            timeout = int(config.get("atlas_timeout_sec", _DEFAULT_TIMEOUT))
            async with httpx.AsyncClient(timeout=min(timeout, 10)) as client:
                resp = await client.get(_brain_url(config, "/backends"))
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except Exception as e:
            logger.exception("atlas_backends upstream error")
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")

    @app.post("/atlas/extract")
    async def atlas_extract(request: Request):
        """Extraction synchrone — utilisée si /extract/stream pas dispo ou simplicité."""
        config = get_config()
        _check_enabled(config)
        _check_route_allowed("/extract", config)
        user_id = _maybe_auth(request, config)

        body = await request.body()
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            raise HTTPException(status_code=400, detail="JSON invalide")

        request_id = str(uuid.uuid4())[:8]
        logger.info(
            "atlas extract: user=%s model=%s layer=%s (req %s)",
            user_id, payload.get("model"), payload.get("layer"), request_id,
        )

        timeout = int(config.get("atlas_timeout_sec", _DEFAULT_TIMEOUT))
        url = _brain_url(config, "/extract")
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=payload)
        except httpx.TimeoutException:
            raise HTTPException(
                status_code=504,
                detail=f"brain extract timeout after {timeout}s (req {request_id})",
            )
        except Exception as e:
            logger.exception("atlas extract error")
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
        finally:
            elapsed = time.perf_counter() - t0
            logger.info("atlas extract done in %.1fs (req %s)", elapsed, request_id)

        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                detail = resp.text
            raise HTTPException(status_code=resp.status_code, detail=detail)
        return JSONResponse(content=resp.json())

    @app.post("/atlas/extract/stream")
    async def atlas_extract_stream(request: Request):
        """Streaming NDJSON depuis brain.

        Chaque ligne est un événement JSON : queued, loading_model, model_loaded,
        progress, computing, exporting, result, error. Voir brain/atlas/README.md.
        """
        config = get_config()
        _check_enabled(config)
        _check_route_allowed("/extract/stream", config)
        user_id = _maybe_auth(request, config)

        body = await request.body()
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            raise HTTPException(status_code=400, detail="JSON invalide")

        request_id = str(uuid.uuid4())[:8]
        logger.info(
            "atlas extract/stream: user=%s model=%s layer=%s (req %s)",
            user_id, payload.get("model"), payload.get("layer"), request_id,
        )

        timeout = int(config.get("atlas_timeout_sec", _DEFAULT_TIMEOUT))
        url = _brain_url(config, "/extract/stream")

        async def relay():
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0)) as client:
                    async with client.stream("POST", url, json=payload) as resp:
                        if resp.status_code >= 400:
                            text = await resp.aread()
                            err_evt = {"event": "error", "message": text.decode("utf-8", "replace")[:500]}
                            yield (json.dumps(err_evt) + "\n").encode("utf-8")
                            return
                        async for line in resp.aiter_lines():
                            if not line:
                                continue
                            yield (line + "\n").encode("utf-8")
            except httpx.TimeoutException:
                yield (json.dumps({"event": "error", "message": f"brain timeout after {timeout}s"}) + "\n").encode("utf-8")
            except Exception as e:
                logger.exception("atlas extract/stream relay error (req %s)", request_id)
                yield (json.dumps({"event": "error", "message": str(e)}) + "\n").encode("utf-8")

        return StreamingResponse(relay(), media_type="application/x-ndjson")

    @app.post("/atlas/cancel")
    async def atlas_cancel(request: Request):
        """Demande au brain de tuer le subprocess d'extraction courant (best-effort).

        Petit timeout (10s) car c'est juste un signal de kill côté brain — pas
        besoin du timeout extract complet.
        """
        config = get_config()
        _check_enabled(config)
        _check_route_allowed("/cancel", config)
        _maybe_auth(request, config)

        body = await request.body()
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            payload = {}

        url = _brain_url(config, "/cancel")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload)
        except Exception as e:
            logger.warning("atlas cancel upstream error: %s", e)
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")

        if resp.status_code == 404:
            # Brain ne supporte pas encore le cancel — pas une vraie erreur.
            return JSONResponse(
                content={"cancelled": False, "reason": "brain /atlas/cancel not implemented"},
                status_code=200,
            )
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                detail = resp.text
            raise HTTPException(status_code=resp.status_code, detail=detail)
        return JSONResponse(content=resp.json())

    # ── mgmt passthrough : load/unload/status d'instance llama-server ────────
    # Sert au chat multi-turn AtlasMind : la page Chat demande au brain de loader
    # un modèle avec un cocktail de control_vector (cf brain-daemon 1.6.0 :
    # /mgmt/load accepte maintenant `control_vectors: [{path, scale}]`).

    @app.post("/atlas/mgmt/load")
    async def atlas_mgmt_load(request: Request):
        config = get_config()
        _check_enabled(config)
        _check_route_allowed("/mgmt/load", config)
        user_id = _maybe_auth(request, config)

        body = await request.body()
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            raise HTTPException(status_code=400, detail="JSON invalide")

        logger.info(
            "atlas mgmt load: user=%s model=%s cv=%d",
            user_id, payload.get("model_id") or payload.get("model"),
            len(payload.get("control_vectors") or []),
        )
        # Timeout long : chargement modèle 30B+ peut prendre 2-3 min cold start.
        timeout = int(config.get("atlas_timeout_sec", _DEFAULT_TIMEOUT))
        url = _brain_root_url(config, "/mgmt/load")
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=payload)
        except Exception as e:
            logger.exception("atlas mgmt load upstream error")
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                detail = resp.text
            raise HTTPException(status_code=resp.status_code, detail=detail)
        return JSONResponse(content=resp.json())

    @app.post("/atlas/mgmt/unload")
    async def atlas_mgmt_unload(request: Request):
        config = get_config()
        _check_enabled(config)
        _check_route_allowed("/mgmt/unload", config)
        _maybe_auth(request, config)

        body = await request.body()
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            raise HTTPException(status_code=400, detail="JSON invalide")

        url = _brain_root_url(config, "/mgmt/unload")
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(url, json=payload)
        except Exception as e:
            logger.warning("atlas mgmt unload upstream error: %s", e)
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                detail = resp.text
            raise HTTPException(status_code=resp.status_code, detail=detail)
        return JSONResponse(content=resp.json())

    @app.get("/atlas/mgmt/status")
    async def atlas_mgmt_status(request: Request):
        config = get_config()
        _check_enabled(config)
        _check_route_allowed("/mgmt/status", config)
        _maybe_auth(request, config)

        url = _brain_root_url(config, "/mgmt/status")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url)
        except Exception as e:
            logger.warning("atlas mgmt status upstream error: %s", e)
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
        return JSONResponse(content=resp.json(), status_code=resp.status_code)

    @app.get("/atlas/mgmt/loras")
    async def atlas_mgmt_loras(request: Request):
        """Proxy vers brain GET /mgmt/loras — liste les .gguf dans le répertoire lora."""
        config = get_config()
        _check_enabled(config)
        _check_route_allowed("/mgmt/loras", config)
        _maybe_auth(request, config)

        url = _brain_root_url(config, "/mgmt/loras")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url)
        except Exception as e:
            logger.warning("atlas mgmt loras upstream error: %s", e)
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
        if resp.status_code == 404:
            # brain-daemon ne supporte pas encore cet endpoint
            raise HTTPException(status_code=501, detail="brain-daemon: /mgmt/loras non implémenté — mets à jour brain-daemon")
        return JSONResponse(content=resp.json(), status_code=resp.status_code)

    # ── Presets cocktail control_vector ──────────────────────────────────────
    # Mercury orchestre la sélection de preset depuis le dashboard llamacpp :
    # liste pour un modèle donné (fetch AtlasMind), apply (résout preset →
    # cocktail brain_path/scale → /mgmt/load), clear (reload sans CV).
    #
    # AtlasMind est l'unique source de vérité pour la liste et le contenu des
    # presets. Mercury ne stocke aucune info preset en DB — il proxy.

    @app.get("/atlas/presets")
    async def atlas_presets(request: Request, model_id: str | None = None):
        """Liste les presets disponibles pour un modèle.

        Délègue à AtlasMind /api/atlasmind/presets/export?model=<id>.
        Sans `model_id`, retourne tous les presets exportables.
        """
        config = get_config()
        _check_enabled(config)
        _maybe_auth(request, config)

        params = {}
        if model_id:
            params["model"] = model_id

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    _atlasmind_url(config, "/api/atlasmind/presets/export"),
                    params=params,
                    headers=_atlasmind_headers(config),
                )
        except Exception as e:
            logger.warning("atlas presets upstream error: %s", e)
            raise HTTPException(status_code=502, detail=f"atlasmind unreachable: {e}")
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                detail = resp.text
            raise HTTPException(status_code=resp.status_code, detail=detail)
        return JSONResponse(content=resp.json())

    @app.post("/atlas/mgmt/apply-preset")
    async def atlas_mgmt_apply_preset(request: Request):
        """Assigne un preset à un modèle (persistant, sans loader).

        Body: {model_id: str, preset_id: int}

        Flow :
          1. Fetch le preset détaillé depuis AtlasMind (/api/atlasmind/presets/{id}).
          2. Vérifie que preset.model == model_id (sanity check).
          3. Convertit cocktail_json -> control_vectors [{path: brain_path, scale}].
          4. Lit layer_range_json depuis le preset.
          5. POST brain /mgmt/set-preset (persistance dans load_configs.json,
             sans déclencher de load). Au prochain /mgmt/load, le cocktail est
             appliqué automatiquement.

        Note: si le modèle est déjà running, son cocktail courant reste
        inchangé. Le nouveau preset prend effet au prochain unload+load.
        """
        config = get_config()
        _check_enabled(config)
        user_id = _maybe_auth(request, config)

        body = await request.body()
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            raise HTTPException(status_code=400, detail="JSON invalide")

        model_id = payload.get("model_id")
        preset_id = payload.get("preset_id")
        if not model_id or preset_id is None:
            raise HTTPException(status_code=400, detail="model_id et preset_id requis")

        # 1. Fetch preset détaillé (row brut, cocktail_json string)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    _atlasmind_url(config, f"/api/atlasmind/presets/{preset_id}"),
                    headers=_atlasmind_headers(config),
                )
        except Exception as e:
            logger.warning("apply-preset: atlasmind unreachable: %s", e)
            raise HTTPException(status_code=502, detail=f"atlasmind unreachable: {e}")
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail=f"preset {preset_id} not found")
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text[:500])
        preset = resp.json()

        # 2. Sanity check model match
        preset_model = preset.get("model")
        if preset_model and preset_model != model_id:
            raise HTTPException(
                status_code=400,
                detail=f"preset {preset_id} appartient au modèle {preset_model!r}, pas {model_id!r}",
            )

        # 3. Cocktail → control_vectors
        try:
            cocktail_raw = json.loads(preset.get("cocktail_json") or "[]")
        except (json.JSONDecodeError, TypeError):
            cocktail_raw = []
        control_vectors = [
            {"path": v["brain_path"], "scale": float(v.get("scale", 1.0))}
            for v in cocktail_raw
            if v.get("brain_path")
        ]
        # Un preset est valide s'il a soit des control_vectors, soit un lora_path.
        lora_path = (preset.get("lora_path") or "").strip()
        if not control_vectors and not lora_path:
            raise HTTPException(
                status_code=400,
                detail=f"preset {preset_id} n'a ni control_vector exportable ni lora_path",
            )

        # 4. layer_range : priorité aux layers snapshotés dans cocktail_json (presets récents),
        #    fallback sur layer_range_json (presets créés avant le refacto layer 2026-05-22).
        layer_range = None
        cocktail_layers = [
            int(v["layer"]) for v in cocktail_raw if v.get("layer") is not None
        ]
        if cocktail_layers:
            unique = sorted(set(cocktail_layers))
            layer_range = [unique[0], unique[-1]]
        else:
            try:
                lr = json.loads(preset["layer_range_json"]) if preset.get("layer_range_json") else None
                if isinstance(lr, list) and len(lr) == 2:
                    layer_range = lr
            except (json.JSONDecodeError, TypeError):
                pass

        set_payload: dict = {
            "model_id": model_id,
            "control_vectors": control_vectors,
            "active_preset_id": preset_id,
            "active_preset_name": preset.get("name"),
        }
        if layer_range is not None:
            set_payload["control_vector_layer_range"] = layer_range
        # LoRA adapters snapshot — wrap singleton AtlasMind (lora_path/lora_scale
        # scalaires côté DB preset) en array pour le brain multi-LoRA. Le brain
        # injectera `lora: [{id:0, scale:X}, ...]` per-request.
        if lora_path:
            lora_scale = float(preset.get("lora_scale") or 1.0)
            set_payload["loras"] = [{"path": lora_path, "default_scale": lora_scale}]

        logger.info(
            "set-preset: user=%s model=%s preset=%s (%r) cv=%d layer_range=%s loras=%s",
            user_id, model_id, preset_id, preset.get("name"),
            len(control_vectors), layer_range,
            set_payload.get("loras") or None,
        )

        # 5. POST brain /mgmt/set-preset (persistance sans load)
        url = _brain_root_url(config, "/mgmt/set-preset")
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                brain_resp = await client.post(url, json=set_payload)
        except Exception as e:
            logger.exception("set-preset: brain unreachable")
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
        if brain_resp.status_code >= 400:
            try:
                detail = brain_resp.json().get("detail", brain_resp.text)
            except Exception:
                detail = brain_resp.text
            raise HTTPException(status_code=brain_resp.status_code, detail=detail)

        return JSONResponse(content={
            "assigned": True,
            "preset_id": preset_id,
            "preset_name": preset.get("name"),
            "model_id": model_id,
            "brain_response": brain_resp.json(),
        })

    @app.post("/atlas/mgmt/apply-presets")
    async def atlas_mgmt_apply_presets(request: Request):
        """Assigne PLUSIEURS presets à un modèle simultanément, en concaténant
        leurs LoRA adapters dans un stack multi-LoRA côté brain.

        Body: {model_id: str, preset_ids: [int]}

        Sémantique :
          - LoRAs : tous les `lora_path` des presets cochés sont concaténés dans
            `loras: [...]` envoyé au brain. L'ordre côté llama-server (= ordre
            `--lora` au boot, = id 0/1/2…) suit l'ordre de `preset_ids` reçu.
            Mastermind devra matcher cet ordre via ses `loraScales[]` slider par
            slider.
          - Control vectors : merger des CV de N presets avec des layer_range
            potentiellement conflictuels est fragile (on logge un warn et on
            prend ceux du PREMIER preset qui en a). Cas typique single-user :
            l'utilisateur coche des "presets LoRA pur" → 0 conflit.
          - active_preset_id/name : on stocke le premier en id et "p1 + p2 + …"
            en name pour l'affichage dashboard. La liste exhaustive est dans
            `active_preset_ids` (persisté côté brain pour pré-cocher l'UI).

        Refus si `preset_ids` vide → 400 (utiliser /clear-preset à la place).
        """
        config = get_config()
        _check_enabled(config)
        user_id = _maybe_auth(request, config)

        body = await request.body()
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            raise HTTPException(status_code=400, detail="JSON invalide")

        model_id = payload.get("model_id")
        preset_ids_raw = payload.get("preset_ids")
        if not model_id:
            raise HTTPException(status_code=400, detail="model_id requis")
        if not isinstance(preset_ids_raw, list) or not preset_ids_raw:
            raise HTTPException(status_code=400, detail="preset_ids doit être une liste non-vide (sinon use /clear-preset)")
        try:
            preset_ids: list[int] = [int(pid) for pid in preset_ids_raw]
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="preset_ids doivent être des entiers")

        # 1. Fetch les N presets en parallèle (asyncio.gather pour éviter N round-trips séquentiels).
        async def _fetch_one(pid: int) -> dict:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    _atlasmind_url(config, f"/api/atlasmind/presets/{pid}"),
                    headers=_atlasmind_headers(config),
                )
            if resp.status_code == 404:
                raise HTTPException(status_code=404, detail=f"preset {pid} not found")
            if resp.status_code >= 400:
                raise HTTPException(status_code=resp.status_code, detail=resp.text[:500])
            return resp.json()

        # return_exceptions=True évite les tâches orphelines httpx si l'une lève en premier.
        raw_results = await asyncio.gather(*(_fetch_one(pid) for pid in preset_ids), return_exceptions=True)
        # Propager la première exception dans l'ordre des preset_ids.
        http_exc: HTTPException | None = None
        other_exc: Exception | None = None
        presets = []
        for res in raw_results:
            if isinstance(res, HTTPException):
                if http_exc is None:
                    http_exc = res
            elif isinstance(res, Exception):
                if other_exc is None:
                    other_exc = res
            else:
                presets.append(res)
        if http_exc is not None:
            raise http_exc
        if other_exc is not None:
            logger.warning("apply-presets: atlasmind unreachable: %s", other_exc)
            raise HTTPException(status_code=502, detail=f"atlasmind unreachable: {other_exc}")

        # 2. Sanity check model match sur tous les presets.
        for pid, preset in zip(preset_ids, presets):
            pm = preset.get("model")
            if pm and pm != model_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"preset {pid} appartient au modèle {pm!r}, pas {model_id!r}",
                )

        # 3. Concat des LoRAs dans l'ordre des preset_ids reçus.
        loras_stack: list[dict] = []
        for pid, preset in zip(preset_ids, presets):
            lp = (preset.get("lora_path") or "").strip()
            if not lp:
                logger.info("apply-presets: preset #%s pas de lora_path — ignoré pour le stack LoRA", pid)
                continue
            loras_stack.append({
                "path": lp,
                "default_scale": float(preset.get("lora_scale") or 1.0),
            })

        # 4. CV : on prend le premier preset qui en a, warn si d'autres en ont aussi.
        cv_chosen_pid: int | None = None
        cv_chosen_preset: dict | None = None
        cv_skipped: list[int] = []
        for pid, preset in zip(preset_ids, presets):
            try:
                cocktail = json.loads(preset.get("cocktail_json") or "[]")
            except (json.JSONDecodeError, TypeError):
                cocktail = []
            has_cv = any(v.get("brain_path") for v in cocktail)
            if has_cv:
                if cv_chosen_pid is None:
                    cv_chosen_pid = pid
                    cv_chosen_preset = preset
                else:
                    cv_skipped.append(pid)
        if cv_skipped:
            logger.warning(
                "apply-presets: %d preset(s) ont des CV au-delà du premier (%s) — CV de ces presets IGNORÉS : %s",
                len(cv_skipped), cv_chosen_pid, cv_skipped,
            )

        control_vectors: list[dict] = []
        layer_range: list[int] | None = None
        if cv_chosen_preset is not None:
            try:
                cocktail = json.loads(cv_chosen_preset.get("cocktail_json") or "[]")
            except (json.JSONDecodeError, TypeError):
                cocktail = []
            control_vectors = [
                {"path": v["brain_path"], "scale": float(v.get("scale", 1.0))}
                for v in cocktail if v.get("brain_path")
            ]
            cv_layers = [int(v["layer"]) for v in cocktail if v.get("layer") is not None]
            if cv_layers:
                u = sorted(set(cv_layers))
                layer_range = [u[0], u[-1]]
            else:
                try:
                    lr = json.loads(cv_chosen_preset["layer_range_json"]) if cv_chosen_preset.get("layer_range_json") else None
                    if isinstance(lr, list) and len(lr) == 2:
                        layer_range = lr
                except (json.JSONDecodeError, TypeError):
                    pass

        if not loras_stack and not control_vectors:
            raise HTTPException(
                status_code=400,
                detail="Aucun des presets sélectionnés n'apporte de LoRA ni de control_vector exportable",
            )

        # 5. Build payload pour /mgmt/set-preset.
        # active_preset_id = premier id (compat affichage) ; active_preset_ids = liste exhaustive
        # pour que le dashboard pré-coche correctement au rechargement.
        names = [p.get("name") or f"#{pid}" for pid, p in zip(preset_ids, presets)]
        composite_name = " + ".join(names)
        set_payload: dict = {
            "model_id": model_id,
            "control_vectors": control_vectors,
            "active_preset_id": preset_ids[0],
            "active_preset_ids": preset_ids,
            "active_preset_name": composite_name,
            "loras": loras_stack,
        }
        if layer_range is not None:
            set_payload["control_vector_layer_range"] = layer_range

        logger.info(
            "apply-presets: user=%s model=%s presets=%s loras=%d cv=%d (from preset #%s) cv_skipped=%s",
            user_id, model_id, preset_ids, len(loras_stack), len(control_vectors),
            cv_chosen_pid, cv_skipped,
        )

        # 6. POST brain /mgmt/set-preset.
        url = _brain_root_url(config, "/mgmt/set-preset")
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                brain_resp = await client.post(url, json=set_payload)
        except Exception as e:
            logger.exception("apply-presets: brain unreachable")
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
        if brain_resp.status_code >= 400:
            try:
                detail = brain_resp.json().get("detail", brain_resp.text)
            except Exception:
                detail = brain_resp.text
            raise HTTPException(status_code=brain_resp.status_code, detail=detail)

        return JSONResponse(content={
            "assigned": True,
            "preset_ids": preset_ids,
            "preset_name": composite_name,
            "model_id": model_id,
            "loras_count": len(loras_stack),
            "cv_count": len(control_vectors),
            "cv_skipped": cv_skipped,
            "brain_response": brain_resp.json(),
        })

    @app.post("/atlas/mgmt/clear-preset")
    async def atlas_mgmt_clear_preset(request: Request):
        """Retire le preset assigné d'un modèle (persistant, sans loader).

        Body: {model_id: str}

        Efface l'assignation cocktail dans load_configs.json. Si le modèle est
        déjà running, son cocktail courant reste actif jusqu'au prochain
        unload+load (où il chargera sans CV).
        """
        config = get_config()
        _check_enabled(config)
        user_id = _maybe_auth(request, config)

        body = await request.body()
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            raise HTTPException(status_code=400, detail="JSON invalide")

        model_id = payload.get("model_id")
        if not model_id:
            raise HTTPException(status_code=400, detail="model_id requis")

        set_payload: dict = {
            "model_id": model_id,
            "control_vectors": [],
            "active_preset_id": None,
            "active_preset_ids": [],   # purge aussi la liste multi-select côté brain
            "active_preset_name": None,
            "loras": [],   # reset explicite pour éviter snapshot fantôme dans load_configs.json
        }

        logger.info("clear-preset: user=%s model=%s", user_id, model_id)

        url = _brain_root_url(config, "/mgmt/set-preset")
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                brain_resp = await client.post(url, json=set_payload)
        except Exception as e:
            logger.exception("clear-preset: brain unreachable")
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")
        if brain_resp.status_code >= 400:
            try:
                detail = brain_resp.json().get("detail", brain_resp.text)
            except Exception:
                detail = brain_resp.text
            raise HTTPException(status_code=brain_resp.status_code, detail=detail)

        return JSONResponse(content={
            "cleared": True,
            "model_id": model_id,
            "brain_response": brain_resp.json(),
        })

    @app.post("/atlas/test")
    async def atlas_test(request: Request):
        """Test interactif d'une combinaison de control vectors. Voir brain/atlas/README.md."""
        config = get_config()
        _check_enabled(config)
        _check_route_allowed("/test", config)
        _maybe_auth(request, config)

        body = await request.body()
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            raise HTTPException(status_code=400, detail="JSON invalide")

        # Pas de cap à 300s : cold load 31B + génération 256 tokens peut dépasser.
        # Le brain a son propre `atlas.test_timeout_sec` (default 600s) qui sert de
        # vrai garde-fou côté inférence ; Mercury reflète ce timeout côté HTTP.
        timeout = int(config.get("atlas_timeout_sec", _DEFAULT_TIMEOUT))
        url = _brain_url(config, "/test")
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=payload)
        except Exception as e:
            logger.exception("atlas test error")
            raise HTTPException(status_code=502, detail=f"brain unreachable: {e}")

        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                detail = resp.text
            raise HTTPException(status_code=resp.status_code, detail=detail)
        return JSONResponse(content=resp.json())
