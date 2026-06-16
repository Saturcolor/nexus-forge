"""
Execute schedule actions (snapshot, unload_all, load, restore) by calling
Mercury's own admin endpoints internally via httpx.
"""
import asyncio
import logging
import time
from typing import Optional

import httpx

from routing.router import get_config
from routing.models_cache import refresh as refresh_models_cache
import app_queue.request_queue as _rq
from scheduler.models import (
    ActionType, ActiveSlot, LoadedModelEntry, Schedule,
    ScheduleAction, SlotSnapshot,
)

logger = logging.getLogger("mercury.scheduler")

INTERNAL_TIMEOUT = 120.0


def _mercury_base() -> str:
    config = get_config()
    host = config.get("server_host", "0.0.0.0")
    port = config.get("server_port", 17890)
    bind = "127.0.0.1" if host == "0.0.0.0" else host
    return f"http://{bind}:{port}"


def _admin_headers() -> dict:
    config = get_config()
    token = config.get("admin_token") or ""
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


async def wait_for_idle(max_wait_seconds: int) -> bool:
    """Wait until the request queue is empty and no inference is in progress.

    Lit directement les variables in-memory (_queue_stats, _api_in_progress) pour
    éviter d'appeler get_queue_stats() → get_stats_for_date() → lecture disque
    synchrone sur l'event loop (file-I/O bloquant).
    """
    deadline = time.monotonic() + max_wait_seconds
    while time.monotonic() < deadline:
        queue_size = (_rq._queue_stats or {}).get("size", 0)
        in_progress = (_rq._queue_stats or {}).get("in_progress", 0)
        # Compter uniquement les requêtes API locales (hors cloud) — miroir de get_queue_stats()
        api_in_progress = sum(
            1 for info in (_rq._api_in_progress or {}).values()
            if info.get("backend") not in _rq._CLOUD_BACKEND_NAMES
        )
        if queue_size == 0 and in_progress == 0 and api_in_progress == 0:
            return True
        await asyncio.sleep(2)
    logger.warning("wait_for_idle: timed out after %ds", max_wait_seconds)
    return False


async def snapshot_loaded_models() -> SlotSnapshot:
    """Query all backends for currently loaded models and return a snapshot."""
    config = get_config()
    # Utilise le by_name RETOURNÉ par refresh (frais) plutôt que get_loaded_models() : si un
    # flush concurrent a fait jeter le writeback cache (gen-counter), le cache serait vide
    # et le snapshot capturerait 0 modèle. Le retour reflète toujours l'état fraîchement fetché.
    by_name = await refresh_models_cache(config)

    loaded = []
    for name, entry in by_name.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("loaded"):
            loaded.append(LoadedModelEntry(
                backend=entry.get("backend", ""),
                model_id=entry.get("backend_model_id", ""),
            ))
    logger.info("Snapshot: %d loaded models: %s",
                len(loaded), [f"{m.backend}/{m.model_id}" for m in loaded])
    return SlotSnapshot(loaded_models=loaded)


async def execute_action(action: ScheduleAction, snapshot: Optional[SlotSnapshot] = None) -> str:
    """Execute a single schedule action. Returns a log message."""
    base = _mercury_base()
    headers = _admin_headers()

    if action.type == ActionType.snapshot_state:
        snap = await snapshot_loaded_models()
        return f"snapshot: {len(snap.loaded_models)} models saved"

    elif action.type == ActionType.unload_all:
        return await _unload_all(base, headers)

    elif action.type == ActionType.unload:
        if not action.backend or not action.model:
            return "unload: skipped (missing backend/model)"
        return await _unload_one(base, headers, action.backend, action.model)

    elif action.type == ActionType.load:
        if not action.backend or not action.model:
            return "load: skipped (missing backend/model)"
        return await _load_one(base, headers, action.backend, action.model)

    elif action.type == ActionType.restore_state:
        if snapshot is None or not snapshot.loaded_models:
            return "restore: nothing to restore (no snapshot)"
        return await _restore_from_snapshot(base, headers, snapshot)

    return f"unknown action: {action.type}"


async def execute_actions(
    actions: list[ScheduleAction],
    snapshot: Optional[SlotSnapshot] = None,
) -> tuple[list[str], Optional[SlotSnapshot]]:
    """
    Execute a list of actions sequentially.
    Returns (logs, updated_snapshot).
    If a snapshot_state action is encountered, the snapshot is captured and returned.
    """
    logs = []
    current_snapshot = snapshot
    for action in actions:
        try:
            if action.type == ActionType.snapshot_state:
                current_snapshot = await snapshot_loaded_models()
                logs.append(f"snapshot: {len(current_snapshot.loaded_models)} models saved")
            else:
                msg = await execute_action(action, snapshot=current_snapshot)
                logs.append(msg)
        except Exception as e:
            msg = f"{action.type.value}: ERROR {e}"
            logs.append(msg)
            logger.exception("Action %s failed", action.type.value)
    return logs, current_snapshot


