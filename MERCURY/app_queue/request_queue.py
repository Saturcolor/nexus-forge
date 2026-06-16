"""
File à priorité (heapq) + un seul worker : une requête à la fois, streaming supporté.
Les requêtes sont triées par (priority, timestamp) ; à chaque _log() écriture dans
logs/usage_YYYY-MM-DD.jsonl et garde des N dernières entrées en mémoire pour le jour.
"""
import asyncio
import copy
import heapq
import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from routing.router import get_config, resolve_and_prepare
from providers import get_backend
from providers.base import BackendResult

logger = logging.getLogger(__name__)
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
_recent_logs_max = 100


@dataclass
class QueuedRequest:
    request_id: str
    body: dict
    stream: bool
    response_future: asyncio.Future
    put_event: asyncio.Event
    stream_queue: Optional[asyncio.Queue] = None
    user_id: str = "anonymous"
    priority: int = 99
    threshold: bool = False


@dataclass(order=True)
class _HeapItem:
    priority: int
    put_time: float
    item: QueuedRequest = field(compare=False)


_pending: list[_HeapItem] = []
_condition: asyncio.Condition = None
_queue_stats: dict = {"size": 0, "in_progress": 0, "processed": 0}
_recent_logs: list = []
# Compteur requêtes cloud traitées aujourd'hui (reset implicite : date change)
_cloud_processed_count: int = 0
_cloud_processed_date: str = ""
# Cache des stats agrégées par date — incrémental (ne relit que les nouvelles lignes)
_stats_cache: dict = {}  # date_str -> {"stats": dict, "log_count": int, "file_offset": int}
# Verrou (threading, PAS asyncio) protégeant le RMW de _stats_cache : get_stats_for_date
# est appelé par des handlers de route SYNC exécutés dans le threadpool Starlette
# (admin/routes/queue_routes.py), donc 2 polls dashboard concurrents font un vrai RMW
# concurrent sur le même dict partagé. Lock obligatoire pour éviter compteurs corrompus
# (double-count) et « dict changed size during iteration » à la sérialisation json_safe.
_stats_cache_lock = threading.Lock()
# Requêtes /api/chat en cours (hors file) : tant qu'on n'a pas reçu la réponse du provider.
_api_in_progress: dict = {}  # request_id -> {model, user_id, backend, started_at}
_api_in_progress_lock: Optional[asyncio.Lock] = None
# Requête actuellement traitée par le worker (pour cancellation admin).
_current_request: Optional[QueuedRequest] = None
_current_task: Optional[asyncio.Task] = None

# Priority threshold (grace period) : après traitement d'un user avec threshold activé,
# on attend un délai avant de servir un user moins prioritaire.
_last_served_priority: Optional[int] = None
_last_served_threshold: bool = False
_last_served_time: float = 0.0


def _get_api_lock() -> asyncio.Lock:
    global _api_in_progress_lock
    if _api_in_progress_lock is None:
        _api_in_progress_lock = asyncio.Lock()
    return _api_in_progress_lock


