"""
Persistance dans un fichier JSON unique (data/db.json).
Regroupe les données persistées (ex. modèles LM Studio on/off seulement, settings).
"""
import atexit
import copy
import json
import logging
import os
import queue
import tempfile
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parent.parent
_DB_DIR = _ROOT / "data"
_DB_FILE = _DB_DIR / "db.json"
_LEGACY_FILE = _ROOT / "lm_studio_on_off_only.json"

_db: dict = {}
_lock = threading.Lock()

# Clés de config.yaml qui peuvent être stockées en DB (éditables depuis le dashboard, persistées)
SETTINGS_KEYS = frozenset({
    "debug",
    "debug_full_json",
    "admin_accept_user_api_key",
    "require_api_key",
    "ollama_enabled",
    "ollama_auto_pull",
    "ollama_proxy_only",
    "ollama_url",
    "mlx_enabled",
    "mlx_url",
    "lm_studio_enabled",
    "lm_studio_url",
    "lm_studio_proxy_only",
    "lm_studio_reasoning",
    "lm_studio_session_init_enabled",
    "lm_studio_session_init_prompt",
    "llamacpp_enabled",
    "llamacpp_url",
    "vllm_enabled",
    "vllm_url",
    "lucebox_enabled",
    "lucebox_url",
    "models_cache_ttl_seconds",
    "backend_timeout",
    "queue_max_size",
    "queue_timeout_seconds",
    "openrouter_enabled",
    "openrouter_fallback_force",
    "openrouter_fallback_model",
    "openrouter_vision_model",
    "openrouter_reasoning_model",
    "openrouter_http_referer",
    "openrouter_title",
    "anthropic_enabled",
    "anthropic_fallback_model",
    "anthropic_credentials_file",
    "anthropic_reasoning_model",
    "fallback_providers_order",
    "stateful_responses_enabled",
    "stateful_responses_ttl_seconds",
    "stateful_responses_send_max_age_seconds",
    "stateful_responses_session_header",
    # NOTE: lm_studio_probe_url / ollama_probe_url / lmstudio_logs_dir /
    # ollama_logs_dir retirés (probe Mercury archivée, stats désormais
    # exposées par brain-daemon). Le service `probe/` est conservé dans le
    # repo pour archive mais n'est plus consommé par l'API admin.
    "auto_priority_enabled",
    "anonymous_priority",
    "health_check_timeout",
    "max_retry_on_fallback",
    "log_retention_days",
    "server_host",
    "server_port",
    "priority_threshold_enabled",
    "priority_threshold_seconds",
    "cloud_bypass_queue",
    "toolcall15_enabled",
    "toolcall15_url",
    "bugfind15_enabled",
    "bugfind15_url",
    "audio_openai_enabled",
    "audio_groq_enabled",
    "audio_elevenlabs_enabled",
    "audio_default_stt_provider",
    "audio_default_tts_provider",
    "audio_elevenlabs_voice_map",
    "audio_local_enabled",
    "audio_local_url",
    "realtime_enabled",
    # Atlas (extraction de control vectors via brain-daemon /atlas/*)
    "atlas_enabled",
    "atlas_brain_url",
    "atlas_atlasmind_url",
    "atlas_atlasmind_api_key",
    "atlas_timeout_sec",
    # Quant (proxy vers brain-daemon /quant/*)
    "quant_enabled",
    "quant_brain_url",
    "quant_timeout_sec",
    "quant_cartography_timeout_sec",
    "quant_stream_timeout_sec",
    "quant_allowed_routes",
    # Embeddings fallback (cascade local→cloud, dict complet)
    "embedding_fallback_triggers",
})

# Source de vérité UNIQUE des settings brain par défaut (thermal/mémoire/perf).
# Référencé par _DEFAULT_DB ci-dessous ET retourné par get_brain_settings() en
# fallback : un seul littéral pour éviter que deux jeux de seuils thermiques
# divergent (bug audité : 75/90 dans _DEFAULT_DB vs 65/85 ici).
# Valeurs alignées sur le brain-daemon (config.yaml + thermal/controller.py :
# throttle_start_c=75, throttle_full_c=90). NE PAS désaligner.
DEFAULT_BRAIN_SETTINGS = {
    "thermal_auto_start": False,
    "perf_mode": None,  # "performance" | "optimized" | "eco" | None (pas de changement au boot)
    "thermal_thresholds": {
        "throttle_start_c": 75,
        "throttle_full_c": 90,
        "emergency_c": 95,
        "resume_c": 60,
    },
    "memory_auto_start": False,
    "memory_thresholds": {
        "ram_warn_percent": 85,
        "ram_evict_percent": 93,
        "ram_emergency_percent": 96,
        "swap_flush_percent": 50,
    },
}


