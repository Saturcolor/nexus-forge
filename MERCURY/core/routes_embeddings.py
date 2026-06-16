"""
Route POST /v1/embeddings — broker avec fallback en cascade.

Mercury route les appels embedding vers une chaine ordonnée de modèles
(local brain-daemon + cloud OpenRouter), avec fallback automatique sur
status retryable, timeout, ou modèle indisponible.

La chaine est dérivée à chaque requête depuis la config :
- local_embedding_models : [{model, dim, priority}, ...]
- openrouter_embedding_model + openrouter_embedding_dim + openrouter_embedding_priority
"""
import logging
import os
import time
from typing import Any

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

from routing.router import get_config

logger = logging.getLogger("mercury.embeddings")

DEFAULT_TIMEOUT_MS = 15000
DEFAULT_RETRYABLE_STATUS = [408, 429, 500, 502, 503, 504]


def _build_chain(cfg: dict) -> list[dict]:
    """Construit la chaine ordonnée embedding depuis la config Mercury."""
    chain: list[dict] = []

    for entry in cfg.get("local_embedding_models") or []:
        model = (entry.get("model") or "").strip()
        if not model:
            continue
        chain.append({
            "id": entry.get("id") or f"local-{model.split('/')[-1]}",
            "backend": "llamacpp",
            "model": model,
            "dim": entry.get("dim"),
            "priority": int(entry.get("priority", 1)),
        })

    cloud_model = (cfg.get("openrouter_embedding_model") or "").strip()
    if cloud_model and cfg.get("openrouter_enabled") and (cfg.get("openrouter_api_key") or "").strip():
        chain.append({
            "id": "cloud-openrouter",
            "backend": "openrouter",
            "model": cloud_model,
            "dim": cfg.get("openrouter_embedding_dim"),
            "priority": int(cfg.get("openrouter_embedding_priority", 99)),
        })

    return sorted(chain, key=lambda e: e["priority"])


def _resolve_backend_url(backend: str, cfg: dict) -> str:
    """Retourne la base URL du backend, SANS suffixe /v1 (qui est ajouté par _embedding_endpoint)."""
    if backend == "llamacpp":
        # brain-daemon expose /v1/embeddings directement
        return str(cfg.get("llamacpp_url", "http://localhost:4321")).rstrip("/")
    if backend == "openrouter":
        # OpenRouter API base est /api, le /v1 est ajouté par le suffixe endpoint
        return "https://openrouter.ai/api"
    raise ValueError(f"unknown embedding backend: {backend}")


