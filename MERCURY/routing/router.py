"""
Décision Ollama vs MLX vs LM Studio selon le champ model.
Priorité : cache résolu (mémoire) → model_mapping (config) → cache par nom → matching normalisé → model_routes (regex).
Premier modèle d'un backend : ollama/ollama, lm_studio/lm_studio (ou lmstudio/lmstudio), llamacpp/llamacpp, mlx/mlx.
"""
import logging
import re
import time
from pathlib import Path
from typing import Dict, Optional, Tuple

logger = logging.getLogger("mercury")

# Backends cloud (pas de sérialisation nécessaire — peuvent s'exécuter en parallèle)
CLOUD_BACKENDS = frozenset({"openrouter", "anthropic"})

# Config chargée au démarrage (voir main.py / load_config)
_config: dict = {}

# Cache des résolutions avec TTL et taille max
_RESOLVED_CACHE_MAX = 500
_RESOLVED_CACHE_TTL = 300.0  # 5 minutes
_resolved_cache: Dict[str, Tuple[str, str, float]] = {}  # model -> (backend, backend_model_id, timestamp)

_ROOT = Path(__file__).resolve().parent.parent


def _cache_get(model: str) -> Optional[Tuple[str, str]]:
    """Lookup dans le cache résolu avec vérification TTL."""
    entry = _resolved_cache.get(model)
    if entry is None:
        return None
    backend, backend_model_id, ts = entry
    if (time.monotonic() - ts) > _RESOLVED_CACHE_TTL:
        _resolved_cache.pop(model, None)
        return None
    return (backend, backend_model_id)


def _cache_put(model: str, result: Tuple[str, str]) -> None:
    """Stocke dans le cache résolu avec éviction LRU si taille max atteinte."""
    if len(_resolved_cache) >= _RESOLVED_CACHE_MAX:
        oldest_key = min(_resolved_cache, key=lambda k: _resolved_cache[k][2])
        _resolved_cache.pop(oldest_key, None)
    _resolved_cache[model] = (result[0], result[1], time.monotonic())


def _apply_db_overrides() -> None:
    """Applique les options et données stockées en DB par-dessus la config (priorité DB)."""
    global _resolved_cache
    try:
        from data import db as db_module
        # Migration : si la DB n'a jamais eu ces clés, copier depuis la config (une seule fois)
        if db_module.get_users() is None and (_config.get("users") or []):
            db_module.set_users(_config.get("users") or [])
        if db_module.get_model_mapping() is None and _config.get("model_mapping") is not None:
            db_module.set_model_mapping(_config.get("model_mapping") or {})
        if db_module.get_model_routes() is None and (_config.get("model_routes") or []):
            db_module.set_model_routes(_config.get("model_routes") or [])
        for key, value in db_module.get_settings().items():
            if value is not None:
                _config[key] = value
        # Migration : fallback_providers_order peut avoir été stocké comme str (bug _normalize)
        import json as _json
        _LIST_SETTINGS = ("fallback_providers_order",)
        for _k in _LIST_SETTINGS:
            _v = _config.get(_k)
            if isinstance(_v, str) and _v.strip().startswith("["):
                try:
                    _parsed = _json.loads(_v.replace("'", '"'))
                    if isinstance(_parsed, list):
                        _config[_k] = _parsed
                        db_module.set_setting(_k, _parsed)  # corrige en DB aussi
                except Exception:
                    pass
        users = db_module.get_users()
        if users is not None:
            _config["users"] = users
        mapping = db_module.get_model_mapping()
        if mapping is not None:
            _config["model_mapping"] = mapping
        routes = db_module.get_model_routes()
        if routes is not None:
            _config["model_routes"] = routes
        prio = db_module.get_provider_priority()
        if prio is not None:
            _config["provider_priority"] = prio
        model_prio = db_module.get_model_priority()
        if model_prio is not None:
            _config["model_priority"] = model_prio
        hidden = db_module.get_hidden_models()
        _config["hidden_models"] = list(hidden) if hidden else []
        # Invalider le cache des résolutions (mapping/routes peuvent avoir changé)
        _resolved_cache.clear()
    except Exception as e:
        logger.warning("Erreur lors de l'application des overrides DB: %s", e)