async def _unload_all(base: str, headers: dict) -> str:
    """Unload all currently loaded models across all backends."""
    config = get_config()
    from data import db as db_module
    # by_name frais via le RETOUR de refresh (cf. snapshot_loaded_models) — robuste au flush
    # concurrent qui viderait le cache (gen-counter) et ferait que _unload_all ne décharge rien.
    by_name = await refresh_models_cache(config)
    # Modèles épinglés (pin global UI "Modèles chargés") : jamais déchargés par
    # le scheduler. On matche sur la clé `name` ET sur `backend/model_id` (selon
    # les backends l'une ou l'autre identité est l'identité canonique côté UI).
    # Defensive : si data.db est en retard (fonction absente) on dégrade vers
    # "aucune protection" plutôt que d'avorter l'unload (sinon night shift KO).
    try:
        protected = db_module.get_unload_protected_models() or set()
    except Exception as e:
        logger.warning("unload_all: get_unload_protected_models indisponible (%s) — aucune protection appliquée", e)
        protected = set()

    unloaded = []
    skipped = []
    errors = []
    for name, entry in by_name.items():
        if not isinstance(entry, dict):
            continue
        if not entry.get("loaded"):
            continue
        backend = entry.get("backend", "")
        model_id = entry.get("backend_model_id", "")
        ref = f"{backend}/{model_id}"
        if name in protected or ref in protected:
            skipped.append(ref)
            logger.info("unload_all: SKIP protected %s", ref)
            continue
        try:
            result = await _unload_one(base, headers, backend, model_id)
            unloaded.append(ref)
            logger.info("unload_all: %s", result)
        except Exception as e:
            errors.append(f"{ref}: {e}")

    parts = [f"unload_all: {len(unloaded)} unloaded"]
    if skipped:
        parts.append(f"{len(skipped)} protected kept: {skipped}")
    if errors:
        parts.append(f"{len(errors)} errors: {errors}")
    return " | ".join(parts)


async def _unload_one(base: str, headers: dict, backend: str, model_id: str) -> str:
    async with httpx.AsyncClient(timeout=INTERNAL_TIMEOUT) as client:
        if backend == "ollama":
            r = await client.post(
                f"{base}/admin/ollama/unload",
                json={"model": model_id},
                headers=headers,
            )
        elif backend == "lm_studio":
            r = await client.post(
                f"{base}/admin/lm-studio/unload",
                json={"instance_id": model_id},
                headers=headers,
            )
        elif backend == "llamacpp":
            r = await client.post(
                f"{base}/admin/llamacpp/unload",
                json={"model_id": model_id},
                headers=headers,
            )
        else:
            return f"unload {backend}/{model_id}: unsupported backend"

        if r.status_code == 200:
            return f"unload {backend}/{model_id}: ok"
        return f"unload {backend}/{model_id}: HTTP {r.status_code}"


async def _load_one(base: str, headers: dict, backend: str, model_id: str) -> str:
    async with httpx.AsyncClient(timeout=INTERNAL_TIMEOUT) as client:
        if backend == "ollama":
            r = await client.post(
                f"{base}/admin/ollama/load",
                json={"model": model_id},
                headers=headers,
            )
        elif backend == "lm_studio":
            r = await client.post(
                f"{base}/admin/lm-studio/load",
                json={"model": model_id},
                headers=headers,
            )
        elif backend == "llamacpp":
            r = await client.post(
                f"{base}/admin/llamacpp/load",
                json={"model_id": model_id},
                headers=headers,
            )
        else:
            return f"load {backend}/{model_id}: unsupported backend"

        if r.status_code == 200:
            return f"load {backend}/{model_id}: ok"
        return f"load {backend}/{model_id}: HTTP {r.status_code}"


async def _restore_from_snapshot(base: str, headers: dict, snapshot: SlotSnapshot) -> str:
    from data import db as db_module
    # Les modèles protégés n'ont jamais été déchargés (cf. _unload_all) → inutile
    # de les recharger ici, ça éviterait au mieux un no-op, au pire un churn.
    try:
        protected = db_module.get_unload_protected_models() or set()
    except Exception as e:
        logger.warning("restore: get_unload_protected_models indisponible (%s) — restore complet", e)
        protected = set()
    results = []
    skipped = 0
    for entry in snapshot.loaded_models:
        # Symétrique à _unload_all : matcher `backend/model_id` ET `model_id` seul
        # (pour les backends dont la clé `name` n'a pas de préfixe, ex. ollama) —
        # sinon un modèle protégé pin par son `name` serait rechargé inutilement.
        if f"{entry.backend}/{entry.model_id}" in protected or entry.model_id in protected:
            skipped += 1
            continue
        try:
            msg = await _load_one(base, headers, entry.backend, entry.model_id)
            results.append(msg)
        except Exception as e:
            results.append(f"restore {entry.backend}/{entry.model_id}: ERROR {e}")
    head = f"restore: {len(snapshot.loaded_models) - skipped} models"
    if skipped:
        head += f" ({skipped} protected, already loaded)"
    return head + " | " + " ; ".join(results)
