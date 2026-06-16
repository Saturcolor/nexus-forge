"""
Lecture réactive des logs LM Studio : état en mémoire mis à jour en continu.
Permet d'afficher en quasi temps réel chargement du modèle et prompt processing.
"""
import collections
import logging
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("probe")

# État dérivé des logs (mis à jour par le thread de lecture)
_state: Dict[str, Any] = {
    "model_loading": False,
    "loading_progress": None,
    "last_task_id": None,
    "last_prompt_tokens": None,
    "last_prompt_eval_seconds": None,
    "last_generation_tokens": None,
    "last_generation_tokens_per_second": None,
    "last_activity_ts": None,
    "recent_events": [],
}
_lock = threading.Lock()

# Patterns alignés sur le format réel LM Studio (logs ~/.lmstudio/server-logs)
# Ex: [INFO] Prompt processing progress: 40.9% | slot ... task 3167 | task.n_tokens = 30575
#     prompt eval time = 1565.41 ms /   866 tokens (  1.81 ms per token, 553.21 tokens per second)
#            eval time = 12550.24 ms /  481 tokens ( 26.09 ms per token,  38.33 tokens per second)
RE_CHECKPOINT = re.compile(r"context checkpoint (\d+) of (\d+)", re.I)
RE_CREATED_CHECKPOINT = re.compile(r"created context checkpoint (\d+) of (\d+)", re.I)
RE_TASK_N_TOKENS = re.compile(r"task\.n_tokens\s*=\s*(\d+)", re.I)
RE_TASK_NUM = re.compile(r"task\s+(\d+)", re.I)
RE_PROMPT_PROGRESS_PCT = re.compile(r"Prompt processing progress:\s*(\d+\.?\d*)%", re.I)
RE_PROMPT_PROGRESS_DONE = re.compile(r"prompt processing done, n_tokens\s*=\s*(\d+)", re.I)
RE_PROMPT_EVAL_MS = re.compile(r"prompt eval time\s*=\s*(\d+\.?\d*)\s*ms", re.I)
RE_LOADING = re.compile(r"loading model|load_model:\s*loading model", re.I)
RE_LOADED = re.compile(r"model (?:loaded|ready)|loaded (?:model|context)|all slots are idle", re.I)
# Ligne "eval time" (génération) — NE matche PAS "prompt eval time"
# Ex: "       eval time =   12550.24 ms /   481 tokens (   26.09 ms per token,    38.33 tokens per second)"
RE_EVAL_LINE = re.compile(
    r"^\s*eval time\s*=\s*(\d+\.?\d*)\s*ms\s*/\s*(\d+)\s*tokens?\s*\(\s*[\d.]+\s*ms per token,\s*(\d+\.?\d*)\s*tokens?\s+per\s+second",
    re.I,
)


def get_state() -> Dict[str, Any]:
    """Retourne une copie de l'état actuel (dernier parsing)."""
    with _lock:
        return _state.copy()


