"""Routes admin LM Studio : liste des modèles avec état chargé, load/unload, inject-prompt."""
import asyncio
import json
import logging
import re as _re
import time
from typing import Any

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from admin.common import log_probe_warning
from routing.router import get_config, apply_db_overrides
from providers.lm_studio.load_cache import mark_load_done, invalidate_for_instance
from providers.lm_studio.last_metrics import get_last_metrics as get_lm_studio_last_metrics
from providers.ollama.last_metrics import get_last_metrics
from core.prompt_cache import get_cached_body, set_injected_response_id

# Cached count of running/loaded models (updated by get_host_stats, read by /admin/version)
_last_running_models: int = 0

def get_running_models_count() -> int:
    return _last_running_models
from data import db as db_module

logger = logging.getLogger(__name__)
router = APIRouter()


def _lm_studio_base() -> str:
    config = get_config()
    if not config.get("lm_studio_enabled"):
        return ""
    return str(config.get("lm_studio_url", "http://localhost:1234")).rstrip("/")


PROBE_TIMEOUT = 5.0


# Note: l'endpoint GET /lm-studio/probe a été retiré. Les stats machine sont
# désormais exposées par brain-daemon ; le service `probe/` standalone est
# conservé en archive dans le repo mais n'est plus appelé par l'API admin.
# Le compose `GET /host-stats` ci-dessous continue de fonctionner en fallback
# (no-op si `lm_studio_probe_url` est vide).


def _normalize_host_stats(sys_: dict, lm: dict | None = None, ollama: dict | None = None) -> dict:
    """Construit le payload host-stats à partir de system + optionnellement lmstudio et ollama."""
    mem = sys_.get("memory") or {}
    gpu = sys_.get("gpu") or {}
    temps = sys_.get("temperatures") or {}
    net = sys_.get("network") or {}
    out = {
        "cpu": {"percent": sys_.get("cpu_percent")},
        "gpu": {"percent": gpu.get("percent")},
        "ram": {
            "used_mb": mem.get("used_mb"),
            "total_mb": mem.get("total_mb"),
            "percent": mem.get("percent"),
        },
        "vram": {
            "used_mb": gpu.get("vram_used_mb"),
            "total_mb": gpu.get("vram_total_mb"),
        },
        "uptime_seconds": sys_.get("uptime_seconds"),
        "temperature": {
            "cpu_c": temps.get("cpu_c"),
            "gpu_c": temps.get("gpu_c"),
            "nvme_c": temps.get("nvme_c"),
        },
        "network": {
            "rx_mb": net.get("rx_mb"),
            "tx_mb": net.get("tx_mb"),
        },
    }
    if lm is not None:
        raw_progress = lm.get("loading_progress")
        model_loading_flag = bool(lm.get("model_loading"))

        if raw_progress and isinstance(raw_progress, str):
            s = raw_progress.strip()
            low = s.lower()
            if low == "loaded":
                loading_progress = "loaded"
                model_loading_flag = False
            elif low == "idle":
                # "all slots are idle" depuis la probe = modèle IS chargé et prêt → Ready (vert)
                loading_progress = "loaded"
                model_loading_flag = False
            elif s.endswith("%"):
                # "40.9%" = progression du prompt → ⚡ Prompt XX% (bleu)
                try:
                    pct = round(float(s[:-1].strip()))
                    loading_progress = f"prompt:{min(100, max(0, pct))}"
                    model_loading_flag = False
                except (ValueError, TypeError):
                    loading_progress = s
            else:
                # "23/50" = context checkpoint (kv-cache) = traitement du prompt → ⚡ Prompt XX% (bleu)
                frac_m = _re.match(r'^(\d+)/(\d+)$', s)
                if frac_m:
                    num, den = int(frac_m.group(1)), int(frac_m.group(2))
                    pct = round((num / den) * 100) if den > 0 else 0
                    loading_progress = f"prompt:{min(100, max(0, pct))}"
                    model_loading_flag = False
                else:
                    loading_progress = raw_progress
        else:
            loading_progress = "idle"
            model_loading_flag = False
        out["lmstudio"] = {
            "model_loading": model_loading_flag,
            "loading_progress": loading_progress,
            "running_models": lm.get("running_models"),
            "loaded_model": lm.get("loaded_model"),
            "ctx_size": lm.get("ctx_size"),
            "last_generation_tokens_per_second": lm.get("last_generation_tokens_per_second"),
            "last_prompt_tokens": lm.get("last_prompt_tokens"),
            "last_generation_tokens": lm.get("last_generation_tokens"),
            "last_activity_ts": lm.get("last_activity_ts"),
        }
    if ollama is not None:
        out["ollama"] = ollama
    return out