def apply_db_overrides() -> None:
    """Réapplique les overrides DB sur _config (après écriture en DB depuis l'admin).
    Flushe aussi le cache des modèles dynamiques (lazily refilled), pour que les changements
    (load/unload, hidden, priorités, toggles backend) soient visibles immédiatement."""
    _apply_db_overrides()
    try:
        from routing.models_cache import flush_cache as _flush_models_cache
        _flush_models_cache()
    except Exception as e:
        logger.warning("apply_db_overrides: flush models_cache failed: %s", e)


def clear_resolved_cache() -> None:
    """Vide le cache de résolution model→backend (public accessor, à utiliser depuis admin/)."""
    _resolved_cache.clear()


def load_config(config_path: Optional[Path] = None) -> dict:
    global _config
    if config_path is None:
        config_path = _ROOT / "config.yaml"
    try:
        import yaml
        with open(config_path) as f:
            _config = yaml.safe_load(f) or {}
        _config.setdefault("debug", False)
        _config.setdefault("debug_full_json", False)
        _config.setdefault("admin_accept_user_api_key", True)
        _config.setdefault("openrouter_enabled", False)
        _config.setdefault("openrouter_fallback_force", False)
        _config.setdefault("openrouter_fallback_model", "")
        _config.setdefault("openrouter_vision_model", "")
        _config.setdefault("openrouter_reasoning_model", "")
        _config.setdefault("openrouter_embedding_model", "")
        _config.setdefault("openrouter_embedding_dim", None)
        _config.setdefault("openrouter_embedding_priority", 99)
        _config.setdefault("openrouter_api_key", "")
        _config.setdefault("local_embedding_models", [])
        _config.setdefault("embedding_fallback_triggers", {
            "retryable_status": [408, 429, 500, 502, 503, 504],
            "timeout_ms": 15000,
            "model_unavailable": True,
        })
        _config.setdefault("anthropic_enabled", False)
        _config.setdefault("anthropic_credentials_file", "")
        _config.setdefault("anthropic_fallback_model", "")
        _config.setdefault("anthropic_reasoning_model", "")
        _config.setdefault("fallback_providers_order", ["openrouter", "anthropic"])
        _config.setdefault("lm_studio_proxy_only", False)
        _config.setdefault("ollama_proxy_only", False)
        _config.setdefault("ollama_auto_pull", True)
        # Probes Mercury (lm_studio_probe_url, ollama_probe_url) retirées :
        # stats machine désormais exposées par brain-daemon.
        _config.setdefault("auto_priority_enabled", True)
        _config.setdefault("cloud_bypass_queue", True)
        _config.setdefault("model_routes", [])
        if "credits" not in _config:
            _config["credits"] = {"enabled": False, "timeout_ms": 30000}
        else:
            c = _config["credits"]
            if not isinstance(c, dict):
                _config["credits"] = {"enabled": False, "timeout_ms": 30000}
            else:
                c.setdefault("enabled", False)
                c.setdefault("timeout_ms", 30000)
    except Exception as exc:
        import logging
        logging.getLogger("mercury").exception("Erreur de chargement config (%s) — fallback par défaut", exc)
        _config = {
            "server_host": "0.0.0.0",
            "server_port": 17890,
            "queue_max_size": 100,
            "admin_token": "",
            "require_api_key": False,
            "debug": False,
            "debug_full_json": False,
            "admin_accept_user_api_key": True,
            "backend_timeout": 300,
            "ollama_url": "http://localhost:11434",
            "mlx_url": "http://localhost:8080",
            "lm_studio_url": "http://localhost:1234",
            "ollama_enabled": True,
            "mlx_enabled": True,
            "lm_studio_enabled": True,
            "lm_studio_proxy_only": False,
            "models_cache_ttl_seconds": 60,
            "model_mapping": {},
            "model_routes": [],
            "credits": {
                "enabled": False,
                "timeout_ms": 30000,
                "openrouter_key": "",
                "openai_key": "",
                "anthropic_key": "",
            },
            "openrouter_enabled": False,
            "openrouter_fallback_force": False,
            "openrouter_fallback_model": "",
            "openrouter_vision_model": "",
            "openrouter_embedding_model": "",
            "openrouter_embedding_dim": None,
            "openrouter_embedding_priority": 99,
            "openrouter_api_key": "",
            "local_embedding_models": [],
            "embedding_fallback_triggers": {
                "retryable_status": [408, 429, 500, 502, 503, 504],
                "timeout_ms": 15000,
                "model_unavailable": True,
            },
            "anthropic_enabled": False,
            "anthropic_credentials_file": "",
            "anthropic_fallback_model": "",
            "anthropic_reasoning_model": "",
            "fallback_providers_order": ["openrouter", "anthropic"],
            # Probes Mercury retirées (cf. note plus haut).
            "auto_priority_enabled": True,
        }
    _apply_db_overrides()
    return _config