async def register_api_request_in_progress(request_id: str, model: str, user_id: str, backend: str) -> None:
    """Enregistre une requête /api/chat en cours (appelé au début, avant l'appel au provider)."""
    global _api_in_progress
    async with _get_api_lock():
        _api_in_progress[request_id] = {
            "model": model,
            "user_id": user_id,
            "backend": backend,
            "started_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }


async def unregister_api_request_in_progress(request_id: str) -> None:
    """Retire une requête /api/chat des en cours (appelé quand le stream/requête se termine).
    Le compteur « traité » est incrémenté dans _log(), pas ici, pour ne compter que les requêtes
    vraiment terminées (succès ou erreur loguée), pas les déconnexions client."""
    global _api_in_progress
    async with _get_api_lock():
        _api_in_progress.pop(request_id, None)


_CLOUD_BACKEND_NAMES = {"openrouter", "anthropic", "audio_openai", "audio_groq", "audio_elevenlabs", "audio_local", "openai_realtime"}


def get_queue_stats():
    """Stats file + nombre de requêtes /api/chat en cours (sans la file).
    « processed » = requêtes loguées aujourd'hui (même source que logs/stats, remis à zéro chaque jour UTC).
    Sépare les requêtes cloud (openrouter/anthropic) des requêtes locales."""
    base = dict(_queue_stats) if _queue_stats else {"size": 0, "in_progress": 0, "processed": 0}
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_stats = get_stats_for_date(today)
    base["processed"] = int(today_stats.get("total_requests") or 0)

    # Séparer api_in_progress : cloud vs local
    cloud_items = []
    local_items = []
    for info in _api_in_progress.values():
        if info.get("backend") in _CLOUD_BACKEND_NAMES:
            cloud_items.append(info)
        else:
            local_items.append(info)

    # in_progress = worker en cours + requêtes api directes locales (hors cloud)
    api_count = len(local_items)
    base["api_in_progress"] = api_count
    base["in_progress"] = base.get("in_progress", 0) + api_count
    base["api_in_progress_list"] = local_items

    # Cloud stats
    base["cloud_in_progress"] = len(cloud_items)
    base["cloud_in_progress_list"] = cloud_items
    base["cloud_processed"] = _cloud_processed_count if _cloud_processed_date == today else 0

    # Priority threshold (grace period) status
    config = get_config()
    threshold_enabled = config.get("priority_threshold_enabled", False)
    threshold_seconds = config.get("priority_threshold_seconds", 30)
    if threshold_enabled and _last_served_threshold and _last_served_priority is not None:
        elapsed = time.monotonic() - _last_served_time
        remaining = threshold_seconds - elapsed
        if remaining > 0:
            base["threshold_active"] = True
            base["threshold_remaining"] = round(remaining, 1)
            base["threshold_priority"] = _last_served_priority
        else:
            base["threshold_active"] = False
    else:
        base["threshold_active"] = False

    # Infos sur la requête en cours (pour le bouton annuler du dashboard)
    # Bind en local pour éviter un torn-read : le worker peut passer _current_request
    # à None entre le if-check et les accès aux attributs (thread threadpool vs worker).
    cur = _current_request
    if cur is not None:
        base["current_request"] = {
            "request_id": cur.request_id,
            "model": cur.body.get("model", ""),
            "user_id": cur.user_id,
        }

    return base


def get_recent_logs():
    return list(_recent_logs) if _recent_logs else []


def _usage_log_path(date_str: str) -> Path:
    """logs/usage_YYYY-MM-DD.jsonl"""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    return LOG_DIR / f"usage_{date_str}.jsonl"


def _build_log_entry(
    request_id: str,
    user_id: str,
    model: str,
    backend: str,
    status: str,
    duration_ms: Optional[float] = None,
    error_detail: Optional[str] = None,
    usage: Optional[dict] = None,
) -> tuple:
    """Construit l'entrée de log et retourne (date_str, entry)."""
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")
    timestamp = now.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    entry = {
        "request_id": request_id,
        "user_id": user_id,
        "model": model,
        "backend": backend,
        "status": status,
        "duration_ms": duration_ms,
        "timestamp": timestamp,
    }
    if error_detail:
        entry["error"] = error_detail[:500]
    if usage and isinstance(usage, dict):
        u = {k: v for k, v in usage.items() if v is not None}
        if u.get("prompt_tokens") is not None and u.get("input_tokens") is None:
            u["input_tokens"] = u["prompt_tokens"]
        if u.get("completion_tokens") is not None and u.get("output_tokens") is None:
            u["output_tokens"] = u["completion_tokens"]
        entry["usage"] = u
    return date_str, entry


def _write_log_to_disk(path, line: str) -> None:
    """Écriture synchrone dans le fichier JSONL (exécutée dans un thread)."""
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)


