"""
Cache pour éviter d'appeler POST /api/v1/models/load à chaque requête.
LM Studio renvoie 500 quand le modèle est déjà chargé.
Stratégie : GET /api/v1/models d'abord ; si le modèle a loaded_instances non vide, skip load.
Sinon fallback sur le cache TTL (si GET échoue).
"""
import asyncio
import time
from typing import Any, Dict, List, Tuple

# (native_base, model_id) -> timestamp du dernier appel load
_cache: Dict[Tuple[str, str], float] = {}
_TTL_SECONDS = 300  # 5 min

# Locks par clé (native_base, model_id) pour sérialiser les load concurrent du même modèle.
# Évite la race check-then-act : deux requêtes simultanées sur un modèle non chargé
# postaient toutes deux POST /api/v1/models/load (erreur 500 sur le doublon).
_load_locks: Dict[Tuple[str, str], asyncio.Lock] = {}


def get_load_lock(native_base: str, model_id: str) -> asyncio.Lock:
    """
    Retourne (en le créant si besoin) le Lock asyncio dédié à la paire (native_base, model_id).
    À utiliser en `async with get_load_lock(...)` autour du bloc check+POST load.
    """
    key = (native_base.rstrip("/"), (model_id or "").strip())
    if key not in _load_locks:
        _load_locks[key] = asyncio.Lock()
        import logging
        logging.getLogger(__name__).debug(
            "load_cache: nouveau lock créé pour %s / %s", key[0], key[1]
        )
    return _load_locks[key]


def should_skip_load(native_base: str, model_id: str) -> bool:
    """True si on peut sauter l'appel load (déjà fait récemment)."""
    key = (native_base.rstrip("/"), (model_id or "").strip())
    if not key[1]:
        return False
    ts = _cache.get(key)
    if ts is None:
        return False
    return (time.time() - ts) < _TTL_SECONDS


def mark_load_done(native_base: str, model_id: str) -> None:
    """À appeler après avoir tenté load (succès ou 500)."""
    key = (native_base.rstrip("/"), (model_id or "").strip())
    if key[1]:
        _cache[key] = time.time()


def is_model_loaded_in_response(data: Any, model_id: str) -> bool:
    """
    True si dans la réponse GET /api/v1/models le modèle model_id a au moins une instance chargée.
    data : dict avec clé "models" (liste d'objets avec "key" ou "id" et "loaded_instances").
    """
    if not isinstance(data, dict) or not model_id:
        return False
    models: List[Dict[str, Any]] = data.get("models", data.get("data", []))
    if not isinstance(models, list):
        return False
    mid = (model_id or "").strip()
    for m in models:
        key = m.get("key") or m.get("id") or m.get("name")
        if isinstance(key, dict):
            key = key.get("key") or key.get("id") or ""
        if not key:
            continue
        if str(key).strip() == mid:
            loaded = m.get("loaded_instances") or []
            return bool(loaded and isinstance(loaded, list))
    return False


def invalidate_for_instance(instance_id: str) -> None:
    """
    Retire du cache toute entrée dont le model_id correspond à instance_id.
    À appeler après un unload réussi pour que la prochaine requête refasse un load si besoin.
    """
    if not instance_id:
        return
    sid = (instance_id or "").strip()
    to_remove = [k for k in _cache if k[1] == sid]
    for k in to_remove:
        _cache.pop(k, None)