def get_config() -> dict:
    return _config


def set_debug(enabled: bool) -> None:
    """Active/désactive le mode debug (logs des JSON reçus/envoyés). Pris en compte immédiatement, persisté en DB."""
    global _config
    _config["debug"] = bool(enabled)
    try:
        from data import db as db_module
        db_module.set_setting("debug", enabled)
    except Exception:
        pass


def _backend_enabled(backend: str) -> bool:
    if backend == "ollama":
        return _config.get("ollama_enabled", True)
    if backend == "mlx":
        return _config.get("mlx_enabled", True)
    if backend == "lm_studio":
        return _config.get("lm_studio_enabled", True)
    if backend == "llamacpp":
        return _config.get("llamacpp_enabled", True)
    if backend == "vllm":
        return _config.get("vllm_enabled", False)
    if backend == "lucebox":
        return _config.get("lucebox_enabled", False)
    if backend == "openrouter":
        if not _config.get("openrouter_enabled", False):
            return False
        return bool((_config.get("openrouter_api_key") or "").strip())
    if backend == "anthropic":
        if not _config.get("anthropic_enabled", False):
            return False
        import json as _json
        from pathlib import Path as _Path
        cred_file = _config.get("anthropic_credentials_file") or str(_Path.home() / ".claude" / ".credentials.json")
        try:
            data = _json.loads(_Path(cred_file).read_text(encoding="utf-8"))
            return bool((data.get("claudeAiOauth") or {}).get("accessToken", ""))
        except Exception:
            return False
    return False


def _backend_model_id_from_pattern(backend: str, model: str) -> str:
    """Délègue à backend_ids pour une seule source de vérité sur les préfixes."""
    from routing.backend_ids import backend_model_id_from_request
    return backend_model_id_from_request(backend, model)


def _resolve_backend_auto(backend: str, prefer_loaded: bool = False) -> Optional[Tuple[str, str]]:
    """
    Retourne (backend, backend_model_id) pour le premier modèle chat disponible de ce backend,
    ou None si désactivé / aucun modèle. prefer_loaded=True pour llamacpp (modèle déjà chargé).
    """
    if not _backend_enabled(backend):
        return None
    try:
        from routing.models_cache import (
            get_first_available_chat_model_for_backend,
            get_cached_backend_model,
        )
        model_priority = _config.get("model_priority") or None
        hidden_models = _config.get("hidden_models") or None
        first_name = get_first_available_chat_model_for_backend(
            backend,
            model_priority=model_priority,
            hidden_models=hidden_models,
            prefer_loaded=prefer_loaded,
        )
        if first_name:
            return get_cached_backend_model(first_name)
    except Exception as e:
        logger.debug("_resolve_backend_auto %s: %s", backend, e)
    return None


def _resolve_auto_global() -> Optional[Tuple[str, str]]:
    """Premier modèle chat selon priorité globale (provider_priority, model_priority, auto_priority_enabled)."""
    try:
        from routing.models_cache import get_available_chat_model_names
        priority_order = _config.get("provider_priority") or None
        model_priority = _config.get("model_priority") or None
        hidden_models = _config.get("hidden_models") or None
        auto_priority_enabled = bool(_config.get("auto_priority_enabled", True))
        prefer_loaded_first = not auto_priority_enabled
        names = get_available_chat_model_names(
            priority_order=priority_order,
            model_priority=model_priority,
            hidden_models=hidden_models,
            prefer_loaded=prefer_loaded_first,
        )
        if not names:
            return None
        from routing.models_cache import get_cached_backend_model
        cached = get_cached_backend_model(names[0])
        if cached:
            logger.info("auto/auto → modèle choisi: %s (auto_priority_enabled=%s)", names[0], auto_priority_enabled)
            return cached
    except Exception as e:
        logger.debug("_resolve_auto_global: %s", e)
    return None


def _resolve_from_mapping(model: str) -> Optional[Tuple[str, str]]:
    """Résolution via model_mapping (config/DB)."""
    mapping = _config.get("model_mapping") or {}
    if not isinstance(mapping, dict) or model not in mapping:
        return None
    entry = mapping[model]
    if not isinstance(entry, dict):
        return None
    backend = (entry.get("backend") or "").strip()
    backend_id = (entry.get("backend_model_id") or model).strip() or model
    if backend and _backend_enabled(backend):
        return (backend, backend_id)
    return None


