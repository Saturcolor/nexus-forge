"""
Cache prompt par modèle + response_id injectés manuellement.

Utilisé pour l'injection manuelle de prompt via le dashboard :
  1. Le proxy capture le dernier body reçu par modèle (après normalisation, avant reasoning).
  2. L'endpoint /admin/lm-studio/inject-prompt envoie ce body caché à LM Studio.
  3. Le response_id obtenu est stocké ici pour que le proxy l'utilise en mode stateful.
"""
import copy
import logging
import time
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# Dernier body capturé par modèle (pour l'injection manuelle)
_prompt_cache: Dict[str, dict] = {}

# Response ID injectés manuellement (model → (response_id, timestamp))
_injected_ids: Dict[str, tuple[str, float]] = {}


def cache_body_for_model(model: str, body: dict) -> None:
    """Cache le body (après normalisation, AVANT reasoning) pour injection ultérieure.
    Deep copy pour éviter que des mutations ultérieures (build_stateful_body, etc.)
    ne corrompent le cache."""
    if model and isinstance(body, dict):
        _prompt_cache[model] = copy.deepcopy(body)


def get_cached_body(model: str) -> Optional[dict]:
    """Retourne une copie du dernier body caché pour ce modèle (deep copy)."""
    cached = _prompt_cache.get(model)
    return copy.deepcopy(cached) if cached is not None else None


def set_injected_response_id(model: str, rid: str) -> None:
    """Stocke un response_id injecté manuellement pour ce modèle."""
    if model and rid:
        _injected_ids[model] = (rid, time.time())
        logger.info("prompt_cache: response_id injecté stocké (model=%s, id=%s)", model, rid[:40])


def get_injected_response_id(model: str, max_age: float = 300.0) -> Optional[str]:
    """Retourne le response_id injecté si encore récent."""
    entry = _injected_ids.get(model)
    if not entry:
        return None
    rid, ts = entry
    if time.time() - ts > max_age:
        _injected_ids.pop(model, None)
        return None
    return rid


def clear_injected_response_id(model: str) -> None:
    """Supprime le response_id injecté pour ce modèle."""
    if _injected_ids.pop(model, None):
        logger.info("prompt_cache: response_id injecté supprimé (model=%s)", model)
