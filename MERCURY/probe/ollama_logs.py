"""
Lecture réactive des logs Ollama : état dérivé (activité, durée requête, loading).
Fichier par défaut : ~/.ollama/logs/server.log
Format [GIN] : [GIN] 2025/04/09 - 20:34:14 | 200 | 82.985212ms | 127.0.0.1 | POST "/api/chat"
"""
import collections
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger("probe")

_state: Dict[str, Any] = {
    "model_loading": False,
    "loading_progress": None,
    "last_activity_ts": None,
    "last_request_duration_seconds": None,
    "last_request_path": None,
}
_lock = threading.Lock()

# [GIN] 2025/04/09 - 20:34:14 | 200 | 82.985212ms | 127.0.0.1 | POST "/api/chat"
# ou Duration: 5.217641542s
RE_GIN = re.compile(
    r"\[GIN\]\s+\d{4}/\d{2}/\d{2}\s+-\s+\d{2}:\d{2}:\d{2}\s+\|\s+\d+\s+\|\s+([\d.]+)(ms|s)\s+\|\s+\S+\s+\|\s+(GET|POST)\s+\"([^\"]+)\""
)
# msg="waiting for llama runner" / "llama runner started in X seconds"
RE_WAITING = re.compile(r"msg=\"waiting for llama runner", re.I)
RE_RUNNER_STARTED = re.compile(r"msg=\"llama runner started in ([\d.]+) seconds\"", re.I)
RE_LOADED = re.compile(r"msg=\"loaded runners\"", re.I)
RE_SERVER_LISTENING = re.compile(r"msg=\"Server listening on", re.I)


def get_state() -> Dict[str, Any]:
    """Retourne une copie de l'état actuel (dernier parsing)."""
    with _lock:
        return _state.copy()


def _parse_line(line: str) -> None:
    """Extrait les infos pertinentes d'une ligne de log. Met à jour _state sous _lock."""
    with _lock:
        # [GIN] : POST /api/chat ou /api/generate → durée + activité
        m = RE_GIN.search(line)
        if m:
            duration_val = float(m.group(1))
            unit = m.group(2)
            method = m.group(3)
            path = m.group(4)
            if method == "POST" and path in ("/api/chat", "/api/generate"):
                if unit == "ms":
                    _state["last_request_duration_seconds"] = round(duration_val / 1000.0, 3)
                else:
                    _state["last_request_duration_seconds"] = round(duration_val, 3)
                _state["last_activity_ts"] = time.time()
                _state["last_request_path"] = path
            return
        # INFO : loading / loaded
        if RE_WAITING.search(line):
            _state["model_loading"] = True
            _state["loading_progress"] = "loading"
        m = RE_RUNNER_STARTED.search(line)
        if m:
            _state["model_loading"] = False
            _state["loading_progress"] = "loaded"
        if RE_LOADED.search(line) or RE_SERVER_LISTENING.search(line):
            _state["model_loading"] = False
            if _state.get("loading_progress") == "loading":
                _state["loading_progress"] = "loaded"


def _latest_log_file(logs_dir: Path) -> Optional[Path]:
    """Retourne server.log ou le fichier .log le plus récent dans le répertoire."""
    if not logs_dir.exists():
        return None
    primary = logs_dir / "server.log"
    if primary.exists():
        return primary
    try:
        logs = sorted(logs_dir.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        return logs[0] if logs else None
    except OSError:
        return None


def _tail_loop(logs_path: Path, scan_tail_lines: int = 500) -> None:
    """Thread: suit server.log et parse chaque nouvelle ligne."""
    current_path: Optional[Path] = None
    while True:
        if logs_path.is_file():
            path = logs_path
        else:
            path = _latest_log_file(logs_path)
        if path and path != current_path:
            current_path = path
            logger.info("Ollama log: suivi de %s", current_path)
        if current_path and current_path.exists():
            try:
                with open(current_path, "r", encoding="utf-8", errors="replace") as f:
                    if scan_tail_lines > 0:
                        tail_lines = collections.deque(f, maxlen=scan_tail_lines)
                        for tl in tail_lines:
                            _parse_line(tl.rstrip())
                    f.seek(0, 2)
                    while True:
                        line = f.readline()
                        if line:
                            _parse_line(line.rstrip())
                        else:
                            time.sleep(0.15)
            except (OSError, IOError) as e:
                logger.debug("Ollama tail: %s", e)
                current_path = None
        time.sleep(1)


def start_log_reader(logs_path: Path, scan_tail_lines: int = 500) -> threading.Thread:
    """Démarre la lecture des logs Ollama dans un thread. Retourne le thread (déjà démarré)."""
    def run():
        _tail_loop(logs_path, scan_tail_lines)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t