def _resolve_from_cache(model: str) -> Optional[Tuple[str, str]]:
    """Résolution via models_cache (nom exact puis clé normalisée)."""
    try:
        from routing.models_cache import (
            get_cached_backend_model,
            normalize_model_id,
            get_cached_backend_model_by_normalized,
        )
        cached = get_cached_backend_model(model)
        if cached is not None:
            return cached
        norm = normalize_model_id(model)
        if norm:
            cached = get_cached_backend_model_by_normalized(norm)
            if cached is not None:
                return cached
    except Exception as e:
        logger.debug("_resolve_from_cache: %s", e)
    return None


def _resolve_from_routes(model: str) -> Optional[Tuple[str, str]]:
    """Résolution via model_routes (regex). Gère backend/backend → premier modèle du backend."""
    routes = _config.get("model_routes", [])
    for rule in routes:
        pattern = rule.get("pattern", "")
        backend = rule.get("backend", "")
        if not backend or not _backend_enabled(backend):
            continue
        try:
            if not re.match(pattern, model):
                continue
            backend_model_id = _backend_model_id_from_pattern(backend, model)
            # backend/backend (ex. ollama/ollama) → premier modèle de ce backend
            if backend_model_id == backend and backend in ("ollama", "lm_studio", "mlx", "llamacpp", "vllm", "lucebox"):
                result = _resolve_backend_auto(backend, prefer_loaded=(backend in ("llamacpp", "vllm", "lucebox")))
                if result:
                    return result
                raise ValueError(
                    f"Aucun modèle disponible pour {backend}/{backend}. "
                    "Rafraîchissez le cache des modèles (admin) ou utilisez un modèle explicite."
                )
            return (backend, backend_model_id)
        except ValueError:
            raise
        except re.error:
            # rstrip(".*") est un strip par jeu de caractères — il tronque TOUS les '.'
            # et '*' en fin de chaîne, pas le suffixe littéral ".*". On utilise endswith
            # pour tester le suffixe exact et on extrait la base proprement.
            base = pattern[:-2] if pattern.endswith(".*") else pattern
            if base and model.startswith(base):
                return (backend, _backend_model_id_from_pattern(backend, model))
    return None


def _resolve_fallback_backends(model: str) -> Optional[Tuple[str, str]]:
    """Dernier recours : routage par préfixe uniquement (ollama/, mlx/, lm_studio/, llamacpp/, vllm/). Pas de catch-all."""
    from routing.backend_ids import backend_and_model_id_by_prefix
    res = backend_and_model_id_by_prefix(model)
    if res is not None and _backend_enabled(res[0]):
        return res
    return None