def _deepcopy_brain_settings() -> dict:
    """Copie profonde des settings brain par défaut (sous-dicts indépendants)."""
    return copy.deepcopy(DEFAULT_BRAIN_SETTINGS)


_DEFAULT_DB = {
    "version": 1,
    "lm_studio_on_off_only": {"models": []},
    "settings": {},
    "users": None,
    "model_mapping": None,
    "model_routes": None,
    "provider_priority": None,
    "model_priority": None,
    # Catégorisation UI (tag) par modèle, persistée pour trier/organiser le dashboard.
    # Clé = nom canonique tel que présent dans le cache admin (ex: "ollama/llama3:8b").
    "model_categories": {},
    # Ordre d'affichage des catégories (tags) tel que créé/ajouté.
    "model_category_order": [],
    # Indique si un modèle Ollama a été créé avec un TEMPLATE dans son Modelfile.
    # Clé = nom canonique du modèle tel que présent dans le cache admin (ex: "ollama/llama3:8b").
    "ollama_template_configured_by_model": {},
    "llamacpp_templates": {},
    # Model schedules (cron load/unload with exclusive slots)
    "model_schedules": {},
    "active_slot": None,
    "schedule_run_history": [],
    # Settings brain-daemon (thermal, perf, etc.) persistés côté Mercury et poussés au brain au boot.
    # Deep-copy de la source de vérité unique (cf. DEFAULT_BRAIN_SETTINGS) pour ne pas partager
    # les sous-dicts mutables entre la constante et l'état DB.
    "brain_settings": _deepcopy_brain_settings(),
}

DEFAULT_LLAMACPP_TEMPLATE = {
    "load": {
        "ctx_size": 32768,
        "n_gpu_layers": 999,
        "flash_attn": True,
        "no_mmap": True,
        "ctx_shift": True,
        "parallel": 1,
        "unified_kv_cache": False,
        "mlock": True,                # Force le modèle à rester en RAM (pas de page-out), utile quand RAM >> modèle
        "cache_ram": 0,               # --cache-ram MiB : limite du prompt cache host. 0 = désactivé (workaround bug Gemma-4)
        "ctx_checkpoints": 1,         # --ctx-checkpoints N : snapshots SWA pendant le PP. 1 = minimum (workaround bug Gemma-4 RAM bloat)
        "cache_idle_slots": False,    # false → --no-cache-idle-slots (redondant avec kv_cache_auto_dump)
        "extra_args": [],
        "kv_cache_auto_dump": False,  # Auto-save KV à l'unload, auto-restore au load
        "backend": "native-vulkan",   # Backend GPU : "native-vulkan" (binaire natif host, défaut) | "vulkan" (llama-vulkan-radv, toolbox) | "rocm" (llama-rocm-7.2, toolbox)
    },
    "defaults": {
        "cache_prompt": True,   # Active le KV cache côté llama-server (évite le re-processing du prompt)
    },
}