@router.get("/host-stats")
async def get_host_stats():
    """Stats machine + état LM Studio et/ou Ollama pour le HostStatsCard (probes + métriques proxy).
    Les URLs lm_studio_probe_url et ollama_probe_url doivent pointer vers la machine où la probe écoute
    (ex. http://brain:4567), pas vers le middleware lui-même.
    """
    config = get_config()
    lm_studio_enabled = config.get("lm_studio_enabled", True) is not False
    ollama_enabled = config.get("ollama_enabled", True) is not False
    lm_url = (config.get("lm_studio_probe_url") or "").strip()
    ollama_url = (config.get("ollama_probe_url") or "").strip()
    llamacpp_url = (config.get("llamacpp_url") or "").strip() if config.get("llamacpp_enabled", True) else ""
    lm_studio_base = _lm_studio_base()
    if not lm_url and not ollama_url and not llamacpp_url and not lm_studio_base:
        return JSONResponse(status_code=200, content=None)
    sys_: dict = {}
    lm: dict | None = None
    ollama: dict | None = None
    llamacpp: dict | None = None
    lm_api_items: list = []

    def _merge_probe_response(data: dict) -> None:
        """Remplit sys_, lm, ollama à partir d'une réponse /stats (une seule probe peut exposer system + lmstudio + ollama)."""
        nonlocal sys_, lm, ollama
        if data.get("system"):
            sys_ = data.get("system") or sys_
        if lm_studio_enabled and data.get("lmstudio") is not None and lm is None:
            lm = data.get("lmstudio") or {}
        probe_ollama = data.get("ollama")
        if ollama_enabled and probe_ollama is not None:
            proxy_metrics = get_last_metrics()
            ollama = {
                "model_loading": probe_ollama.get("model_loading"),
                "loading_progress": probe_ollama.get("loading_progress"),
                "last_generation_tokens_per_second": proxy_metrics.get("last_generation_tokens_per_second")
                or probe_ollama.get("last_generation_tokens_per_second"),
                "last_prompt_tokens": proxy_metrics.get("last_prompt_tokens")
                or probe_ollama.get("last_prompt_tokens"),
                "last_generation_tokens": proxy_metrics.get("last_generation_tokens")
                or probe_ollama.get("last_generation_tokens"),
                "last_activity_ts": proxy_metrics.get("last_activity_ts")
                or probe_ollama.get("last_activity_ts"),
                "loaded_models": probe_ollama.get("loaded_models"),
            }

    async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
        if lm_url:
            try:
                r = await client.get(f"{lm_url.rstrip('/')}/stats")
                if r.status_code == 200:
                    _merge_probe_response(r.json())
            except Exception as e:
                log_probe_warning(lm_url, "lm_studio", e)
        if ollama_url:
            try:
                r = await client.get(f"{ollama_url.rstrip('/')}/stats")
                if r.status_code == 200:
                    _merge_probe_response(r.json())
            except Exception as e:
                log_probe_warning(ollama_url, "ollama", e)
        # Fallback : si aucune probe séparée n'a fourni les stats système,
        # les récupérer depuis le brain-daemon unifié (GET /stats)
        if not sys_ and llamacpp_url:
            try:
                r = await client.get(f"{llamacpp_url.rstrip('/')}/stats")
                if r.status_code == 200:
                    _merge_probe_response(r.json())
            except Exception as e:
                log_probe_warning(llamacpp_url, "brain-stats", e)
        if llamacpp_url:
            try:
                from providers.llamacpp.last_metrics import get_last_metrics as get_llamacpp_metrics
                status_r = await client.get(f"{llamacpp_url.rstrip('/')}/mgmt/status")
                instances = status_r.json() if status_r.status_code == 200 else []
                # Enrichir avec `kind` (gguf/hf) depuis /mgmt/models pour permettre au
                # frontend de grouper les instances par provider (llamacpp / vllm / lucebox).
                # `backend_type` est déjà exposé directement par /mgmt/status (= "lucebox"
                # pour les instances natives Lucebox). Sans `kind` on ne peut pas séparer
                # vLLM de llama.cpp côté stats machine.
                try:
                    models_r = await client.get(f"{llamacpp_url.rstrip('/')}/mgmt/models")
                    if models_r.status_code == 200:
                        raw_models = models_r.json() or []
                        kind_map = {
                            (m.get("model_id") or m.get("id") or ""): (m.get("kind") or "gguf")
                            for m in raw_models if isinstance(m, dict)
                        }
                        for inst in instances:
                            mid = inst.get("model_id") or ""
                            if mid and "kind" not in inst:
                                inst["kind"] = kind_map.get(mid, "gguf")
                except Exception as _e:
                    log_probe_warning(llamacpp_url, "llamacpp-models-join", _e)
                lc_metrics = get_llamacpp_metrics()
                # ready=True → serveur HTTP prêt ; running=True mais ready=False → en cours de chargement
                loading_instances = [i for i in instances if i.get("running") and not i.get("ready", False)]
                running_instances = [i for i in instances if i.get("ready", False)]
                model_loading = len(loading_instances) > 0
                if model_loading:
                    pct = loading_instances[0].get("loading_pct") or 0
                    loading_progress = f"loading:{pct}" if pct else "loading"
                elif running_instances:
                    max_prompt_pct = max(i.get("prompt_pct") or 0 for i in running_instances)
                    loading_progress = f"prompt:{max_prompt_pct}" if max_prompt_pct else "loaded"
                else:
                    loading_progress = "idle"
                llamacpp = {
                    "model_loading": model_loading,
                    "loading_progress": loading_progress,
                    "running_models": len(running_instances),
                    "instances": instances,
                    "last_generation_tokens_per_second": lc_metrics.get("last_generation_tokens_per_second"),
                    "last_prompt_tokens": lc_metrics.get("last_prompt_tokens"),
                    "last_generation_tokens": lc_metrics.get("last_generation_tokens"),
                    "last_activity_ts": lc_metrics.get("last_activity_ts"),
                    "by_model": lc_metrics.get("by_model") or {},
                }
            except Exception as e:
                log_probe_warning(llamacpp_url, "llamacpp", e)
        if lm_studio_base:
            try:
                r = await client.get(f"{lm_studio_base}/api/v1/models")
                if r.status_code == 200:
                    data = r.json()
                    items = data.get("models", data.get("data", []))
                    lm_api_items = [m for m in (items if isinstance(items, list) else []) if isinstance(m, dict)]
            except Exception as e:
                log_probe_warning(lm_studio_base, "lm_studio_models", e)

    # Extraire les infos des modèles chargés depuis l'API LM Studio
    lm_running_list = [m for m in lm_api_items if len(m.get("loaded_instances") or []) > 0]
    lm_running_count = len(lm_running_list)
    lm_loaded_model_name: str | None = None
    lm_ctx_size: int | None = None
    if lm_running_list:
        first = lm_running_list[0]
        lm_loaded_model_name = first.get("display_name") or first.get("key") or first.get("id") or None
        insts = first.get("loaded_instances") or []
        if insts and isinstance(insts[0], dict):
            cfg = insts[0].get("config")
            if isinstance(cfg, dict):
                raw_ctx = cfg.get("contextLength") or cfg.get("n_ctx") or cfg.get("context_length")
                try:
                    lm_ctx_size = int(raw_ctx) if raw_ctx is not None else None
                except (ValueError, TypeError):
                    lm_ctx_size = None

    # Fusionner métriques proxy + infos API avec lm (probe) si présent
    if lm is not None:
        proxy_metrics = get_lm_studio_last_metrics()
        lm = {
            "model_loading": lm.get("model_loading"),
            "loading_progress": lm.get("loading_progress"),
            "running_models": lm_running_count,
            "loaded_model": lm_loaded_model_name,
            "ctx_size": lm_ctx_size,
            "last_generation_tokens_per_second": proxy_metrics.get("last_generation_tokens_per_second")
            or lm.get("last_generation_tokens_per_second"),
            "last_prompt_tokens": proxy_metrics.get("last_prompt_tokens") or lm.get("last_prompt_tokens"),
            "last_generation_tokens": proxy_metrics.get("last_generation_tokens") or lm.get("last_generation_tokens"),
            "last_activity_ts": proxy_metrics.get("last_activity_ts") or lm.get("last_activity_ts"),
        }
    elif lm_studio_base:
        # Sans probe : construire lmstudio depuis l'API + métriques proxy
        lc_metrics = get_lm_studio_last_metrics()
        lm = {
            "model_loading": False,
            "loading_progress": "loaded" if lm_running_count > 0 else "idle",
            "running_models": lm_running_count,
            "loaded_model": lm_loaded_model_name,
            "ctx_size": lm_ctx_size,
            "last_generation_tokens_per_second": lc_metrics.get("last_generation_tokens_per_second"),
            "last_prompt_tokens": lc_metrics.get("last_prompt_tokens"),
            "last_generation_tokens": lc_metrics.get("last_generation_tokens"),
            "last_activity_ts": lc_metrics.get("last_activity_ts"),
        }

    if not sys_ and lm is None and ollama is None and llamacpp is None:
        return JSONResponse(status_code=200, content=None)
    if not sys_:
        sys_ = {}
    result = _normalize_host_stats(sys_, lm=lm, ollama=ollama)
    if llamacpp is not None:
        result["llamacpp"] = llamacpp

    # Update running models count for /admin/version
    global _last_running_models
    count = 0
    if lm is not None:
        count += len(lm.get("running_models") or []) if isinstance(lm.get("running_models"), list) else (lm.get("running_models") or 0)
    if ollama is not None:
        count += len(ollama.get("loaded_models") or [])
    if llamacpp is not None:
        count += len([i for i in (llamacpp.get("instances") or []) if i.get("ready", False)])
    _last_running_models = count

    # Brain thermal/perf status (enrichissement depuis le brain-daemon unifié)
    if llamacpp_url:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                thermal_r = await client.get(f"{llamacpp_url.rstrip('/')}/thermal/status")
            if thermal_r.status_code == 200:
                td = thermal_r.json()
                result["brain"] = {
                    "thermal_level": td.get("level"),
                    "thermal_running": td.get("running"),
                    "temp_c": td.get("temp_c"),
                    "power_w": td.get("power_w"),
                    "governor": td.get("governor"),
                    "gpu_level": td.get("gpu_level"),
                    "cpu_freq_khz": td.get("cpu_freq_khz"),
                }
        except Exception:
            pass  # Brain thermal data is optional enrichment

    return JSONResponse(content=result)


