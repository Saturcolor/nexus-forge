"""
Persistance benchmark dans un fichier JSON dédié (data/benchmark.json).
Séparé de db.json pour ne pas polluer la DB principale avec les données de bench.
"""
import atexit
import json
import logging
import os
import queue
import tempfile
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).resolve().parent
_BENCH_FILE = _DATA_DIR / "benchmark.json"

_bench: dict = {}
_lock = threading.Lock()

_DEFAULT = {
    "models": {},      # {model_id: {display_name, architecture, params_b, quant, ...}}
    "results": [],     # [{id, timestamp, model_id, preset_id, metrics..., rating...}, ...]
    "conv_templates": {},  # {template_id: {name, system_prompt, questions: [str]}}
}


def load_benchmark_db() -> dict:
    """Charge benchmark.json (ou structure vide si absent)."""
    global _bench
    with _lock:
        try:
            logger.info("benchmark_db: loading from %s (exists=%s, abs=%s)", _BENCH_FILE, _BENCH_FILE.exists(), _BENCH_FILE.resolve())
            if _BENCH_FILE.exists():
                raw = _BENCH_FILE.read_text(encoding="utf-8")
                _bench = json.loads(raw)
                logger.info("benchmark_db: loaded %d results, %d models, %d templates",
                            len(_bench.get("results", [])), len(_bench.get("models", {})), len(_bench.get("conv_templates", {})))
                if not isinstance(_bench, dict):
                    _bench = json.loads(json.dumps(_DEFAULT))
                if "models" not in _bench or not isinstance(_bench["models"], dict):
                    _bench["models"] = {}
                if "results" not in _bench or not isinstance(_bench["results"], list):
                    _bench["results"] = []
                if "conv_templates" not in _bench or not isinstance(_bench["conv_templates"], dict):
                    _bench["conv_templates"] = {}
            else:
                logger.info("benchmark_db: file not found, starting fresh")
                _bench = json.loads(json.dumps(_DEFAULT))
        except Exception as e:
            logger.warning("benchmark_db: failed to load: %s", e)
            _bench = json.loads(json.dumps(_DEFAULT))
        return _bench


# --- File d'écriture disque mono-consommateur (sérialise les writes) ---
#
# AUDIT FIX (fire-and-forget out-of-order writes) : loop.run_in_executor(None, ...)
# utilise un ThreadPoolExecutor multi-workers non ordonné → deux saves rapprochés
# du même fichier pouvaient s'appliquer dans le désordre, l'ancien snapshot écrasant
# le récent (perte de données silencieuse). On sérialise via une file FIFO drainée
# par UN seul thread writer : ordre de soumission garanti, appelant non bloquant.
_write_queue: "queue.Queue[str]" = queue.Queue()
_writer_thread: threading.Thread | None = None
_writer_lock = threading.Lock()


def _writer_worker() -> None:
    """Boucle du thread writer : draine la file et écrit sur disque, FIFO, un à la fois."""
    while True:
        data = _write_queue.get()
        try:
            _write_to_disk(data)
        except Exception as e:  # noqa: BLE001 — ne jamais tuer le writer sur une erreur ponctuelle
            logger.warning("benchmark_db writer: échec écriture benchmark.json: %s", e)
        finally:
            _write_queue.task_done()


def _ensure_writer() -> None:
    """Démarre paresseusement le thread writer (daemon) une seule fois."""
    global _writer_thread
    if _writer_thread is not None and _writer_thread.is_alive():
        return
    with _writer_lock:
        if _writer_thread is not None and _writer_thread.is_alive():
            return
        _writer_thread = threading.Thread(
            target=_writer_worker, name="benchmark-db-writer", daemon=True
        )
        _writer_thread.start()
        logger.info("benchmark_db writer: thread mono-consommateur démarré (sérialisation des writes)")


def _save() -> None:
    """Persiste _bench dans benchmark.json (appelé sous _lock). Écriture atomique.
    Sérialisée via une file FIFO drainée par un thread unique (cf. _writer_worker) :
    non-bloquant pour l'appelant + ordre de soumission garanti."""
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        data = json.dumps(_bench, ensure_ascii=False, indent=2)
        _ensure_writer()
        _write_queue.put(data)
    except Exception as e:
        logger.warning("Impossible de sauver benchmark.json: %s", e)