def load_db() -> dict:
    """Charge le fichier DB (ou structure vide si absent). Migration depuis l'ancien JSON si présent."""
    global _db
    with _lock:
        try:
            if _DB_FILE.exists():
                raw = _DB_FILE.read_text(encoding="utf-8")
                _db = json.loads(raw)
                if not isinstance(_db, dict):
                    _db = dict(_DEFAULT_DB)
                if "settings" not in _db or not isinstance(_db["settings"], dict):
                    _db["settings"] = {}
                # Migration : ajout des nouvelles clés persistées.
                if "model_categories" not in _db or not isinstance(_db["model_categories"], dict):
                    _db["model_categories"] = {}
                if "model_category_order" not in _db or not isinstance(_db["model_category_order"], list):
                    _db["model_category_order"] = []
                if "ollama_template_configured_by_model" not in _db or not isinstance(_db["ollama_template_configured_by_model"], dict):
                    _db["ollama_template_configured_by_model"] = {}
                for key in ("users", "model_mapping", "model_routes", "provider_priority", "model_priority"):
                    if key not in _db:
                        _db[key] = None
            else:
                _db = dict(_DEFAULT_DB)

            # Migration depuis l'ancien fichier lm_studio_on_off_only.json
            if _LEGACY_FILE.exists():
                try:
                    legacy_raw = _LEGACY_FILE.read_text(encoding="utf-8")
                    legacy_data = json.loads(legacy_raw)
                    legacy_models = legacy_data.get("models") or []
                    if legacy_models:
                        key = "lm_studio_on_off_only"
                        if key not in _db or not isinstance(_db[key], dict):
                            _db[key] = {"models": []}
                        existing = set(_db[key].get("models") or [])
                        for m in legacy_models:
                            if m and m not in existing:
                                existing.add(m)
                        _db[key]["models"] = sorted(existing)
                        _save_db()
                    _LEGACY_FILE.unlink()
                except Exception as e:
                    logger.warning("Migration lm_studio_on_off_only: %s", e)
        except Exception as e:
            logger.warning("Impossible de charger db.json: %s", e)
            _db = dict(_DEFAULT_DB)
        return _db


# --- File d'écriture disque mono-consommateur (sérialise les writes) ---
#
# AUDIT FIX (fire-and-forget out-of-order writes) : auparavant chaque _save_db
# déportait l'écriture via loop.run_in_executor(None, ...). Le ThreadPoolExecutor
# par défaut a PLUSIEURS workers et n'ordonne PAS les tâches : deux saves rapprochés
# du même fichier pouvaient s'exécuter en parallèle et le os.replace de l'ancien
# snapshot écrasait le plus récent → perte de données silencieuse.
#
# Solution : une file FIFO drainée par UN SEUL thread writer dédié. Les writes
# s'appliquent donc strictement dans l'ordre de soumission, tout en restant
# non-bloquants pour l'appelant (simple enqueue). On ne garde que le dernier état
# sérialisé (l'image JSON complète), donc l'ordre = la dernière soumission gagne.
_write_queue: "queue.Queue[str]" = queue.Queue()
_writer_thread: threading.Thread | None = None
_writer_lock = threading.Lock()


def _writer_worker() -> None:
    """Boucle du thread writer : draine la file et écrit sur disque, FIFO, un à la fois."""
    while True:
        data = _write_queue.get()
        try:
            _write_db_to_disk(data)
        except Exception as e:  # noqa: BLE001 — on ne tue jamais le writer sur une erreur ponctuelle
            logger.warning("db writer: échec écriture db.json: %s", e)
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
            target=_writer_worker, name="db-writer", daemon=True
        )
        _writer_thread.start()
        logger.info("db writer: thread mono-consommateur démarré (sérialisation des writes)")


def _save_db() -> None:
    """Persiste le dict _db dans data/db.json (appelé sous _lock).
    Écriture atomique : écrit dans un fichier temporaire puis rename (POSIX atomique).
    L'écriture disque est sérialisée via une file FIFO drainée par un thread unique
    (cf. _writer_worker) : non-bloquant pour l'appelant + ordre de soumission garanti."""
    try:
        _DB_DIR.mkdir(parents=True, exist_ok=True)
        data = json.dumps(_db, ensure_ascii=False, indent=2)
        _ensure_writer()
        _write_queue.put(data)
    except Exception as e:
        logger.warning("Impossible de sauver db.json: %s", e)


def _flush_writes(timeout: float = 5.0) -> None:
    """Attend que tous les writes en attente soient appliqués (best-effort).
    Branché sur atexit pour ne pas perdre le dernier save quand le thread daemon
    serait tué net à la sortie de l'interpréteur. queue.join() n'accepte pas de
    timeout → on le déporte dans un thread et on attend via un Event borné."""
    try:
        if _writer_thread is None or not _writer_thread.is_alive():
            return
        done = threading.Event()
        t = threading.Thread(
            target=lambda: (_write_queue.join(), done.set()),
            name="db-writer-flush",
            daemon=True,
        )
        t.start()
        if not done.wait(timeout):
            logger.warning("db writer: flush timeout (%.1fs), writes potentiellement non appliqués", timeout)
    except Exception as e:  # noqa: BLE001
        logger.warning("db writer: flush échoué: %s", e)