def _parse_line(line: str) -> Optional[Dict[str, Any]]:
    """Extrait les infos pertinentes d'une ligne de log. Met à jour _state sous _lock."""
    event = None
    with _lock:
        # Context checkpoint (prompt processing) : "created context checkpoint 18 of 32"
        for pat in (RE_CREATED_CHECKPOINT, RE_CHECKPOINT):
            m = pat.search(line)
            if m:
                current, total = int(m.group(1)), int(m.group(2))
                _state["model_loading"] = current < total
                _state["loading_progress"] = f"{current}/{total}"
                event = {"type": "checkpoint", "current": current, "total": total}
                break
        # Chargement du modèle
        if RE_LOADING.search(line):
            _state["model_loading"] = True
            _state["loading_progress"] = "loading"
            event = {"type": "loading"}
        if RE_LOADED.search(line):
            _state["model_loading"] = False
            if "all slots are idle" in line:
                _state["loading_progress"] = "idle"
            else:
                _state["loading_progress"] = "loaded"
            event = {"type": "loaded"}
        # Prompt processing progress: 40.9%
        m = RE_PROMPT_PROGRESS_PCT.search(line)
        if m:
            _state["loading_progress"] = f"{m.group(1)}%"
            event = {"type": "prompt_progress", "percent": m.group(1)}
        # prompt processing done, n_tokens = 30575
        m = RE_PROMPT_PROGRESS_DONE.search(line)
        if m:
            _state["last_prompt_tokens"] = int(m.group(1))
            _state["loading_progress"] = "100%"
            event = {"type": "prompt_done", "tokens": int(m.group(1))}
        # task.n_tokens = 30575 (source fiable pour le total prompt)
        if RE_TASK_NUM.search(line):
            tm = RE_TASK_NUM.search(line)
            if tm:
                _state["last_task_id"] = tm.group(1)
        if RE_TASK_N_TOKENS.search(line):
            m = RE_TASK_N_TOKENS.search(line)
            if m:
                _state["last_prompt_tokens"] = int(m.group(1))
                event = {"type": "task_tokens", "tokens": int(m.group(1))}
        # prompt eval time = 1565.41 ms (vitesse de prefill — n'alimente PAS generation_tokens_per_second)
        m = RE_PROMPT_EVAL_MS.search(line)
        if m:
            try:
                _state["last_prompt_eval_seconds"] = round(float(m.group(1)) / 1000.0, 2)
            except (ValueError, IndexError):
                pass
        # eval time = X ms / N tokens (... Y tokens per second) — génération uniquement
        # Captures: group(1)=ms, group(2)=token_count, group(3)=tokens_per_second
        m = RE_EVAL_LINE.match(line)
        if m:
            try:
                _state["last_generation_tokens"] = int(m.group(2))
                _state["last_generation_tokens_per_second"] = float(m.group(3))
                event = {"type": "generation_done", "tokens": int(m.group(2)), "tps": float(m.group(3))}
            except (ValueError, IndexError):
                pass
        if event:
            _state["last_activity_ts"] = time.time()
            evlist: List[Dict[str, Any]] = _state.get("recent_events", [])
            _state["recent_events"] = (evlist + [event])[-50:]
    return event


def _latest_log_file(logs_dir: Path) -> Optional[Path]:
    """Retourne le fichier .log le plus récent (répertoire racine LM Studio = ~/.lmstudio/server-logs, avec sous-dirs 2026-03/...)."""
    if not logs_dir.exists():
        return None
    try:
        # Logs peuvent être à la racine ou dans des sous-dirs (ex. 2026-03/2026-03-11.2.log)
        logs = sorted(logs_dir.rglob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        return logs[0] if logs else None
    except OSError:
        return None


def _tail_loop(logs_dir: Path, scan_tail_lines: int = 500) -> None:
    """Thread: suit le dernier fichier .log et parse chaque nouvelle ligne.

    Au démarrage, relit les 'scan_tail_lines' dernières lignes du fichier pour
    pré-remplir l'état (évite d'avoir stats=null après redémarrage de la probe).
    """
    current_path: Optional[Path] = None
    while True:
        latest = _latest_log_file(logs_dir)
        if latest and latest != current_path:
            current_path = latest
            logger.info("Suivi du log: %s", current_path)
        if current_path and current_path.exists():
            try:
                with open(current_path, "r", encoding="utf-8", errors="replace") as f:
                    # Scan des dernières lignes pour pré-remplir l'état
                    if scan_tail_lines > 0:
                        tail_lines = collections.deque(f, maxlen=scan_tail_lines)
                        for tl in tail_lines:
                            _parse_line(tl.rstrip())
                    # Seek en fin de fichier pour le tail temps réel
                    f.seek(0, 2)
                    while True:
                        line = f.readline()
                        if line:
                            _parse_line(line.rstrip())
                        else:
                            time.sleep(0.15)
            except (OSError, IOError) as e:
                logger.debug("Tail lecture: %s", e)
                current_path = None
        time.sleep(1)


def _cli_loop(logs_dir: Path, scan_tail_lines: int = 0) -> None:
    """Thread: lance 'lms log stream --source server' et parse stdout."""
    while True:
        try:
            proc = subprocess.Popen(
                ["lms", "log", "stream", "--source", "server"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=str(logs_dir) if logs_dir.exists() else None,
            )
            if proc.stdout:
                for line in proc.stdout:
                    _parse_line(line.rstrip())
            proc.wait()
        except FileNotFoundError:
            logger.warning("Commande 'lms' introuvable. Utilisez log_source: tail ou installez LM Studio CLI.")
        except Exception as e:
            logger.warning("lms log stream erreur: %s", e)
        time.sleep(2)


def start_log_reader(logs_path: Path, log_source: str, scan_tail_lines: int = 500) -> threading.Thread:
    """Démarre la lecture réactive des logs dans un thread. Retourne le thread (déjà démarré)."""
    def run():
        if log_source == "cli":
            _cli_loop(logs_path, scan_tail_lines)
        else:
            _tail_loop(logs_path, scan_tail_lines)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t
