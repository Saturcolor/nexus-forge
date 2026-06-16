"""Routes admin : model-mapping, cache, cache/models, cache/refresh, model-priority."""
import logging
import threading

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from routing.router import get_config, get_resolved_mapping, apply_db_overrides
from routing.models_cache import (
    get_cached_models_with_normalized,
    get_cache_state,
    get_cached_models_for_admin,
    refresh as refresh_models_cache,
)
logger = logging.getLogger(__name__)
router = APIRouter()

# Ces handlers PATCH/PUT sont déclarés `def` (sync) → Starlette les exécute dans
# le threadpool anyio = VRAIMENT concurrents entre workers. Chacun fait un
# read-modify-write sur une collection partagée de data.db (get → mute → set).
# Le `_lock` de data.db ne sérialise QUE chaque getter/setter pris isolément :
# entre le get et le set le lock est relâché, donc deux PATCH simultanés lisent
# le même snapshot et le 2e écrasement écrase le 1er (lost update — cf. audit P3).
# On sérialise donc la séquence complète read→modify→set (+ apply_db_overrides
# qui publie le changement) avec un lock dédié PAR collection, pour ne pas
# sérialiser inutilement des écritures sur des collections différentes.
# NB: ces locks ne couvrent que les RMW de CE fichier ; d'autres routes
# (lm_studio.py / llamacpp/lifecycle.py pour model_priority, config.py pour
# hidden_models) font leur propre RMW hors de ces locks → race résiduelle
# cross-fichier non couverte ici (fix complet = helpers atomiques dans data.db).
_hidden_models_lock = threading.Lock()
_protected_models_lock = threading.Lock()
_model_priority_lock = threading.Lock()