def _flush_writes(timeout: float = 5.0) -> None:
    """Attend (best-effort, borné) que les writes en attente soient appliqués.
    Branché sur atexit pour ne pas perdre le dernier save à la sortie (thread daemon)."""
    try:
        if _writer_thread is None or not _writer_thread.is_alive():
            return
        done = threading.Event()
        t = threading.Thread(
            target=lambda: (_write_queue.join(), done.set()),
            name="benchmark-db-writer-flush",
            daemon=True,
        )
        t.start()
        if not done.wait(timeout):
            logger.warning("benchmark_db writer: flush timeout (%.1fs), writes potentiellement non appliqués", timeout)
    except Exception as e:  # noqa: BLE001
        logger.warning("benchmark_db writer: flush échoué: %s", e)


atexit.register(_flush_writes)


def _write_to_disk(data: str) -> None:
    """Écriture atomique effective (tourne dans le thread writer)."""
    fd, tmp_path = tempfile.mkstemp(dir=str(_DATA_DIR), suffix=".tmp", prefix="bench_")
    closed = False
    try:
        os.write(fd, data.encode("utf-8"))
        os.fsync(fd)
        os.close(fd)
        closed = True
        os.replace(tmp_path, str(_BENCH_FILE))
    except Exception:
        if not closed:
            os.close(fd)
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _json_safe(v):
    """Rend une valeur JSON-serialisable."""
    if isinstance(v, dict):
        return {str(k): _json_safe(val) for k, val in v.items()}
    if isinstance(v, (list, tuple)):
        return [_json_safe(x) for x in v]
    if isinstance(v, (bool, int, float, str)) or v is None:
        return v
    return str(v)


# --- Results ---


def get_results() -> list:
    """Retourne tous les résultats de benchmark."""
    with _lock:
        return list(_bench.get("results") or [])


def add_result(result: dict) -> None:
    """Ajoute un résultat. Persiste immédiatement."""
    with _lock:
        if not isinstance(_bench.get("results"), list):
            _bench["results"] = []
        _bench["results"].append(_json_safe(result))
        _save()


def update_result(result_id: str, updates: dict) -> bool:
    """Met à jour un résultat par id. Retourne True si trouvé."""
    with _lock:
        results = _bench.get("results")
        if not isinstance(results, list):
            return False
        for r in results:
            if r.get("id") == result_id:
                for k, v in updates.items():
                    if k != "id":
                        r[k] = _json_safe(v)
                _save()
                return True
        return False


def delete_result(result_id: str) -> bool:
    """Supprime un résultat par id. Retourne True si trouvé."""
    with _lock:
        results = _bench.get("results")
        if not isinstance(results, list):
            return False
        before = len(results)
        _bench["results"] = [r for r in results if r.get("id") != result_id]
        if len(_bench["results"]) < before:
            _save()
            return True
        return False


# --- Models metadata ---


def get_models() -> dict:
    """Retourne les métadonnées modèles : {model_id: {...}}."""
    with _lock:
        return dict(_bench.get("models") or {})


def set_model(model_id: str, data: dict) -> None:
    """Enregistre ou met à jour les métadonnées d'un modèle."""
    with _lock:
        if not isinstance(_bench.get("models"), dict):
            _bench["models"] = {}
        _bench["models"][model_id] = _json_safe(data)
        _save()


def delete_model(model_id: str) -> bool:
    """Supprime les métadonnées d'un modèle. Retourne True si trouvé."""
    with _lock:
        models = _bench.get("models")
        if not isinstance(models, dict) or model_id not in models:
            return False
        del models[model_id]
        _save()
        return True


# --- Conversation templates ---


def get_conv_templates() -> dict:
    with _lock:
        return dict(_bench.get("conv_templates") or {})


def set_conv_template(template_id: str, data: dict) -> None:
    with _lock:
        if not isinstance(_bench.get("conv_templates"), dict):
            _bench["conv_templates"] = {}
        _bench["conv_templates"][template_id] = _json_safe(data)
        _save()


def delete_conv_template(template_id: str) -> bool:
    with _lock:
        tpl = _bench.get("conv_templates")
        if not isinstance(tpl, dict) or template_id not in tpl:
            return False
        del tpl[template_id]
        _save()
        return True
