"""Routes /stats/* — stats systeme + logs LM Studio/Ollama (ex-probe)."""
import asyncio
import json
import logging
import time
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from stats.system_stats import collect_system_stats
from stats.lmstudio_logs import get_state as get_lmstudio_state, start_log_reader as start_lmstudio_reader
from stats.ollama_logs import get_state as get_ollama_log_state, start_log_reader as start_ollama_reader
from stats.ollama_stats import get_ollama_state

logger = logging.getLogger("brain-daemon")
router = APIRouter()

# Config stats (initialisee par init_stats)
_stats_config: dict = {}
_initialized = False


def init_stats(config: dict):
    """Initialise les lecteurs de logs depuis la config consolidee.
    Appeler une seule fois au startup du daemon."""
    global _stats_config, _initialized
    if _initialized:
        return
    _initialized = True

    stats_cfg = config.get("stats", {})
    _stats_config.update(stats_cfg)

    # LM Studio logs
    lmstudio_logs_dir = (stats_cfg.get("lmstudio_logs_path") or "").strip()
    if lmstudio_logs_dir:
        logs_path = Path(lmstudio_logs_dir)
    else:
        logs_path = Path.home() / ".lmstudio" / "server-logs"

    log_source = stats_cfg.get("log_source", "tail")
    scan_tail_lines = int(stats_cfg.get("scan_tail_lines", 500))

    if logs_path.exists():
        start_lmstudio_reader(logs_path, log_source, scan_tail_lines)
        logger.info("Stats: LM Studio log reader demarre (source=%s, path=%s)", log_source, logs_path)
    else:
        logger.info("Stats: LM Studio logs introuvables (%s), reader non demarre", logs_path)

    # Ollama logs
    ollama_logs_path = (stats_cfg.get("ollama_logs_path") or "").strip()
    ollama_url = (stats_cfg.get("ollama_url") or "").strip()
    if ollama_logs_path:
        p = Path(ollama_logs_path)
        start_ollama_reader(p, scan_tail_lines)
        logger.info("Stats: Ollama log reader demarre (path=%s)", p)
    elif ollama_url:
        default_path = Path.home() / ".ollama" / "logs"
        if default_path.exists():
            start_ollama_reader(default_path, scan_tail_lines)
            logger.info("Stats: Ollama log reader demarre (default path=%s)", default_path)


@router.get("")
@router.get("/")
async def stats():
    """Stats systeme + dernier etat LM Studio/Ollama."""
    system = collect_system_stats()
    lmstudio = get_lmstudio_state()
    lmstudio_public = {k: v for k, v in lmstudio.items() if k != "recent_events" or v}
    payload = {"system": system, "lmstudio": lmstudio_public}

    ollama_url = (_stats_config.get("ollama_url") or "").strip()
    ollama_logs_path = (_stats_config.get("ollama_logs_path") or "").strip()
    if ollama_url or ollama_logs_path:
        ollama_data = await get_ollama_state(ollama_url) if ollama_url else {}
        log_state = get_ollama_log_state() if ollama_logs_path else {}
        payload["ollama"] = {**ollama_data, **log_state}

    return JSONResponse(content=payload)


@router.get("/stream")
async def stats_stream():
    """SSE : mises a jour en quasi temps reel (systeme + lmstudio + ollama)."""
    interval = max(0.5, float(_stats_config.get("interval_seconds", 2)))
    heartbeat = max(1, float(_stats_config.get("sse_heartbeat_seconds", 5)))
    ollama_url = (_stats_config.get("ollama_url") or "").strip()
    ollama_logs_path = (_stats_config.get("ollama_logs_path") or "").strip()

    async def generate():
        last_sent = None
        last_heartbeat = 0.0
        while True:
            system = collect_system_stats()
            lmstudio = get_lmstudio_state()
            lmstudio_public = {k: v for k, v in lmstudio.items() if k != "recent_events" or v}
            payload = {"system": system, "lmstudio": lmstudio_public}
            if ollama_url or ollama_logs_path:
                ollama_data = await get_ollama_state(ollama_url) if ollama_url else {}
                log_state = get_ollama_log_state() if ollama_logs_path else {}
                payload["ollama"] = {**ollama_data, **log_state}
            now = time.time()
            try:
                data = json.dumps(payload, ensure_ascii=False)
                if data != last_sent:
                    yield f"data: {data}\n\n"
                    last_sent = data
                elif now - last_heartbeat >= heartbeat:
                    yield f"data: {data}\n\n"
                    last_heartbeat = now
            except Exception as e:
                logger.debug("SSE send: %s", e)
            await asyncio.sleep(interval)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