@router.get("/lm-studio/models")
async def get_lm_studio_models():
    """
    Liste des modèles LM Studio avec loaded_instances (pour affichage et unload par instance_id).
    Retourne { "models": [ { "key", "display_name", "loaded_instances": [ { "id", "config" } ] }, ... ] }.
    """
    base = _lm_studio_base()
    if not base:
        return JSONResponse(content={"models": [], "error": "LM Studio désactivé"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/api/v1/models")
        if r.status_code != 200:
            return JSONResponse(
                status_code=r.status_code,
                content={"models": [], "error": r.text[:500] or str(r.status_code)},
            )
        data = r.json()
        items = data.get("models", data.get("data", []))
        if not isinstance(items, list):
            items = []
        out = []
        for m in items:
            key = m.get("key") or m.get("id") or m.get("name")
            if isinstance(key, dict):
                key = key.get("key") or key.get("id") or ""
            if not key:
                continue
            loaded = m.get("loaded_instances") or []
            if not isinstance(loaded, list):
                loaded = []
            out.append({
                "key": key,
                "display_name": m.get("display_name") or key,
                "loaded_instances": [{"id": x.get("id", ""), "config": x.get("config")} for x in loaded if isinstance(x, dict)],
            })
        return JSONResponse(content={"models": out})
    except Exception as e:
        logger.exception("GET /admin/lm-studio/models: %s", e)
        return JSONResponse(status_code=500, content={"models": [], "error": str(e)})


def _lm_ctx_from_loaded_config(cfg: dict | None) -> int | None:
    if not isinstance(cfg, dict):
        return None
    raw = cfg.get("contextLength") or cfg.get("n_ctx") or cfg.get("context_length")
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


async def _build_lm_studio_session_payload(model_key: str) -> dict[str, Any]:
    """Snapshot : modèle LM Studio + métriques proxy (globales) + ctx depuis loaded_instances."""
    base = _lm_studio_base()
    if not base:
        return {"_error": "LM Studio désactivé", "_http": 400}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/api/v1/models")
        if r.status_code != 200:
            return {
                "_error": r.text[:500] or str(r.status_code),
                "_http": r.status_code,
            }
        data = r.json()
        items = data.get("models", data.get("data", []))
        if not isinstance(items, list):
            items = []
        found: dict | None = None
        resolved_key = model_key
        for m in items:
            if not isinstance(m, dict):
                continue
            key = m.get("key") or m.get("id") or m.get("name")
            if isinstance(key, dict):
                key = key.get("key") or key.get("id") or ""
            if not key:
                continue
            if key == model_key or str(key).lower() == str(model_key).lower():
                found = m
                resolved_key = str(key)
                break
        if found is None:
            return {"_error": f"Modèle inconnu: {model_key}", "_http": 404}
        loaded = found.get("loaded_instances") or []
        if not isinstance(loaded, list):
            loaded = []
        simplified = [{"id": x.get("id", ""), "config": x.get("config")} for x in loaded if isinstance(x, dict)]
        ctx_size: int | None = None
        if simplified and isinstance(simplified[0].get("config"), dict):
            ctx_size = _lm_ctx_from_loaded_config(simplified[0]["config"])
        proxy = get_lm_studio_last_metrics()
        return {
            "model_key": resolved_key,
            "ts": time.time(),
            "display_name": found.get("display_name") or resolved_key,
            "loaded_instances": simplified,
            "context_length": ctx_size,
            "proxy_metrics": proxy,
            "models_http_status": r.status_code,
        }
    except httpx.ConnectError as e:
        return {"_error": str(e), "_http": 503}
    except Exception as e:
        logger.warning("_build_lm_studio_session_payload: %s", e)
        return {"_error": str(e), "_http": 500}


@router.get("/lm-studio/session/{model_key:path}")
async def get_lm_studio_session(model_key: str):
    """État chargé + contexte (config) + métriques proxy pour une clé modèle LM Studio."""
    payload = await _build_lm_studio_session_payload(model_key)
    err = payload.pop("_error", None)
    http = payload.pop("_http", 200)
    if err:
        status = int(http) if isinstance(http, int) else 500
        return JSONResponse(status_code=status, content={"detail": err})
    return JSONResponse(content=payload)


@router.get("/lm-studio/session-stream/{model_key:path}")
async def get_lm_studio_session_stream(model_key: str):
    """SSE : même snapshot que /session ~1/s."""
    base = _lm_studio_base()
    if not base:

        async def err_gen():
            yield f"data: {json.dumps({'error': 'LM Studio désactivé'})}\n\n"

        return StreamingResponse(err_gen(), media_type="text/event-stream")

    async def generate():
        while True:
            payload = await _build_lm_studio_session_payload(model_key)
            err = payload.pop("_error", None)
            http = payload.pop("_http", 200)
            if err:
                out: dict[str, Any] = {
                    "model_key": model_key,
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


@router.post("/lm-studio/load")
async def post_lm_studio_load(body: dict):
    """Charge un modèle LM Studio. Body: { "model": "qwen/qwen3.5-9b" }."""
    base = _lm_studio_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "LM Studio désactivé"})
    model = (body.get("model") or "").strip()
    if not model:
        return JSONResponse(status_code=400, content={"detail": "Champ 'model' requis"})
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(f"{base}/api/v1/models/load", json={"model": model})
        try:
            resp_body = r.json()
        except Exception:
            resp_body = {"error": r.text or str(r.status_code)}
        if r.status_code == 200:
            mark_load_done(base, model)
            # Mettre le modèle chargé en priorité 1 pour que les requêtes l'utilisent
            cache_name = f"lm_studio/{model}"
            current = db_module.get_model_priority() or {}
            lm_list = list(current.get("lm_studio") or [])
            new_lm_list = [cache_name] + [x for x in lm_list if x != cache_name]
            db_module.set_model_priority({**current, "lm_studio": new_lm_list})
            apply_db_overrides()
        return JSONResponse(status_code=r.status_code, content=resp_body)
    except Exception as e:
        logger.exception("POST /admin/lm-studio/load: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e)})


@router.post("/lm-studio/unload")
async def post_lm_studio_unload(body: dict):
    """Décharge une instance LM Studio. Body: { "instance_id": "qwen/qwen3.5-9b" }."""
    base = _lm_studio_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "LM Studio désactivé"})
    instance_id = (body.get("instance_id") or "").strip()
    if not instance_id:
        return JSONResponse(status_code=400, content={"detail": "Champ 'instance_id' requis"})
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(f"{base}/api/v1/models/unload", json={"instance_id": instance_id})
        try:
            resp_body = r.json()
        except Exception:
            resp_body = {"error": r.text or str(r.status_code)}
        if r.status_code == 200:
            invalidate_for_instance(instance_id)
        return JSONResponse(status_code=r.status_code, content=resp_body)
    except Exception as e:
        logger.exception("POST /admin/lm-studio/unload: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e)})


@router.post("/lm-studio/inject-prompt")
async def post_lm_studio_inject_prompt(body: dict):
    """Injecte manuellement le prompt système dans LM Studio (crée une session).
    Body: { "model": "qwen/qwen3.5-9b" }.
    Utilise le body caché (capturé par le proxy) si disponible, sinon fallback simple."""
    base = _lm_studio_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "LM Studio désactivé"})
    model = (body.get("model") or "").strip()
    if not model:
        return JSONResponse(status_code=400, content={"detail": "Champ 'model' requis"})

    config = get_config()
    responses_url = base.rstrip("/")
    if not responses_url.lower().endswith("/v1"):
        responses_url = f"{responses_url}/v1"
    responses_url = f"{responses_url}/responses"
    timeout = float(config.get("backend_timeout", 300))

    # Récupérer le body caché pour ce modèle
    cached = get_cached_body(model)

    if cached:
        # Envoyer le body complet SANS reasoning, avec max_tokens=1
        inject_body = {k: v for k, v in cached.items() if k != "reasoning"}
        inject_body["stream"] = False
        inject_body["max_tokens"] = 1
        inject_body["model"] = model
        logger.info("inject-prompt: envoi body caché (model=%s, keys=%s)", model, list(inject_body.keys()))
    else:
        # Fallback : prompt simple
        fallback_prompt = config.get("lm_studio_session_init_prompt") or "Ready."
        inject_body = {
            "model": model,
            "input": str(fallback_prompt).strip(),
            "stream": False,
            "max_tokens": 1,
        }
        logger.info("inject-prompt: pas de body caché, fallback prompt simple (model=%s)", model)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(responses_url, json=inject_body)
        if r.status_code == 200:
            data = r.json()
            rid = None
            response_text = ""
            if isinstance(data, dict):
                if isinstance(data.get("response"), dict):
                    rid = (data["response"].get("id") or "").strip()
                elif data.get("id"):
                    rid = str(data["id"]).strip()
                # Extraire le texte de réponse du modèle
                output = data.get("output") or (data.get("response") or {}).get("output")
                if isinstance(output, list):
                    for item in output:
                        if isinstance(item, dict) and item.get("type") == "message":
                            for part in (item.get("content") or []):
                                if isinstance(part, dict) and part.get("type") == "output_text":
                                    response_text += part.get("text", "")
                elif isinstance(output, str):
                    response_text = output
                if not response_text:
                    # Fallback : chercher dans choices (format chat)
                    choices = data.get("choices") or []
                    if choices and isinstance(choices[0], dict):
                        msg = choices[0].get("message") or {}
                        response_text = msg.get("content") or ""
            if rid and rid.startswith("resp_"):
                set_injected_response_id(model, rid)
                logger.info("inject-prompt: succès (model=%s, id=%s, response=%s)", model, rid[:40], response_text[:100])
                return JSONResponse(content={
                    "ok": True,
                    "response_id": rid,
                    "response_text": response_text[:2000],
                    "used_cached_body": cached is not None,
                })
            logger.warning("inject-prompt: réponse 200 mais pas de response_id valide (model=%s)", model)
            return JSONResponse(
                status_code=200,
                content={"ok": False, "detail": "Réponse 200 mais pas de response_id valide", "response_text": response_text[:2000]},
            )
        logger.warning("inject-prompt: LM Studio a répondu %s (model=%s)", r.status_code, model)
        return JSONResponse(
            status_code=r.status_code,
            content={"ok": False, "detail": r.text[:500]},
        )
    except Exception as e:
        logger.exception("POST /admin/lm-studio/inject-prompt: %s", e)
        return JSONResponse(status_code=500, content={"ok": False, "detail": str(e)})