atexit.register(_flush_writes)


def _write_db_to_disk(data: str) -> None:
    """Écriture atomique effective (tourne dans le thread writer)."""
    fd, tmp_path = tempfile.mkstemp(dir=str(_DB_DIR), suffix=".tmp", prefix="db_")
    closed = False
    try:
        os.write(fd, data.encode("utf-8"))
        os.fsync(fd)
        os.close(fd)
        closed = True
        os.replace(tmp_path, str(_DB_FILE))
    except Exception:
        if not closed:
            os.close(fd)
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def get_lm_studio_on_off_only_models() -> set:
    """Retourne l'ensemble des model ids (on/off seulement)."""
    with _lock:
        key = "lm_studio_on_off_only"
        if key not in _db or not isinstance(_db[key], dict):
            return set()
        return set(_db[key].get("models") or [])


def add_lm_studio_on_off_only(model_id: str, model: str) -> None:
    """Enregistre un modèle comme n'acceptant que on/off (après 400 LM Studio) et persiste."""
    with _lock:
        key = "lm_studio_on_off_only"
        if key not in _db or not isinstance(_db[key], dict):
            _db[key] = {"models": []}
        models = _db[key].get("models") or []
        added = False
        if model_id and model_id not in models:
            models.append(model_id)
            added = True
        if model and model != model_id and model not in models:
            models.append(model)
            added = True
        if added:
            _db[key]["models"] = sorted(set(models))
            _save_db()
            logger.info(
                "LM Studio: modèle marqué on/off seulement (après 400): model_id=%s, model=%s",
                model_id,
                model,
            )


def is_lm_studio_on_off_only(model_id: str, model: str) -> bool:
    """True si le modèle est connu (config ou découvert) comme n'acceptant que on/off."""
    s = get_lm_studio_on_off_only_models()
    return (model_id in s) or (model in s)


# --- Settings (options migrées depuis config.yaml, priorité DB) ---


def _normalize_setting_value(value):
    """Normalise une valeur de setting pour garantir la compatibilité JSON."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if value is None or value == "":
        return value if value == "" else None
    if isinstance(value, (list, dict)):
        return value  # Sérialisable JSON tel quel — ne pas convertir en str
    return str(value)


def get_settings() -> dict:
    """Retourne le dictionnaire des options stockées en DB (override config.yaml)."""
    with _lock:
        s = _db.get("settings")
        if not isinstance(s, dict):
            return {}
        return dict(s)


def set_setting(key: str, value) -> None:
    """Enregistre une option en DB (clé doit être dans SETTINGS_KEYS). Persiste immédiatement."""
    if key not in SETTINGS_KEYS:
        return
    with _lock:
        if "settings" not in _db or not isinstance(_db["settings"], dict):
            _db["settings"] = {}
        _db["settings"][key] = _normalize_setting_value(value)
        _save_db()


def set_settings(updates: dict) -> None:
    """Enregistre plusieurs options en DB. Persiste une seule fois."""
    if not updates:
        return
    with _lock:
        if "settings" not in _db or not isinstance(_db["settings"], dict):
            _db["settings"] = {}
        for key, value in updates.items():
            if key not in SETTINGS_KEYS:
                continue
            _db["settings"][key] = _normalize_setting_value(value)
        _save_db()


# --- Users (clés API utilisateur), model_mapping, model_routes ---


def get_users():
    """Liste des users (list of dict avec api_key, user_id, priority). None = utiliser config.yaml."""
    with _lock:
        val = _db.get("users")
        if val is None or isinstance(val, list):
            return val if val is not None else None
        return None


def set_users(users: list) -> None:
    """Enregistre la liste des users en DB. Persiste immédiatement."""
    with _lock:
        _db["users"] = _json_safe_list_of_dicts(users) if users else []
        _save_db()


def get_model_mapping():
    """Mapping nom canonique -> {backend, backend_model_id, ...}. None = utiliser config.yaml."""
    with _lock:
        val = _db.get("model_mapping")
        if val is None or isinstance(val, dict):
            return val if val is not None else None
        return None


def set_model_mapping(mapping: dict) -> None:
    """Enregistre le model_mapping en DB. Persiste immédiatement."""
    with _lock:
        _db["model_mapping"] = _json_safe_dict(mapping) if mapping else {}
        _save_db()


def get_model_routes():
    """Règles de routage (list of {pattern, backend}). None = utiliser config.yaml."""
    with _lock:
        val = _db.get("model_routes")
        if val is None or isinstance(val, list):
            return val if val is not None else None
        return None


def set_model_routes(routes: list) -> None:
    """Enregistre les model_routes en DB. Persiste immédiatement."""
    with _lock:
        _db["model_routes"] = _json_safe_list_of_dicts(routes) if routes else []
        _save_db()


def get_provider_priority():
    """
    Ordre de priorité des backends pour le mode auto (1 = premier choix).
    Retourne une liste de noms de backends (ex. ["ollama", "lm_studio", "mlx", "openrouter"]) ou None.
    """
    with _lock:
        val = _db.get("provider_priority")
        if isinstance(val, list) and all(isinstance(x, str) for x in val):
            return list(val)
        return None


def set_provider_priority(order: list) -> None:
    """Enregistre l'ordre de priorité des backends (liste de noms). Persiste immédiatement."""
    with _lock:
        _db["provider_priority"] = [str(x) for x in order] if order else []
        _save_db()


