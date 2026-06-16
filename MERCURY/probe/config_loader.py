"""Chargement de la config depuis probe/config.yaml."""
import logging
from pathlib import Path
from typing import Any, Optional

import yaml

_PROBE_ROOT = Path(__file__).resolve().parent
_config: dict = {}
_logger = logging.getLogger("probe")


def _default_lmstudio_logs_dir() -> Path:
    home = Path.home()
    return home / ".lmstudio" / "server-logs"


def load_config(config_path: Optional[Path] = None) -> dict:
    global _config
    if config_path is None:
        config_path = _PROBE_ROOT / "config.yaml"
    try:
        with open(config_path) as f:
            _config = yaml.safe_load(f) or {}
    except FileNotFoundError:
        _config = {}
    _config.setdefault("host", "0.0.0.0")
    _config.setdefault("port", 9090)
    _config.setdefault("log_source", "tail")
    # Ollama (optionnel) : si défini, la probe interroge cette URL (ex. http://localhost:11434) pour /api/ps
    if "ollama_url" not in _config:
        _config["ollama_url"] = ""
    # Répertoire des logs Ollama. Défini seulement si ollama_url ou ollama_logs_dir est configuré.
    ollama_logs = (_config.get("ollama_logs_dir") or "").strip()
    ollama_url = (_config.get("ollama_url") or "").strip()
    if ollama_logs:
        p = Path(ollama_logs)
        _config["_ollama_logs_path"] = p if p.is_absolute() else _PROBE_ROOT / p
    elif ollama_url:
        _config["_ollama_logs_path"] = Path.home() / ".ollama" / "logs"
    else:
        _config["_ollama_logs_path"] = None
    _config.setdefault("stats_interval_seconds", 2)
    _config.setdefault("sse_heartbeat_seconds", 5)
    _config.setdefault("scan_tail_lines", 500)

    logs_dir = (_config.get("lmstudio_logs_dir") or "").strip()
    if logs_dir:
        p = Path(logs_dir)
        # Chemin relatif → résoudre par rapport au répertoire de la probe (pas CWD)
        resolved = p if p.is_absolute() else _PROBE_ROOT / p
    else:
        resolved = _default_lmstudio_logs_dir()
    _config["_lmstudio_logs_path"] = resolved

    # Diagnostic : avertir si le répertoire est absent ou vide
    if not resolved.exists():
        _logger.warning(
            "Répertoire logs LM Studio introuvable : %s\n"
            "  → Vérifiez 'lmstudio_logs_dir' dans config.yaml.\n"
            "  → Si LM Studio tourne sous un autre user, utilisez le chemin absolu\n"
            "    (ex. lmstudio_logs_dir: \"~/.lmstudio/server-logs\").",
            resolved,
        )
    else:
        log_files = list(resolved.rglob("*.log"))
        if not log_files:
            _logger.warning(
                "Aucun fichier .log dans %s — les stats LM Studio resteront null.",
                resolved,
            )

    return _config


def get_config() -> dict:
    return _config


def get(key: str, default: Any = None) -> Any:
    return _config.get(key, default)