def _auth_headers(backend: str, cfg: dict) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if backend == "openrouter":
        api_key = (cfg.get("openrouter_api_key") or "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        if cfg.get("openrouter_http_referer"):
            headers["HTTP-Referer"] = cfg["openrouter_http_referer"]
        if cfg.get("openrouter_title"):
            headers["X-Title"] = cfg["openrouter_title"]
    return headers


def _embedding_endpoint(backend: str) -> str:
    return "/v1/embeddings"


def register(app: FastAPI):
    @app.post("/v1/embeddings")
    async def embeddings(request: Request):
        # Slot guard (F1 rapport fonctionnel) : si la chaîne contient des entrées
        # locales (llamacpp), elles consomment le GPU du brain-daemon — même
        # contrat que /v1/chat/completions.
        from auth import resolve_user
        from scheduler import state as slot_state
        user_id, _, _ = resolve_user(request.headers.get("Authorization"))
        rej = slot_state.build_slot_rejection(user_id)
        if rej is not None:
            return JSONResponse(**rej["response"])

        body = await request.json()
        if os.environ.get("MERCURY_DEMO_MODE"):
            inp = body.get("input")
            items = inp if isinstance(inp, list) else [inp]
            data = [
                {"object": "embedding", "index": i,
                 "embedding": [round(((i * 31 + j * 7) % 100) / 100, 4) for j in range(16)]}
                for i in range(len(items))
            ]
            return JSONResponse({
                "object": "list", "data": data,
                "model": body.get("model") or "demo-embed",
                "usage": {"prompt_tokens": 0, "total_tokens": 0},
            })
        cfg = get_config()
        chain = _build_chain(cfg)

        # Filtrage par hint client : ?prefer=cloud skip les entrées local (libère GPU)
        # ?prefer=local skip cloud (déconnecté ou test)
        prefer = (request.query_params.get("prefer") or "").strip().lower()
        if prefer == "cloud":
            chain = [e for e in chain if e["backend"] != "llamacpp"]
        elif prefer == "local":
            chain = [e for e in chain if e["backend"] == "llamacpp"]
        elif prefer:
            logger.warning("ignored unknown prefer hint: %s", prefer)

        if not chain:
            raise HTTPException(503, f"no embedding model in chain (after prefer={prefer or 'none'} filter)")

        triggers = cfg.get("embedding_fallback_triggers") or {}
        timeout_s = float(triggers.get("timeout_ms", DEFAULT_TIMEOUT_MS)) / 1000.0
        retryable = set(triggers.get("retryable_status") or DEFAULT_RETRYABLE_STATUS)
        # F2 rapport fonctionnel : le flag config `model_unavailable` n'était lu nulle part
        # → un 404 du brain-daemon (modèle absent) sortait en erreur finale même quand
        # le user avait configuré "fallback sur modèle inconnu = oui". On traite désormais
        # 404 comme retryable quand le flag est vrai (défaut True dans router.py).
        fallback_on_model_unavailable = bool(triggers.get("model_unavailable", True))

        client_model = body.get("model")  # nom envoyé par le client, on le réécrit dans la réponse
        last_error: str | None = None

        for entry in chain:
            backend = entry["backend"]
            try:
                base = _resolve_backend_url(backend, cfg)
            except ValueError as e:
                logger.warning("skip entry %s: %s", entry.get("id"), e)
                last_error = str(e)
                continue

            payload = {**body, "model": entry["model"]}
            url = f"{base}{_embedding_endpoint(backend)}"
            headers = _auth_headers(backend, cfg)
            t0 = time.perf_counter()

            try:
                async with httpx.AsyncClient(timeout=timeout_s) as client:
                    r = await client.post(url, json=payload, headers=headers)
                duration_ms = (time.perf_counter() - t0) * 1000

                if r.status_code in retryable:
                    logger.warning(
                        "embedding %s returned %d (%.0fms), falling back",
                        entry["id"], r.status_code, duration_ms,
                    )
                    last_error = f"{r.status_code} from {entry['id']}"
                    continue

                if r.status_code == 404 and fallback_on_model_unavailable:
                    logger.warning(
                        "embedding %s model_unavailable 404 (%.0fms), falling back (model_unavailable=true)",
                        entry["id"], duration_ms,
                    )
                    last_error = f"404 model_unavailable from {entry['id']}"
                    continue

                if r.status_code >= 400:
                    # Erreur non-retryable (400, 401, 403...) : renvoyer telle quelle au client
                    try:
                        return JSONResponse(content=r.json(), status_code=r.status_code)
                    except Exception:
                        return JSONResponse(
                            content={"detail": r.text[:500]}, status_code=r.status_code,
                        )

                data: Any = r.json()
                if client_model and isinstance(data, dict) and "model" in data:
                    data["model"] = client_model
                logger.info(
                    "embedding ok via %s (%s) %.0fms",
                    entry["id"], entry["model"], duration_ms,
                )
                return JSONResponse(content=data, status_code=r.status_code)

            except httpx.TimeoutException:
                duration_ms = (time.perf_counter() - t0) * 1000
                logger.warning(
                    "embedding %s timed out after %.0fms, falling back",
                    entry["id"], duration_ms,
                )
                last_error = f"timeout from {entry['id']}"
                continue
            except httpx.HTTPError as e:
                logger.warning(
                    "embedding %s HTTP error (%s), falling back",
                    entry["id"], type(e).__name__,
                )
                last_error = f"{type(e).__name__} from {entry['id']}: {e}"
                continue

        raise HTTPException(502, f"all embedding backends failed: {last_error}")

    @app.get("/v1/embeddings/chain")
    async def get_embedding_chain():
        """Expose la chaine embedding ordonnée pour les consommateurs (Mastermind, etc.).

        Renvoie la liste des modèles disponibles avec leur backend, priorité et dim,
        permettant aux clients de valider la cohérence dim avant d'utiliser /v1/embeddings.
        """
        cfg = get_config()
        chain = _build_chain(cfg)
        return {
            "object": "list",
            "data": [
                {
                    "id": e["id"],
                    "model": e["model"],
                    "backend": e["backend"],
                    "priority": e["priority"],
                    "dim": e.get("dim"),
                }
                for e in chain
            ],
        }