def get_model_priority():
    """
    Ordre de priorité des modèles par backend pour le mode auto.
    Retourne un dict {backend: [model_name, ...]} (ex. {"ollama": ["ollama/llama3.2:1b"], "lm_studio": [...]}) ou None.
    Ancien format (liste) ignoré pour compatibilité.
    """
    with _lock:
        val = _db.get("model_priority")
        if not isinstance(val, dict):
            return None
        out = {}
        for k, v in val.items():
            if isinstance(v, (list, tuple)) and all(isinstance(x, str) for x in v):
                out[str(k)] = list(v)
        return out if out else None


def set_model_priority(order_by_backend: dict) -> None:
    """Enregistre l'ordre de priorité des modèles par backend. Persiste immédiatement."""
    with _lock:
        if not order_by_backend or not isinstance(order_by_backend, dict):
            _db["model_priority"] = {}
        else:
            _db["model_priority"] = {
                str(k): [str(x) for x in v if x]
                for k, v in order_by_backend.items()
                if isinstance(v, (list, tuple))
            }
        _save_db()


def get_hidden_models():
    """
    Retourne l'ensemble des noms de modèles masqués (ex. ollama/llama3, lm_studio/...).
    Les modèles masqués n'apparaissent pas dans la priorité auto et ne comptent pas dans la liste de priorité.
    """
    with _lock:
        val = _db.get("hidden_models")
        if isinstance(val, list) and all(isinstance(x, str) for x in val):
            return set(str(x).strip() for x in val if x)
        return set()


def set_hidden_models(model_names: list) -> None:
    """Enregistre la liste des modèles masqués. Persiste immédiatement."""
    with _lock:
        _db["hidden_models"] = [str(x).strip() for x in (model_names or []) if x]
        _save_db()


def get_unload_protected_models() -> set:
    """Ensemble des noms de modèles (backend/model_id) protégés de l'unload_all
    du scheduler. Un modèle protégé n'est jamais déchargé par un schedule (start
    ou end) — ex. garder l'embedding résident pendant une Night Shift pour que
    /v1/embeddings ne tombe pas en 503."""
    with _lock:
        val = _db.get("unload_protected_models")
        if isinstance(val, list) and all(isinstance(x, str) for x in val):
            return set(str(x).strip() for x in val if x)
        return set()


def set_unload_protected_models(model_names: list) -> None:
    """Enregistre la liste des modèles protégés de l'unload. Persiste immédiatement."""
    with _lock:
        _db["unload_protected_models"] = [str(x).strip() for x in (model_names or []) if x]
        _save_db()


def get_model_categories() -> dict:
    """
    Retourne un dict {model_name: category} (category absente si non assignée).
    model_name suit le format du cache admin (ex. "ollama/llama3:8b", "llamacpp/qwen2.5:14b").
    """
    with _lock:
        val = _db.get("model_categories")
        if not isinstance(val, dict):
            return {}
        out = {}
        for k, v in val.items():
            if not isinstance(k, str):
                continue
            if v is None:
                continue
            if isinstance(v, str):
                vv = v.strip()
                if vv:
                    out[k] = vv
        return out