def _log(
    request_id: str,
    user_id: str,
    model: str,
    backend: str,
    status: str,
    duration_ms: Optional[float] = None,
    error_detail: Optional[str] = None,
    usage: Optional[dict] = None,
):
    global _recent_logs, _cloud_processed_count, _cloud_processed_date
    date_str, entry = _build_log_entry(
        request_id, user_id, model, backend, status, duration_ms, error_detail, usage,
    )
    # Compteur cloud journalier
    if backend in _CLOUD_BACKEND_NAMES:
        if date_str != _cloud_processed_date:
            _cloud_processed_count = 0
            _cloud_processed_date = date_str
        _cloud_processed_count += 1
    # Écriture disque dans un thread pour ne pas bloquer l'event loop
    try:
        path = _usage_log_path(date_str)
        line = json.dumps(entry, ensure_ascii=False) + "\n"
        try:
            loop = asyncio.get_running_loop()
            fut = loop.run_in_executor(None, _write_log_to_disk, path, line)

            def _on_write_done(f):
                exc = f.exception()
                if exc is not None:
                    logger.warning("Écriture usage log (executor): %s", exc)

            fut.add_done_callback(_on_write_done)
        except RuntimeError:
            # Pas d'event loop (appel sync) — écriture directe
            _write_log_to_disk(path, line)
    except Exception as e:
        logger.warning("Écriture usage log: %s", e)
    # Keep last N in memory for today only
    entry_for_memory = {**entry, "date": date_str}
    _recent_logs = ([entry_for_memory] + (_recent_logs or []))[:_recent_logs_max]


def log_rejection(
    request_id: str,
    user_id: str,
    model: str,
    status: str,
    error_detail: str,
) -> None:
    """Enregistre un rejet (401, 400, etc.) dans les logs d'usage pour affichage dans le dashboard."""
    _log(request_id, user_id, model, "-", status, None, error_detail)


def log_api_request(
    request_id: str,
    user_id: str,
    model: str,
    backend: str,
    status: str,
    duration_ms: Optional[float] = None,
    error_detail: Optional[str] = None,
    usage: Optional[dict] = None,
) -> None:
    """Enregistre une requête /api/chat (succès ou erreur) dans les logs d'usage pour le dashboard."""
    _log(request_id, user_id, model, backend, status, duration_ms, error_detail, usage)


def get_logs_for_date(date_str: str) -> list:
    """Lit logs/usage_YYYY-MM-DD.jsonl et retourne la liste des entrées."""
    path = _usage_log_path(date_str)
    if not path.exists():
        return []
    out = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    except Exception as e:
        logger.warning("Lecture logs %s: %s", date_str, e)
    return out


def _read_new_lines(path, offset: int) -> tuple:
    """Lit les nouvelles lignes d'un fichier JSONL à partir de l'offset donné.
    Retourne (new_entries, new_offset)."""
    entries = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            f.seek(offset)
            for line in f:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    entries.append(json.loads(stripped))
                except json.JSONDecodeError:
                    pass
            new_offset = f.tell()
    except Exception as e:
        logger.warning("Lecture incrémentale logs: %s", e)
        return entries, offset
    return entries, new_offset


def _accumulate_stats(stats: dict, entries: list) -> None:
    """Ajoute les entrées aux stats existantes (incrémental)."""
    by_user = stats["by_user"]
    for e in entries:
        uid = e.get("user_id", "unknown")
        stats["total_requests"] += 1
        d = e.get("duration_ms")
        if d is not None:
            stats["total_duration_ms"] += d
        if uid not in by_user:
            by_user[uid] = {
                "requests": 0,
                "total_duration_ms": 0,
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "total_reasoning_tokens": 0,
                "requests_with_usage": 0,
            }
        by_user[uid]["requests"] += 1
        if d is not None:
            by_user[uid]["total_duration_ms"] += d
        u = e.get("usage")
        if u and isinstance(u, dict):
            stats["requests_with_usage"] += 1
            by_user[uid]["requests_with_usage"] += 1
            inp = u.get("input_tokens") or u.get("prompt_tokens")
            out = u.get("output_tokens") or u.get("completion_tokens")
            reas = u.get("reasoning_tokens")
            if inp is not None:
                stats["total_input_tokens"] += inp
                by_user[uid]["total_input_tokens"] += inp
            if out is not None:
                stats["total_output_tokens"] += out
                by_user[uid]["total_output_tokens"] += out
            if reas is not None:
                stats["total_reasoning_tokens"] += reas
                by_user[uid]["total_reasoning_tokens"] += reas