@router.get("/model-mapping")
def get_model_mapping():
    """
    Tableau de mapping des modèles pour le frontend :
    - from_config : entrées explicites de config.yaml (model_mapping)
    - from_cache : résolutions en mémoire (nom canonique -> backend + id)
    - backend_models : modèles connus des backends avec clé normalisée (pour le matching).
    """
    try:
        config = get_config()
        mapping = config.get("model_mapping") or {}
        if not isinstance(mapping, dict):
            mapping = {}
        from_config = []
        for canonical, entry in mapping.items():
            if isinstance(entry, dict):
                from_config.append({
                    "canonical": canonical,
                    "backend": (entry.get("backend") or "").strip(),
                    "backend_model_id": (entry.get("backend_model_id") or canonical).strip(),
                })
        resolved = get_resolved_mapping()
        from_cache = [
            {"canonical": k, "backend": b, "backend_model_id": bid}
            for k, (b, bid) in resolved.items()
        ]
        backend_models = get_cached_models_with_normalized()
        return JSONResponse(content={
            "from_config": from_config,
            "from_cache": from_cache,
            "backend_models": backend_models,
        })
    except Exception as e:
        logger.exception("GET /admin/model-mapping: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.get("/cache")
def get_cache():
    """État du cache des modèles (count, updated_at) pour le frontend."""
    try:
        return JSONResponse(content=get_cache_state())
    except Exception as e:
        logger.exception("GET /admin/cache: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.get("/cache/models")
def get_cache_models():
    """Liste des modèles en cache (sans rafraîchir). Chaque modèle a priority (1..N au sein de son backend)."""
    try:
        models = get_cached_models_for_admin()
        # Lectures DB indépendantes : chaque champ dégrade vers son défaut SANS
        # impacter les autres. (Avant : un seul try partagé → une AttributeError
        # sur n'importe quel getter vidait catégories/hidden/priorités d'un coup,
        # cassant tout le dashboard — cf. incident 2026-05-31.) getattr couvre
        # aussi le cas "fonction absente" (déploiement partiel de data.db).
        from data import db as db_module

        def _safe(attr, default):
            fn = getattr(db_module, attr, None)
            if not callable(fn):
                logger.warning("GET /admin/cache/models: data.db.%s indisponible — défaut appliqué", attr)
                return default
            try:
                return fn()
            except Exception as e:
                logger.warning("GET /admin/cache/models: data.db.%s a échoué (%s) — défaut appliqué", attr, e)
                return default

        order_by_backend = _safe("get_model_priority", None)
        hidden_model_names = list(_safe("get_hidden_models", []) or [])
        protected_model_names = list(_safe("get_unload_protected_models", set()) or [])
        model_categories = _safe("get_model_categories", {}) or {}
        category_order = _safe("get_model_category_order", []) or []
        ollama_template_configured = _safe("get_ollama_template_configured_by_model", {}) or {}
        for m in models:
            backend = m.get("backend", "")
            name = m.get("name", "")
            order_b = (order_by_backend or {}).get(backend) if isinstance(order_by_backend, dict) else []
            if order_b and name in order_b:
                m["priority"] = order_b.index(name) + 1
            else:
                m["priority"] = len(order_b) + 1 if order_b else 1
            m["category"] = model_categories.get(name, "")
            m["template_configured"] = bool(ollama_template_configured.get(name, False)) if backend == "ollama" else False
        return JSONResponse(content={"models": models, "hidden_model_names": hidden_model_names, "protected_model_names": protected_model_names, "category_order": category_order})
    except Exception as e:
        logger.exception("GET /admin/cache/models: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.put("/model-priority")
def set_model_priority(body: dict):
    """Met à jour l'ordre de priorité des modèles par backend. Body: {"order_by_backend": {"ollama": ["ollama/m1", ...], ...}}.
    Seuls les modèles visibles sont envoyés ; les modèles masqués sont réinjectés en fin de liste par backend."""
    try:
        order_by_backend = body.get("order_by_backend")
        if not isinstance(order_by_backend, dict):
            return JSONResponse(
                status_code=400,
                content={"detail": "order_by_backend doit être un objet {backend: [noms de modèles]}"},
            )
        from data import db as db_module
        # RMW sérialisé : lecture (priority + hidden) → fusion → écriture, sous un
        # seul lock pour éviter le lost update entre PATCH concurrents (cf. en-tête).
        with _model_priority_lock:
            hidden_set = db_module.get_hidden_models() or set()
            current = db_module.get_model_priority() or {}
            cleaned = {}
            for k, v in order_by_backend.items():
                if not isinstance(v, (list, tuple)):
                    continue
                visible = [str(x).strip() for x in v if x]
                hidden_for_backend = [m for m in (current.get(k) or []) if m in hidden_set]
                cleaned[str(k)] = visible + hidden_for_backend
            db_module.set_model_priority(cleaned)
            apply_db_overrides()
        return JSONResponse(content={"ok": True})
    except Exception as e:
        logger.exception("PUT /admin/model-priority: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.patch("/hidden-models")
def patch_hidden_models(body: dict):
    """Masque ou affiche un modèle. Body: {"model_name": "ollama/llama3", "hidden": true|false}."""
    try:
        model_name = (body.get("model_name") or "").strip()
        hidden = body.get("hidden")
        if not model_name:
            return JSONResponse(status_code=400, content={"detail": "model_name requis"})
        if not isinstance(hidden, bool):
            return JSONResponse(status_code=400, content={"detail": "hidden doit être true ou false"})
        from data import db as db_module
        # RMW sérialisé : get → add/discard → set → publish, sous un seul lock
        # pour éviter le lost update entre PATCH concurrents (cf. en-tête).
        with _hidden_models_lock:
            current = set(db_module.get_hidden_models() or [])
            if hidden:
                current.add(model_name)
            else:
                current.discard(model_name)
            db_module.set_hidden_models(list(current))
            apply_db_overrides()
        return JSONResponse(content={"ok": True, "hidden_model_names": list(current)})
    except Exception as e:
        logger.exception("PATCH /admin/hidden-models: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.patch("/unload-protected-models")
def patch_unload_protected_models(body: dict):
    """Épingle/désépingle un modèle contre l'unload_all du scheduler.
    Body: {"model_name": "llamacpp/.../Qwen3-Embedding-8B-Q8_0", "protected": true|false}."""
    try:
        model_name = (body.get("model_name") or "").strip()
        protected = body.get("protected")
        if not model_name:
            return JSONResponse(status_code=400, content={"detail": "model_name requis"})
        if not isinstance(protected, bool):
            return JSONResponse(status_code=400, content={"detail": "protected doit être true ou false"})
        from data import db as db_module
        # RMW sérialisé : get → add/discard → set, sous un seul lock pour éviter
        # le lost update entre PATCH concurrents (cf. en-tête).
        with _protected_models_lock:
            current = set(db_module.get_unload_protected_models() or [])
            if protected:
                current.add(model_name)
            else:
                current.discard(model_name)
            db_module.set_unload_protected_models(list(current))
        return JSONResponse(content={"ok": True, "protected_model_names": list(current)})
    except Exception as e:
        logger.exception("PATCH /admin/unload-protected-models: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.patch("/model-categories")
def patch_model_categories(body: dict):
    """
    Assigne (ou retire) une catégorie/tag à un modèle.
    Body: {"model_name": "ollama/llama3:8b", "category": "tag"}.
    category vide/null => suppression.
    """
    try:
        model_name = (body.get("model_name") or "").strip()
        if not model_name:
            return JSONResponse(status_code=400, content={"detail": "model_name requis"})

        category = body.get("category", None)
        # Autorise explicitement null/"" pour retirer.
        if category is not None and not isinstance(category, str):
            category = str(category)

        from data import db as db_module
        db_module.set_model_category(model_name=model_name, category=category)
        # La lecture de l'ordre est secondaire : un échec ici ne doit PAS faire
        # croire au client que le write (déjà persisté) a échoué.
        try:
            category_order = db_module.get_model_category_order() or []
        except Exception as e:
            logger.warning("PATCH /admin/model-categories: get_model_category_order a échoué après write (%s)", e)
            category_order = []
        return JSONResponse(content={"ok": True, "category_order": category_order})
    except Exception as e:
        logger.exception("PATCH /admin/model-categories: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.post("/cache/refresh")
async def post_cache_refresh():
    """Rafraîchit le cache des modèles (backends activés, dont éventuellement OpenRouter).
    `GET /api/tags` utilisera ce cache jusqu'à TTL."""
    try:
        config = get_config()
        models = await refresh_models_cache(config)
        return JSONResponse(content={"ok": True, "count": len(models)})
    except Exception as e:
        logger.exception("POST /admin/cache/refresh: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.post("/cache/flush")
async def post_cache_flush():
    """Vide entièrement le cache des modèles + le cache de résolution, puis rafraîchit depuis zéro."""
    try:
        from routing.models_cache import flush_cache
        from routing.router import clear_resolved_cache
        flush_cache()
        clear_resolved_cache()
        config = get_config()
        models = await refresh_models_cache(config)
        return JSONResponse(content={"ok": True, "count": len(models)})
    except Exception as e:
        logger.exception("POST /admin/cache/flush: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})