def get_model_category_order() -> list:
    """Retourne l'ordre d'affichage des catégories (tags)."""
    with _lock:
        val = _db.get("model_category_order")
        if isinstance(val, list) and all(isinstance(x, str) for x in val):
            return [x.strip() for x in val if x and isinstance(x, str)]
        return []


def set_model_category(model_name: str, category: str | None) -> None:
    """
    Assigne (ou retire) une catégorie à un modèle.
    - Si category est None ou chaîne vide => suppression de l'assignation.
    - Ajoute automatiquement la catégorie à la liste d'ordre si absente.
    """
    m = (model_name or "").strip()
    if not m:
        return

    cat: str | None = None
    if category is not None:
        if isinstance(category, str):
            cat = category.strip()
        else:
            cat = str(category).strip()
        if not cat:
            cat = None

    with _lock:
        current = _db.get("model_categories")
        if not isinstance(current, dict):
            current = {}

        if cat is None:
            current.pop(m, None)
            _db["model_categories"] = current
            _save_db()
            return

        current[m] = cat

        order = _db.get("model_category_order")
        if not isinstance(order, list):
            order = []
        if cat not in order:
            order.append(cat)

        _db["model_categories"] = current
        _db["model_category_order"] = order
        _save_db()


def get_ollama_template_configured_by_model() -> dict:
    """
    Retourne un dict { "ollama/<name>": bool }.
    """
    with _lock:
        val = _db.get("ollama_template_configured_by_model")
        if not isinstance(val, dict):
            return {}
        out: dict[str, bool] = {}
        for k, v in val.items():
            if not isinstance(k, str):
                continue
            if isinstance(v, bool):
                out[k] = v
        return out


def set_ollama_template_configured(model_name: str, configured: bool) -> None:
    """Enregistre/supprime l'information "TEMPLATE présent" pour un modèle Ollama."""
    m = (model_name or "").strip()
    if not m:
        return
    with _lock:
        current = _db.get("ollama_template_configured_by_model")
        if not isinstance(current, dict):
            current = {}
        if configured:
            current[m] = True
        else:
            current.pop(m, None)
        _db["ollama_template_configured_by_model"] = current
        _save_db()


# --- Llamacpp templates ---


def get_llamacpp_templates() -> dict:
    """Retourne tous les templates llamacpp : {model_id: {"load": {...}, "defaults": {...}}}.

    Deepcopy via _json_safe_dict pour isoler les callers : backend.py mute son
    copie du dict (pop des clés Mercury-internal comme thinking_budget_*) avant
    de forward au llama-server. Sans copy, ces mutations corrompent le dict en
    mémoire de la DB et finissent persistées au prochain _save_db().
    """
    with _lock:
        val = _db.get("llamacpp_templates")
        if not isinstance(val, dict):
            return {}
        return {k: _json_safe_dict(v) if isinstance(v, dict) else v for k, v in val.items()}


def get_llamacpp_template(model_id: str) -> dict | None:
    """Retourne le template pour un modèle donné, ou None si absent.

    Deepcopy via _json_safe_dict — voir get_llamacpp_templates() pour le détail.
    """
    with _lock:
        val = _db.get("llamacpp_templates")
        if not isinstance(val, dict):
            return None
        tmpl = val.get(model_id)
        if tmpl is None:
            return None
        if not isinstance(tmpl, dict):
            return tmpl
        return _json_safe_dict(tmpl)


def set_llamacpp_template(model_id: str, template: dict) -> None:
    """Enregistre ou met à jour le template d'un modèle. Persiste immédiatement."""
    with _lock:
        if "llamacpp_templates" not in _db or not isinstance(_db["llamacpp_templates"], dict):
            _db["llamacpp_templates"] = {}
        _db["llamacpp_templates"][model_id] = _json_safe_dict(template)
        _save_db()


def delete_llamacpp_template(model_id: str) -> bool:
    """Supprime le template d'un modèle. Retourne True si supprimé, False si absent."""
    with _lock:
        templates = _db.get("llamacpp_templates")
        if not isinstance(templates, dict) or model_id not in templates:
            return False
        del templates[model_id]
        _save_db()
        return True


