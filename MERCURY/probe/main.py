#!/usr/bin/env python3
"""
Probe LM Studio - Stats système + logs en temps réel.
À installer sur la machine qui héberge LM Studio.
Usage: python main.py  ou  uvicorn main:app --host 0.0.0.0 --port 9090
"""
import asyncio
import json
import logging
import sys
from pathlib import Path

# Ajouter le répertoire probe au path
PROBE_ROOT = Path(__file__).resolve().parent
if str(PROBE_ROOT) not in sys.path:
    sys.path.insert(0, str(PROBE_ROOT))

from config_loader import get_config, load_config
from lmstudio_logs import get_state, start_log_reader
from ollama_logs import get_state as get_ollama_log_state, start_log_reader as start_ollama_log_reader
from ollama_stats import get_ollama_state
from system_stats import collect_system_stats

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("probe")

try:
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse, Response, StreamingResponse
    from contextlib import asynccontextmanager
except ImportError:
    logger.error("Installez les dépendances: pip install -r requirements.txt")
    sys.exit(1)

_config_loaded = False


@asynccontextmanager
async def lifespan(app):
    global _config_loaded
    config_path = PROBE_ROOT / "config.yaml"
    load_config(config_path)
    cfg = get_config()
    _config_loaded = True
    logs_path = cfg.get("_lmstudio_logs_path", PROBE_ROOT)
    log_source = cfg.get("log_source", "tail")
    scan_tail_lines = int(cfg.get("scan_tail_lines", 500))
    start_log_reader(logs_path, log_source, scan_tail_lines)
    ollama_logs_path = cfg.get("_ollama_logs_path")
    if ollama_logs_path is not None:
        start_ollama_log_reader(ollama_logs_path, scan_tail_lines)
        logger.info("Probe démarrée (log_source=%s, logs_path=%s, ollama_logs=%s)", log_source, logs_path, ollama_logs_path)
    else:
        logger.info("Probe démarrée (log_source=%s, logs_path=%s)", log_source, logs_path)
    yield


app = FastAPI(title="Probe LM Studio", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health():
    """Liveness."""
    return {"status": "ok"}


@app.get("/stats")
async def stats():
    """Stats système + dernier état dérivé des logs LM Studio (réactif) + optionnellement Ollama."""
    system = collect_system_stats()
    lmstudio = get_state()
    # Nettoyer les clés internes pour l'API
    lmstudio_public = {k: v for k, v in lmstudio.items() if k != "recent_events" or v}
    payload = {"system": system, "lmstudio": lmstudio_public}
    cfg = get_config()
    ollama_url = (cfg.get("ollama_url") or "").strip()
    if ollama_url or cfg.get("_ollama_logs_path"):
        ollama_data = await get_ollama_state(ollama_url) if ollama_url else {}
        log_state = get_ollama_log_state() if cfg.get("_ollama_logs_path") else {}
        payload["ollama"] = {**ollama_data, **log_state}
    return JSONResponse(content=payload)


@app.get("/stats/stream")
async def stats_stream():
    """SSE : envoie des mises à jour en quasi temps réel (système + lmstudio)."""
    cfg = get_config()
    interval = max(0.5, float(cfg.get("stats_interval_seconds", 2)))
    heartbeat = max(1, float(cfg.get("sse_heartbeat_seconds", 5)))

    async def generate():
        last_sent = None
        last_heartbeat = 0.0
        import time
        ollama_url = (cfg.get("ollama_url") or "").strip()
        ollama_logs_path = cfg.get("_ollama_logs_path")
        while True:
            system = collect_system_stats()
            lmstudio = get_state()
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


def main():
    config_path = PROBE_ROOT / "config.yaml"
    if not config_path.exists() and (PROBE_ROOT / "config.yaml.example").exists():
        import shutil
        shutil.copy(PROBE_ROOT / "config.yaml.example", config_path)
        logger.info("config.yaml créé depuis config.yaml.example")
    load_config(config_path)
    cfg = get_config()
    host = cfg.get("host", "0.0.0.0")
    port = int(cfg.get("port", 9090))
    import uvicorn
    logger.info("Démarrage probe sur %s:%s", host, port)
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
