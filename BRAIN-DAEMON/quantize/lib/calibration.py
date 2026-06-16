"""Wrapper pour build-calibration.py (corpus builder).

NOTE Phase 1 : ce module est un placeholder. Le builder vit toujours dans
build-calibration.py qui est utilisable en CLI direct. La factorisation
process_corpus(...) en fonction lib avec progress_cb est planifiée Phase 7
(quand on câblera le job calibration_build côté brain-daemon + AtlasMind).

Pour le moment on expose juste un loader dynamique du module pour que
`brain-daemon.quantize.routes` puisse référencer le path du script et
spawner build-calibration.py en subprocess comme le TUI le fait.
"""
from __future__ import annotations

from pathlib import Path

from .paths import SCRIPT_DIR

BUILD_CALIBRATION_SCRIPT = SCRIPT_DIR / "build-calibration.py"
"""Chemin absolu vers le script CLI build-calibration.py."""


def calibration_script_exists() -> bool:
    return BUILD_CALIBRATION_SCRIPT.exists()