def get_stats_for_date(date_str: str) -> dict:
    """Agrégat par user pour la date donnée (depuis usage_*.jsonl). Inclut tokens si usage présent.
    Lecture incrémentale : ne relit que les nouvelles lignes depuis le dernier appel."""
    path = _usage_log_path(date_str)
    if not path.exists():
        return {
            "date": date_str, "by_user": {}, "total_requests": 0,
            "total_duration_ms": 0, "total_input_tokens": 0,
            "total_output_tokens": 0, "total_reasoning_tokens": 0,
            "requests_with_usage": 0,
        }

    # RMW protégé : lecture du cache + lecture incrémentale + accumulation + write-back
    # doivent être atomiques vis-à-vis des autres threads du threadpool. On retourne un
    # deepcopy (snapshot) pour que l'appelant (get_queue_stats / json_safe) ne sérialise
    # jamais le dict vivant pendant qu'un autre thread le mute (« dict changed size »).
    with _stats_cache_lock:
        cached = _stats_cache.get(date_str)
        if cached:
            offset = cached.get("file_offset", 0)
            stats = cached["stats"]
        else:
            offset = 0
            stats = {
                "date": date_str, "by_user": {}, "total_requests": 0,
                "total_duration_ms": 0, "total_input_tokens": 0,
                "total_output_tokens": 0, "total_reasoning_tokens": 0,
                "requests_with_usage": 0,
            }

        new_entries, new_offset = _read_new_lines(path, offset)
        if new_entries:
            _accumulate_stats(stats, new_entries)
        _stats_cache[date_str] = {"stats": stats, "file_offset": new_offset}
        return copy.deepcopy(stats)


def _empty_point(t: str) -> dict:
    return {
        "t": t,
        "requests": 0,
        "duration_ms": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
    }


def _accumulate_point(point: dict, entry: dict) -> None:
    point["requests"] += 1
    d = entry.get("duration_ms")
    if d is not None:
        point["duration_ms"] += d
    u = entry.get("usage")
    if u and isinstance(u, dict):
        inp = u.get("input_tokens") or u.get("prompt_tokens")
        out = u.get("output_tokens") or u.get("completion_tokens")
        reas = u.get("reasoning_tokens")
        if inp is not None:
            point["input_tokens"] += inp
        if out is not None:
            point["output_tokens"] += out
        if reas is not None:
            point["reasoning_tokens"] += reas


def _empty_breakdown() -> dict:
    return {
        "by_backend": {},   # backend → {requests, duration_ms, tokens}
        "by_model": {},     # model → {requests, duration_ms, tokens}
        "by_dow_hour": [[0] * 24 for _ in range(7)],  # heatmap 7×24 (Lun=0..Dim=6)
    }


def _update_breakdown(b: dict, entry: dict) -> None:
    backend = entry.get("backend") or "unknown"
    model = entry.get("model") or "unknown"
    duration = entry.get("duration_ms") or 0
    usage = entry.get("usage") or {}
    inp = (usage.get("input_tokens") or usage.get("prompt_tokens") or 0) if isinstance(usage, dict) else 0
    out = (usage.get("output_tokens") or usage.get("completion_tokens") or 0) if isinstance(usage, dict) else 0
    tokens = (inp or 0) + (out or 0)

    by_be = b["by_backend"].setdefault(backend, {"requests": 0, "duration_ms": 0, "tokens": 0})
    by_be["requests"] += 1
    by_be["duration_ms"] += duration
    by_be["tokens"] += tokens

    by_md = b["by_model"].setdefault(model, {"requests": 0, "duration_ms": 0, "tokens": 0})
    by_md["requests"] += 1
    by_md["duration_ms"] += duration
    by_md["tokens"] += tokens

    ts = entry.get("timestamp")
    if ts:
        try:
            dt = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
        except ValueError:
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                dt = None
        if dt is not None:
            # Python weekday(): Lun=0..Dim=6
            b["by_dow_hour"][dt.weekday()][dt.hour] += 1