def resolve_model(model: str) -> Tuple[str, str]:
    """
    Retourne (backend, backend_model_id) pour le modèle donné.
    Ordre : backend/backend (ollama/ollama, etc.) → openrouter_force → cache → mapping → cache dynamique → routes → fallback backends → openrouter.
    """
    model = (model or "").strip()
    if not model:
        raise ValueError("Modèle vide")

    m_lower = model.lower()
    # Normaliser nom nu du backend en backend/backend (évite que "llamacpp" soit envoyé à ollama via la règle ".*")
    if m_lower in ("llamacpp", "vllm", "lucebox", "ollama", "mlx", "lm_studio", "lmstudio"):
        if m_lower == "llamacpp":
            m_lower = "llamacpp/llamacpp"
        elif m_lower == "vllm":
            m_lower = "vllm/vllm"
        elif m_lower == "lucebox":
            m_lower = "lucebox/lucebox"
        elif m_lower == "ollama":
            m_lower = "ollama/ollama"
        elif m_lower == "mlx":
            m_lower = "mlx/mlx"
        else:
            m_lower = "lm_studio/lm_studio"
        model = m_lower

    # 1. Premier modèle par backend : ollama/ollama, lm_studio/lm_studio, lmstudio/lmstudio, llamacpp/llamacpp, vllm/vllm, mlx/mlx
    if m_lower in ("llamacpp/llamacpp",):
        result = _resolve_backend_auto("llamacpp", prefer_loaded=True)
        if result:
            logger.info("llamacpp/llamacpp → modèle choisi: %s", result[1])
            return result
        raise ValueError(
            "Aucun modèle llamacpp disponible pour llamacpp/llamacpp. "
            "Chargez un modèle via l'interface admin ou rafraîchissez le cache."
        )
    if m_lower in ("vllm/vllm",):
        result = _resolve_backend_auto("vllm", prefer_loaded=True)
        if result:
            logger.info("vllm/vllm → modèle choisi: %s", result[1])
            return result
        raise ValueError(
            "Aucun modèle vllm disponible pour vllm/vllm. "
            "Chargez un modèle via l'interface admin ou rafraîchissez le cache."
        )
    if m_lower in ("lucebox/lucebox",):
        result = _resolve_backend_auto("lucebox", prefer_loaded=True)
        if result:
            logger.info("lucebox/lucebox → modèle choisi: %s", result[1])
            return result
        raise ValueError(
            "Aucun modèle lucebox disponible pour lucebox/lucebox. "
            "Chargez un modèle via l'interface admin ou rafraîchissez le cache."
        )
    if m_lower in ("lm_studio/lm_studio", "lmstudio/lmstudio"):
        result = _resolve_backend_auto("lm_studio")
        if result:
            logger.info("lm_studio → modèle choisi: %s", result[0] + "/" + result[1])
            return result
        raise ValueError(
            "Aucun modèle LM Studio disponible. Rafraîchissez le cache des modèles (admin)."
        )
    if m_lower in ("ollama/ollama",):
        result = _resolve_backend_auto("ollama")
        if result:
            logger.info("ollama/ollama → modèle choisi: %s", result[0] + "/" + result[1])
            return result
        raise ValueError(
            "Aucun modèle Ollama disponible pour ollama/ollama. Rafraîchissez le cache des modèles (admin)."
        )
    if m_lower in ("mlx/mlx",):
        result = _resolve_backend_auto("mlx")
        if result:
            logger.info("mlx/mlx → modèle choisi: %s", result[0] + "/" + result[1])
            return result
        raise ValueError(
            "Aucun modèle MLX disponible pour mlx/mlx. Rafraîchissez le cache des modèles (admin)."
        )

    # 2. "auto" / "auto/auto" supprimés : utiliser ollama/ollama, lm_studio/lm_studio, etc.
    if m_lower in ("auto", "auto/auto"):
        raise ValueError(
            "Utilisez un tag explicite : ollama/ollama, lm_studio/lm_studio (ou lmstudio/lmstudio), "
            "llamacpp/llamacpp, vllm/vllm ou mlx/mlx selon le provider souhaité."
        )

    # 3. Forcer OpenRouter
    if _config.get("openrouter_fallback_force", False) and _backend_enabled("openrouter"):
        fallback_model = (_config.get("openrouter_fallback_model") or "").strip()
        if fallback_model:
            result = ("openrouter", fallback_model)
            _cache_put(model, result)
            return result

    # 4. Cache en mémoire (avec TTL)
    cached = _cache_get(model)
    if cached is not None:
        return cached

    # 5. model_mapping
    result = _resolve_from_mapping(model)
    if result is not None:
        _cache_put(model, result)
        return result

    # 6. Cache dynamique (exact + normalisé)
    result = _resolve_from_cache(model)
    if result is not None:
        _cache_put(model, result)
        return result

    # 7. model_routes (regex)
    try:
        result = _resolve_from_routes(model)
        if result is not None:
            _cache_put(model, result)
            return result
    except ValueError:
        raise

    # 8. Fallback par backend
    result = _resolve_fallback_backends(model)
    if result is not None:
        _cache_put(model, result)
        return result

    # 9. Dernier recours : chaîne cloud ordonnée (fallback_providers_order)
    fallback = get_ordered_cloud_fallback()
    if fallback is not None:
        _cache_put(model, fallback)
        return fallback

    raise ValueError(
        "Aucun backend activé (ollama / mlx / lm_studio / llamacpp / vllm / openrouter / anthropic). "
        "Pour OpenRouter : openrouter_enabled, openrouter_api_key et openrouter_fallback_model. "
        "Pour Anthropic : anthropic_enabled, anthropic_fallback_model et credentials OAuth dans ~/.claude/.credentials.json."
    )


def get_resolved_mapping() -> Dict[str, Tuple[str, str]]:
    """Retourne une copie du cache des résolutions (nom canonique -> (backend, backend_model_id)). Pour l'admin."""
    return {k: (v[0], v[1]) for k, v in _resolved_cache.items()}


