"""
Runtime slot state — singleton that tracks the currently active exclusive slot.
Thread-safe via threading.Lock (accessed from async context but mutations are fast).

Transition mode: when a slot ends, we enter "transition" which blocks ALL consumers
(including the slot owner) while models are being swapped. This prevents the slot
consumer from re-triggering a load of their model during restore.
"""
import logging
import threading
from datetime import datetime, timezone
from typing import Optional

from scheduler.models import ActiveSlot

logger = logging.getLogger("mercury.scheduler")

_lock = threading.Lock()
_active_slot: Optional[ActiveSlot] = None
_transition = False


def get_active_slot() -> Optional[ActiveSlot]:
    """Public accessor — masque les slots expirés (cleanup en cours).
    Pour les clients API/UI : un slot expiré est vu comme inactif.
    Pour la logique interne tick()/_deactivate_slot(), utiliser _get_raw_active_slot()."""
    with _lock:
        if _active_slot is None:
            return None
        if _transition:
            return _active_slot
        if _is_expired(_active_slot):
            return None
        return _active_slot


def _get_raw_active_slot() -> Optional[ActiveSlot]:
    """Internal — retourne _active_slot SANS masquer l'expiration.
    Utilisé par tick() pour détecter l'expiration et par _deactivate_slot() pour pouvoir
    cleanup un slot expiré (sinon get_active_slot le masque déjà → cleanup jamais déclenché)."""
    with _lock:
        return _active_slot


def set_active_slot(slot: ActiveSlot) -> None:
    global _active_slot, _transition
    with _lock:
        _active_slot = slot
        _transition = False
    logger.info("Slot activated: %s (until %s, allowed=%s)",
                slot.schedule_name, slot.ends_at, slot.allowed_consumers)


def enter_transition() -> None:
    """Block ALL consumers while models are being swapped at slot end."""
    global _transition
    with _lock:
        _transition = True
    logger.info("Slot entering transition — all consumers blocked")


def clear_active_slot() -> Optional[ActiveSlot]:
    global _active_slot, _transition
    with _lock:
        prev = _active_slot
        _active_slot = None
        _transition = False
    if prev:
        logger.info("Slot cleared: %s", prev.schedule_name)
    return prev


def is_consumer_allowed(user_id: str) -> bool:
    """Check if a consumer (identified by user_id from auth) can make inference requests.
    Cohérent avec get_active_slot : un slot expiré-pas-encore-cleanup n'est plus bloquant
    (le cleanup tick s'occupera de lancer actions_end <= TICK_SECONDS plus tard)."""
    with _lock:
        if _active_slot is None:
            return True
        if _transition:
            return False
        if _is_expired(_active_slot):
            return True
        if not _active_slot.exclusive:
            return True
        if not _active_slot.allowed_consumers:
            return False
        return user_id in _active_slot.allowed_consumers


def get_slot_status() -> dict:
    """Public status payload for GET /v1/slots/active."""
    with _lock:
        slot = _active_slot
        transitioning = _transition
        if slot is not None and not transitioning and _is_expired(slot):
            slot = None
    if slot is None:
        return {"blocked": False, "active_slot": None}
    return {
        "blocked": True,
        "transition": transitioning,
        "active_slot": {
            "schedule_id": slot.schedule_id,
            "schedule_name": slot.schedule_name,
            "started_at": slot.started_at,
            "ends_at": slot.ends_at,
            "exclusive": slot.exclusive,
            "allowed_consumers": slot.allowed_consumers,
        },
    }


def build_slot_rejection(user_id: str) -> Optional[dict]:
    """Si user_id n'est pas autorisé pour le slot actif, retourne le payload prêt-à-emit :
    {detail, response: {status_code, content, headers}} — caller fait log_rejection(detail)
    + return JSONResponse(**response). Retourne None si pas de blocage.

    Factorisé pour que toutes les routes d'inférence locale (chat, /api/chat, /v1/responses,
    embeddings, audio local, realtime) respectent le même contrat de réservation que celui
    annoncé par le slot — sinon un consumer non-autorisé pouvait contourner via /api/chat
    pendant qu'on bloquait /v1/chat/completions (F1 du rapport fonctionnel)."""
    if is_consumer_allowed(user_id):
        return None
    active = get_active_slot()
    retry_after = get_retry_after_seconds() or 60
    detail = (
        f"Resource reserved for '{active.schedule_name}' until {active.ends_at}. "
        f"Allowed consumers: {active.allowed_consumers}"
    ) if active else "Resource reserved"
    return {
        "detail": detail,
        "response": {
            "status_code": 503,
            "content": {
                "error": {
                    "message": detail,
                    "type": "slot_reserved",
                    "retry_after": retry_after,
                    "ends_at": active.ends_at if active else None,
                }
            },
            "headers": {"Retry-After": str(retry_after)},
        },
    }


def get_retry_after_seconds() -> Optional[int]:
    """Seconds until the current slot ends, or short delay during transition."""
    with _lock:
        slot = _active_slot
        transitioning = _transition
    if slot is None:
        return None
    if transitioning:
        return 30
    try:
        ends = datetime.fromisoformat(slot.ends_at)
        now = datetime.now(timezone.utc)
        delta = (ends - now).total_seconds()
        return max(1, int(delta))
    except Exception:
        return 60


def _is_expired(slot: ActiveSlot) -> bool:
    try:
        ends = datetime.fromisoformat(slot.ends_at)
        return datetime.now(timezone.utc) >= ends
    except Exception:
        return False


def is_slot_expired(slot: ActiveSlot) -> bool:
    """Accesseur public de _is_expired : le scheduler (loop._activate_slot) en a besoin
    pour distinguer un slot encore vivant d'un slot expiré-pas-encore-cleanup lors du
    re-check anti-overwrite sous _op_lock."""
    return _is_expired(slot)