def get_stats_range(days: int, bucket: str = "day") -> dict:
    """Agrégat d'usage sur les N derniers jours, bucket 'day' ou 'hour'.

    - bucket='day' : un point par jour calendaire UTC (sommes lues des fichiers usage_*.jsonl).
    - bucket='hour' : un point par heure UTC sur la fenêtre [now-Nd, now], lecture des entrées
      datées via leur 'timestamp' ISO.
    """
    days = max(1, min(int(days), 366))
    now = datetime.now(timezone.utc)
    breakdown = _empty_breakdown()

    if bucket == "hour":
        # On lit aujourd'hui + hier (suffisant pour 24h ; on étend si days>1 pour rester générique)
        total_hours = max(24, days * 24)
        start = now - timedelta(hours=total_hours)
        # Init buckets horaires alignés à l'heure pile
        start_floor = start.replace(minute=0, second=0, microsecond=0)
        end_floor = now.replace(minute=0, second=0, microsecond=0)
        points: dict[str, dict] = {}
        cursor = start_floor
        while cursor <= end_floor:
            key = cursor.strftime("%Y-%m-%dT%H:00:00Z")
            points[key] = _empty_point(key)
            cursor += timedelta(hours=1)
        # Itère les fichiers concernés
        date_cursor = start.date()
        end_date = now.date()
        while date_cursor <= end_date:
            ds = date_cursor.strftime("%Y-%m-%d")
            path = _usage_log_path(ds)
            if path.exists():
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                entry = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            ts = entry.get("timestamp")
                            if not ts:
                                continue
                            try:
                                dt = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
                            except ValueError:
                                try:
                                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                                except ValueError:
                                    continue
                            if dt < start or dt > now:
                                continue
                            key = dt.strftime("%Y-%m-%dT%H:00:00Z")
                            if key in points:
                                _accumulate_point(points[key], entry)
                            _update_breakdown(breakdown, entry)
                except Exception as e:
                    logger.warning("Lecture range %s: %s", ds, e)
            date_cursor += timedelta(days=1)
        return {"bucket": "hour", "points": [points[k] for k in sorted(points.keys())], "breakdown": breakdown}

    # bucket = day
    start_date = (now - timedelta(days=days - 1)).date()
    end_date = now.date()
    points_list: list[dict] = []
    date_cursor = start_date
    while date_cursor <= end_date:
        ds = date_cursor.strftime("%Y-%m-%d")
        point = _empty_point(ds)
        path = _usage_log_path(ds)
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        _accumulate_point(point, entry)
                        _update_breakdown(breakdown, entry)
            except Exception as e:
                logger.warning("Lecture range %s: %s", ds, e)
        points_list.append(point)
        date_cursor += timedelta(days=1)
    return {"bucket": "day", "points": points_list, "breakdown": breakdown}


def get_available_dates() -> list:
    """Liste des dates ayant un fichier usage_*.jsonl."""
    if not LOG_DIR.exists():
        return []
    dates = []
    for f in LOG_DIR.glob("usage_*.jsonl"):
        try:
            # usage_2025-03-02.jsonl
            suffix = f.stem.replace("usage_", "")
            if len(suffix) == 10 and suffix[4] == "-" and suffix[7] == "-":
                dates.append(suffix)
        except Exception:
            pass
    return sorted(dates, reverse=True)