# --- Brain settings (thermal, perf, persistés et poussés au brain-daemon) ---
# NB: DEFAULT_BRAIN_SETTINGS est défini plus haut (source de vérité unique,
# référencée aussi par _DEFAULT_DB) pour éviter la divergence des seuils thermiques.


def get_brain_settings() -> dict:
    """Retourne les settings brain persistés."""
    with _lock:
        val = _db.get("brain_settings")
        if not isinstance(val, dict):
            return dict(DEFAULT_BRAIN_SETTINGS)
        return {**DEFAULT_BRAIN_SETTINGS, **val}


def set_brain_settings(updates: dict) -> dict:
    """Met à jour les settings brain (merge partiel). Persiste immédiatement. Retourne le résultat."""
    with _lock:
        current = _db.get("brain_settings")
        if not isinstance(current, dict):
            current = dict(DEFAULT_BRAIN_SETTINGS)
        for key, value in updates.items():
            if key in ("thermal_thresholds", "memory_thresholds") and isinstance(value, dict):
                existing = current.get(key) or {}
                current[key] = {**existing, **value}
            else:
                current[key] = value
        _db["brain_settings"] = current
        _save_db()
        return dict(current)


# --- Model Schedules (cron load/unload with exclusive slots) ---


def get_schedules() -> dict:
    """Retourne tous les schedules : {schedule_id: {...}}."""
    with _lock:
        val = _db.get("model_schedules")
        if not isinstance(val, dict):
            return {}
        return dict(val)


def get_schedule(schedule_id: str) -> dict | None:
    with _lock:
        val = _db.get("model_schedules")
        if not isinstance(val, dict):
            return None
        return val.get(schedule_id)


def set_schedule(schedule_id: str, data: dict) -> None:
    with _lock:
        if "model_schedules" not in _db or not isinstance(_db["model_schedules"], dict):
            _db["model_schedules"] = {}
        _db["model_schedules"][schedule_id] = _json_safe_dict(data)
        _save_db()


def update_schedule(schedule_id: str, updates: dict) -> dict | None:
    with _lock:
        schedules = _db.get("model_schedules")
        if not isinstance(schedules, dict) or schedule_id not in schedules:
            return None
        current = schedules[schedule_id]
        if not isinstance(current, dict):
            return None
        for k, v in updates.items():
            if isinstance(v, dict) and isinstance(current.get(k), dict):
                current[k] = {**current[k], **v}
            else:
                current[k] = v
        _db["model_schedules"][schedule_id] = _json_safe_dict(current)
        _save_db()
        return dict(current)


def delete_schedule(schedule_id: str) -> bool:
    with _lock:
        schedules = _db.get("model_schedules")
        if not isinstance(schedules, dict) or schedule_id not in schedules:
            return False
        del schedules[schedule_id]
        _save_db()
        return True


def get_active_slot() -> dict | None:
    with _lock:
        val = _db.get("active_slot")
        if not isinstance(val, dict):
            return None
        return dict(val)


def set_active_slot(data: dict) -> None:
    with _lock:
        _db["active_slot"] = _json_safe_dict(data)
        _save_db()


def clear_active_slot() -> None:
    with _lock:
        _db["active_slot"] = None
        _save_db()


def _json_safe_dict(d):
    """Copie dict avec valeurs JSON-serialisables."""
    if not d or not isinstance(d, dict):
        return {}
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out[str(k)] = _json_safe_dict(v)
        elif isinstance(v, (list, tuple)):
            out[str(k)] = _json_safe_list_of_dicts(list(v))
        elif isinstance(v, (bool, int, float, str)) or v is None:
            out[str(k)] = v
        else:
            out[str(k)] = str(v)
    return out


def _json_safe_list_of_dicts(lst):
    """Liste JSON-serialisable (dicts ou primitives)."""
    if not lst or not isinstance(lst, list):
        return []
    result = []
    for x in lst:
        if isinstance(x, dict):
            result.append(_json_safe_dict(x))
        elif isinstance(x, (bool, int, float, str)) or x is None:
            result.append(x)
        # else: skip non-serializable items silently
    return result
