"""Resolveur de chemins centralisé.

Tous les chemins du module quantize sont dérivés de config.yaml. Avant ce module,
chaque entry point (brain-quant.py, inspect-imatrix.py, build-calibration.py)
ré-implémentait son `resolve_path()`. On factorise ici pour avoir une source
de vérité unique.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent.parent
"""Dossier `BRAIN-DAEMON/quantize/` (parent du lib/)."""


def resolve_path(p: str, base: Path = SCRIPT_DIR) -> Path:
    """Expand ~/$VAR (en utilisant le home du run_as_user si configuré, sinon
    le home du process courant), puis si relatif → relatif à `base`.

    Sous le daemon root + run_as_user configuré, `~/` doit pointer vers
    <home du run_as_user> et pas /root/. On résout `~` manuellement via pwd.getpwnam
    pour ne pas dépendre de l'env HOME (qui est celui du daemon root).
    """
    from . import toolbox as tb   # import local pour éviter cycle au boot

    expanded = os.path.expandvars(p)
    # Expand explicite de ~ avec le home du run_as_user (sinon Path.expanduser
    # utilise $HOME qui est /root sous le daemon).
    if expanded.startswith("~"):
        if tb._RUN_AS_USER:
            try:
                import pwd
                home = pwd.getpwnam(tb._RUN_AS_USER).pw_dir
                # "~" → home ; "~/foo" → home + "/foo". Les deux cas via [1:].
                expanded = home + expanded[1:]
            except (KeyError, ImportError):
                expanded = os.path.expanduser(expanded)
        else:
            expanded = os.path.expanduser(expanded)

    path = Path(expanded)
    if not path.is_absolute():
        path = (base / path).resolve()
    return path


@dataclass(frozen=True)
class QuantPaths:
    """Set complet des chemins dérivés de config.yaml.

    Construit via QuantPaths.from_config(cfg). Tous absolus, expanduser-resolved.
    """
    models_path: Path
    output_dir: Path        # = models_path / output_subdir (ex: ~/.lmstudio/models/mercury)
    calib_dir: Path
    imatrix_dir: Path
    script_dir: Path = SCRIPT_DIR

    @classmethod
    def from_config(cls, cfg: dict) -> "QuantPaths":
        models_path = resolve_path(cfg["models_path"])
        output_subdir = cfg.get("output_subdir", "mercury")
        return cls(
            models_path=models_path,
            output_dir=models_path / output_subdir,
            calib_dir=resolve_path(cfg["calibration_dir"]),
            imatrix_dir=resolve_path(cfg["imatrix_dir"]),
        )