def get_openrouter_fallback() -> Optional[Tuple[str, str]]:
    """
    Retourne ("openrouter", openrouter_fallback_model) si le fallback OpenRouter est configuré et utilisable,
    sinon None. Utilisé pour basculer automatiquement quand le backend résolu (ollama/mlx/lm_studio) est down.
    """
    if not _backend_enabled("openrouter"):
        return None
    fallback_model = (_config.get("openrouter_fallback_model") or "").strip()
    if not fallback_model:
        return None
    return ("openrouter", fallback_model)


def get_anthropic_fallback() -> Optional[Tuple[str, str]]:
    """
    Retourne ("anthropic", anthropic_fallback_model) si le fallback Anthropic OAuth est configuré et utilisable,
    sinon None. Utilisé comme second recours après OpenRouter.
    """
    if not _backend_enabled("anthropic"):
        return None
    fallback_model = (_config.get("anthropic_fallback_model") or "").strip()
    if not fallback_model:
        return None
    return ("anthropic", fallback_model)


def get_ordered_cloud_fallback() -> Optional[Tuple[str, str]]:
    """
    Retourne le premier fallback cloud disponible selon fallback_providers_order.
    Ordre par défaut : ["openrouter", "anthropic"]. Configurable depuis le dashboard.
    """
    order = _config.get("fallback_providers_order") or ["openrouter", "anthropic"]
    for provider in order:
        if provider == "openrouter":
            fb = get_openrouter_fallback()
        elif provider == "anthropic":
            fb = get_anthropic_fallback()
        else:
            continue
        if fb is not None:
            return fb
    return None


async def resolve_and_prepare(
    body: dict,
    excluded_backends: Optional[set] = None,
) -> Tuple[str, str, dict, str]:
    """
    Résolution du modèle + fallback si backend down. Utilisé par le worker et par POST /api/chat.
    Rafraîchit le cache des modèles si périmé, puis resolve_model, puis applique le fallback OpenRouter
    si le backend résolu est down.

    `excluded_backends` : set de noms de backends que l'endpoint appelant ne sait pas
    handler. Si la résolution tombe sur l'un d'eux, on lève ValueError au lieu de
    renvoyer un backend que le caller refusera plus loin (F5 rapport fonctionnel :
    /api/chat n'a pas de handler pour llamacpp/vllm/lucebox → la résolution doit le dire,
    pas générer une réponse 400 confuse après register).

    Retourne (backend_name, backend_model_id, body_for_backend, canonical_model).
    Lève ValueError si modèle vide, aucun backend, ou backend exclu sans fallback cloud.
    """
    from core.backends_health import is_backend_up

    config = get_config()
    model = (body.get("model") or "").strip()
    if not model:
        raise ValueError("Modèle vide")

    ttl = float(config.get("models_cache_ttl_seconds", 60))
    if ttl > 0:
        try:
            from routing.models_cache import is_stale, refresh_in_background
            if is_stale(ttl):
                await refresh_in_background(config)
        except Exception as e:
            logger.debug("resolve_and_prepare refresh cache: %s", e)

    backend_name, backend_model_id = resolve_model(model)

    # Chaîne de fallback cloud : ordre défini par fallback_providers_order
    if backend_name not in ("openrouter", "anthropic"):
        if not await is_backend_up(backend_name, config):
            fallback = get_ordered_cloud_fallback()
            if fallback is not None:
                logger.info(
                    "resolve_and_prepare: backend %s down, bascule sur %s fallback",
                    backend_name, fallback[0],
                )
                backend_name, backend_model_id = fallback

    # F5 : si le caller a déclaré certains backends non-supportés, on essaye
    # d'abord la cloud fallback chain ; si rien ne marche, on raise pour que
    # le caller renvoie un 503 explicite plutôt que de découvrir le mismatch plus tard.
    if excluded_backends and backend_name in excluded_backends:
        fallback = get_ordered_cloud_fallback()
        if fallback is not None and fallback[0] not in excluded_backends:
            logger.info(
                "resolve_and_prepare: backend %s exclu par caller, bascule cloud %s",
                backend_name, fallback[0],
            )
            backend_name, backend_model_id = fallback
        else:
            raise ValueError(
                f"Modèle '{model}' route vers backend '{backend_name}' qui n'est pas supporté "
                f"sur cet endpoint. Utilisez /v1/chat/completions pour ce modèle."
            )

    body_for_backend = {**body, "model": backend_model_id}
    return (backend_name, backend_model_id, body_for_backend, model)


