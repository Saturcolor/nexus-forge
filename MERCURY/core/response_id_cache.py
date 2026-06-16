"""
Cache response_id par session pour le stateful POST /v1/responses (previous_response_id).
Permet de renvoyer uniquement le nouvel input au lieu de tout l'historique.
"""
import time
from typing import Dict, Optional

_Cache: Dict[str, tuple[str, float]] = {}  # session_key -> (response_id, timestamp)
_default_ttl = 600.0  # 10 min
_max_cache_size = 1000  # Limite pour éviter la croissance illimitée
_last_cleanup = 0.0
_cleanup_interval = 60.0  # Nettoyage au plus toutes les 60s


def _cleanup_expired(ttl: float = _default_ttl) -> None:
    """Supprime les entrées expirées du cache. Appelé périodiquement."""
    global _last_cleanup
    now = time.time()
    if now - _last_cleanup < _cleanup_interval:
        return
    _last_cleanup = now
    expired = [k for k, (_, ts) in _Cache.items() if now - ts > ttl]
    for k in expired:
        _Cache.pop(k, None)


def get_previous_response_id(
    session_key: str,
    ttl_seconds: float = _default_ttl,
    max_age_for_send_seconds: Optional[float] = None,
) -> Optional[str]:
    """Retourne le response_id stocké pour cette session si encore valide.
    Si max_age_for_send_seconds est défini, l'id n'est retourné que s'il a été enregistré
    il y a moins de cette durée (évite d'envoyer un id que LM Studio a pu purger)."""
    if not session_key:
        return None
    entry = _Cache.get(session_key)
    if not entry:
        return None
    rid, ts = entry
    age = time.time() - ts
    if age > ttl_seconds:
        _Cache.pop(session_key, None)
        return None
    if max_age_for_send_seconds is not None and max_age_for_send_seconds > 0 and age > max_age_for_send_seconds:
        return None
    return rid


def set_response_id(session_key: str, response_id: str) -> None:
    """Enregistre le response_id pour cette session (prochain tour utilisera previous_response_id)."""
    if session_key and response_id:
        _Cache[session_key] = (response_id, time.time())
        # Nettoyage périodique des entrées expirées
        _cleanup_expired()
        # Si le cache dépasse la taille max après cleanup, supprimer les plus anciennes
        if len(_Cache) > _max_cache_size:
            sorted_keys = sorted(_Cache, key=lambda k: _Cache[k][1])
            for k in sorted_keys[:len(_Cache) - _max_cache_size]:
                _Cache.pop(k, None)


def clear_response_id(session_key: str) -> None:
    """Invalide le response_id pour cette session (ex. après previous_response_not_found côté LM Studio)."""
    if session_key:
        _Cache.pop(session_key, None)
