"""
Résolution Authorization: Bearer <api_key> -> (user_id, priority, threshold).
Utilise la section users de la config (router.get_config()).
"""
import hmac
import logging
from typing import Tuple

logger = logging.getLogger(__name__)

DEFAULT_PRIORITY = 99


def _coerce_bool(value) -> bool:
    """Convertit en bool en évitant le foot-gun `bool("false") == True` sur YAML mal quoté."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def resolve_user(authorization_header: str | None) -> Tuple[str, int, bool]:
    """
    Retourne (user_id, priority, threshold) pour le header Authorization.
    - Absent ou pas "Bearer <key>" -> ("anonymous", DEFAULT_PRIORITY, False)
    - Clé inconnue OU entry config avec user_id vide -> ("unknown", DEFAULT_PRIORITY, False)
    - Clé connue -> (user_id, priority, threshold) de la config
    """
    from routing.router import get_config
    config = get_config()
    users = config.get("users") or []
    default_priority = config.get("anonymous_priority", DEFAULT_PRIORITY)

    if not authorization_header or not isinstance(authorization_header, str):
        return "anonymous", default_priority, False
    auth = authorization_header.strip()
    if not auth.lower().startswith("bearer "):
        return "anonymous", default_priority, False
    key = auth[7:].strip()
    if not key:
        return "anonymous", default_priority, False

    for u in users:
        if not isinstance(u, dict):
            continue
        stored_key = u.get("api_key") or ""
        if stored_key and hmac.compare_digest(stored_key, key):
            raw_user_id = u.get("user_id", "")
            user_id = str(raw_user_id).strip() if raw_user_id is not None else ""
            if not user_id:
                # Entry yaml mal configurée (user_id absent/vide). Sans ce garde-fou,
                # `"" in ("anonymous", "unknown")` est False → bypass du check
                # require_api_key dans toutes les routes REST (sauf realtime).
                logger.warning(
                    "auth: entry config matchée mais user_id vide (priority=%s, threshold=%s) → traitée comme 'unknown'",
                    u.get("priority"), u.get("threshold"),
                )
                return "unknown", default_priority, False
            return (
                user_id,
                int(u.get("priority", default_priority)),
                _coerce_bool(u.get("threshold", False)),
            )
    return "unknown", default_priority, False
