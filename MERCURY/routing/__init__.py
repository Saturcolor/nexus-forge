"""Routage modèle → backend (router, models_cache)."""
from .router import (
    load_config,
    get_config,
    set_debug,
    apply_db_overrides,
    resolve_model,
    resolve_and_prepare,
    get_resolved_mapping,
)
from .models_cache import (
    get_cached_models,
    get_cached_backend_model,
    get_cached_backend_model_by_normalized,
    normalize_model_id,
    is_stale,
    refresh,
    get_cache_state,
    get_cached_models_for_admin,
    get_cached_models_with_normalized,
)

__all__ = [
    "load_config",
    "get_config",
    "set_debug",
    "apply_db_overrides",
    "resolve_model",
    "resolve_and_prepare",
    "get_resolved_mapping",
    "get_cached_models",
    "get_cached_backend_model",
    "get_cached_backend_model_by_normalized",
    "normalize_model_id",
    "is_stale",
    "refresh",
    "get_cache_state",
    "get_cached_models_for_admin",
    "get_cached_models_with_normalized",
]