async def _process_one(item: QueuedRequest, config: dict):
    """Traite une seule requête (appelé comme sous-tâche pour permettre la cancellation)."""
    request_id = item.request_id
    body = item.body
    stream = item.stream
    model = body.get("model", "")
    user_id = getattr(item, "user_id", "anonymous")
    backend_name = "unknown"

    backend_name, backend_model_id, body_for_backend, _canonical = await resolve_and_prepare(body)
    if config.get("debug"):
        try:
            js = json.dumps(body_for_backend, ensure_ascii=False)
            js = (js[:4000] + "...") if len(js) > 4000 else js
            logger.info("DEBUG [worker] transféré vers %s (body): %s", backend_name, js)
        except Exception:
            logger.info("DEBUG [worker] transféré vers %s (body): %s", backend_name, str(body_for_backend)[:4000])
    backend = get_backend(backend_name, config)
    t0 = time.perf_counter()

    if stream and getattr(item, "stream_queue", None) is None:
        # Invariant violé : stream=True doit toujours s'accompagner d'une stream_queue.
        # Sans queue, le générateur backend ne serait jamais itéré → fuite (connexion httpx
        # suspendue) + futur résolu à None ce qui ment au caller. On refuse fort.
        raise RuntimeError(
            f"stream=True sans stream_queue (request_id={request_id}, user={user_id}, "
            f"model={model}) — caller incorrect"
        )

    result = await backend.chat(body_for_backend, stream=stream)

    if stream:
        async for chunk in result:
            await item.stream_queue.put(chunk)
        await item.stream_queue.put(None)
        item.response_future.set_result(None)
        usage = getattr(result, "usage", None)
    else:
        item.response_future.set_result(result)
        usage = result.body.get("usage") if isinstance(result, BackendResult) and hasattr(result, "body") else None

    duration_ms = (time.perf_counter() - t0) * 1000
    status_code = getattr(result, "status_code", 200) if isinstance(result, BackendResult) else 200
    status_label = "ok" if status_code < 400 else f"backend_{status_code}"
    _log(request_id, user_id, model, backend_name, status_label, duration_ms, usage=usage)
    if status_code >= 400:
        error_body = ""
        if isinstance(result, BackendResult) and isinstance(result.body, dict):
            error_body = result.body.get("error", result.body.get("detail", ""))
            if isinstance(error_body, dict):
                error_body = error_body.get("message", str(error_body))
            error_body = str(error_body)[:300]
        logger.warning(
            "Requête %s [%s] terminée: model=%s backend=%s HTTP %d en %.0f ms — %s",
            request_id, user_id, model, backend_name, status_code, duration_ms, error_body,
        )
    else:
        logger.info(
            "Requête %s [%s] terminée: model=%s backend=%s ok en %.0f ms",
            request_id, user_id, model, backend_name, duration_ms,
        )


async def _run_worker():
    """Un seul worker : dépile par priorité (puis FIFO), traite une requête à la fois.
    Si priority_threshold_enabled et que le dernier user servi a threshold=True,
    on attend un grace period avant de servir un user moins prioritaire."""
    global _pending, _condition, _queue_stats, _last_served_priority, _last_served_threshold, _last_served_time
    global _current_request, _current_task

    while True:
        config = get_config()
        try:
            async with _condition:
                await _condition.wait_for(lambda: len(_pending) > 0)

                # --- Priority threshold (grace period) ---
                # S'active si : le toggle global est ON + le dernier user servi a threshold=True
                threshold_enabled = config.get("priority_threshold_enabled", False)
                threshold_seconds = config.get("priority_threshold_seconds", 30)
                if threshold_enabled and _last_served_threshold and _last_served_priority is not None and _pending:
                    next_prio = _pending[0].priority
                    if next_prio > _last_served_priority:
                        elapsed = time.monotonic() - _last_served_time
                        remaining = threshold_seconds - elapsed
                        if remaining > 0:
                            logger.debug(
                                "Grace period: attente %.1fs avant de servir prio %s (dernier servi prio %s)",
                                remaining, next_prio, _last_served_priority,
                            )
                            try:
                                await asyncio.wait_for(
                                    _condition.wait_for(
                                        lambda: _pending and _pending[0].priority <= _last_served_priority
                                    ),
                                    timeout=remaining,
                                )
                            except asyncio.TimeoutError:
                                pass
                            # Si la file est vide après l'attente, on reboucle
                            if not _pending:
                                continue

                heap_item = heapq.heappop(_pending)
                item = heap_item.item
                _queue_stats["size"] = len(_pending)
        except (asyncio.CancelledError, AttributeError):
            break

        _queue_stats["in_progress"] = 1
        _current_request = item
        served_priority = item.priority
        request_id = item.request_id
        model = item.body.get("model", "")
        user_id = getattr(item, "user_id", "anonymous")

        try:
            _current_task = asyncio.create_task(_process_one(item, config))
            await _current_task
        except asyncio.CancelledError:
            # Annulation (admin ou déconnexion client) : loguer et notifier le client.
            # La propagation du CancelledError dans `async for chunk in result` finalise
            # le générateur backend → son `async with httpx ... stream(...)` se ferme,
            # coupant le stream upstream (plus de génération côté backend).
            _log(request_id, user_id, model, "unknown", "cancelled")
            logger.info("Requête %s [%s] annulée (admin ou déconnexion client)", request_id, user_id)
            if not item.response_future.done():
                item.response_future.set_exception(asyncio.CancelledError())
            if item.stream and getattr(item, "stream_queue", None) is not None:
                try:
                    await item.stream_queue.put(None)
                except Exception:
                    pass
        except Exception as e:
            _log(request_id, user_id, model, "unknown", "error", error_detail=str(e))
            logger.exception("Requête %s erreur: %s", request_id, e)
            if not item.response_future.done():
                item.response_future.set_exception(e)
            if item.stream and getattr(item, "stream_queue", None) is not None:
                try:
                    await item.stream_queue.put(None)
                except Exception:
                    pass
        finally:
            _current_request = None
            _current_task = None
            _queue_stats["in_progress"] = 0
            # Enregistrer le dernier user servi pour le grace period
            _last_served_priority = served_priority
            _last_served_threshold = item.threshold
            _last_served_time = time.monotonic()


