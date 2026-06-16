"""Loader + validateur de config.yaml.

Avant ce module, brain-quant.py:732-783 portait load_config() + validate_config()
en interne. On factorise pour que brain-daemon puisse charger la même config
sans dupliquer la logique.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import yaml

from .paths import SCRIPT_DIR

CONFIG_PATH = SCRIPT_DIR / "config.yaml"

_REQUIRED_CONFIG_KEYS = ("models_path", "output_subdir", "calibration_dir", "imatrix", "quants")
_REQUIRED_IMATRIX_KEYS = ("chunks", "ctx", "batch", "ngl")


class ConfigError(ValueError):
    """Levée quand config.yaml est manquante / malformée."""


def validate_config(cfg: Any) -> None:
    """Vérifie les clés minimales et les types. Raise ConfigError si KO.

    Identique à brain-quant.py:732 mais émet des exceptions au lieu de
    console.print + sys.exit (le TUI shell peut catcher et formatter).
    """
    if not isinstance(cfg, dict):
        raise ConfigError("racine doit être un mapping")

    missing = [k for k in _REQUIRED_CONFIG_KEYS if k not in cfg]
    if missing:
        raise ConfigError(f"clés manquantes : {', '.join(missing)}")

    if not isinstance(cfg["imatrix"], dict):
        raise ConfigError("`imatrix` doit être un mapping")
    missing_im = [k for k in _REQUIRED_IMATRIX_KEYS if k not in cfg["imatrix"]]
    if missing_im:
        raise ConfigError(f"`imatrix.*` clés manquantes : {', '.join(missing_im)}")

    if not isinstance(cfg["quants"], list) or not cfg["quants"]:
        raise ConfigError("`quants` doit être une liste non vide")

    seen_names: set[str] = set()
    for i, q in enumerate(cfg["quants"]):
        if not isinstance(q, dict) or "name" not in q or "base" not in q:
            raise ConfigError(f"quants[{i}] doit avoir `name` et `base`")
        if q["name"] in seen_names:
            raise ConfigError(f"quant name dupliqué : {q['name']}")
        seen_names.add(q["name"])


def load_config(path: Path = CONFIG_PATH) -> dict:
    """Lit config.yaml, valide, retourne le dict.

    Raise ConfigError si fichier absent / YAML malformé / validation KO.
    Le TUI wrap dans un try/except pour formatter le message d'erreur ;
    le daemon laisse remonter (HTTP 500 si config bouge sous ses pieds).
    """
    if not path.exists():
        raise ConfigError(f"config introuvable : {path}")
    try:
        with open(path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
    except yaml.YAMLError as exc:
        raise ConfigError(f"YAML malformé : {exc}") from exc
    validate_config(cfg)
    return cfg