async def cancel_current_request() -> dict:
    """Annule la requête en cours de traitement par le worker."""
    if _current_task is None or _current_request is None:
        return {"cancelled": False, "reason": "no_request_in_progress"}
    request_id = _current_request.request_id
    _current_task.cancel()
    return {"cancelled": True, "request_id": request_id}


def cancel_request_if_current(request_id: str) -> bool:
    """Annule la task worker UNIQUEMENT si elle traite encore `request_id`.

    Appelé quand le client se déconnecte en plein stream : sans ce garde-fou, le
    worker continuerait à générer (GPU gaspillé) et bloquerait la file (sérielle)
    en tête de ligne. Le check `_current_request.request_id == request_id` évite
    la course où le worker serait déjà passé à une AUTRE requête entre la détection
    de déconnexion et l'appel ici (on tuerait alors la requête d'un autre user).
    Retourne True si une annulation a été déclenchée."""
    if _current_task is None or _current_request is None:
        return False
    if _current_request.request_id != request_id:
        return False
    if _current_task.done():
        return False
    logger.info("Client déconnecté : annulation de la requête en cours %s", request_id)
    _current_task.cancel()
    return True


def init_queue():
    global _condition
    _condition = asyncio.Condition()


async def enqueue(
    body: dict,
    stream: bool,
    stream_queue: Optional[asyncio.Queue] = None,
    user_id: str = "anonymous",
    priority: int = 99,
    threshold: bool = False,
) -> QueuedRequest:
    """
    Met la requête en file (ordre par priorité puis FIFO).
    user_id, priority et threshold viennent de auth.resolve_user(Authorization).
    """
    global _pending, _condition, _queue_stats
    if _condition is None:
        init_queue()
    config = get_config()
    max_size = config.get("queue_max_size", 100)

    request_id = str(uuid.uuid4())[:8]
    response_future = asyncio.get_running_loop().create_future()
    put_event = asyncio.Event()

    item = QueuedRequest(
        request_id=request_id,
        body=body,
        stream=stream,
        response_future=response_future,
        put_event=put_event,
        stream_queue=stream_queue,
        user_id=user_id,
        priority=priority,
        threshold=threshold,
    )
    put_time = time.monotonic()

    async with _condition:
        if len(_pending) >= max_size:
            put_event.set()
            logger.warning(
                "File pleine (max=%s), requête %s [%s] refusée model=%s",
                max_size, request_id, user_id, body.get("model", ""),
            )
            log_rejection(
                request_id=request_id,
                user_id=user_id,
                model=body.get("model", "") or "—",
                status="503",
                error_detail=f"Queue full (max={max_size})",
            )
            raise ValueError("Queue full")
        heapq.heappush(_pending, _HeapItem(priority=priority, put_time=put_time, item=item))
        _queue_stats["size"] = len(_pending)
        _condition.notify()
    put_event.set()
    logger.debug("Requête %s [%s] mise en file (priorité=%s, taille=%s)", request_id, user_id, priority, len(_pending))
    return item
