"""Re-export du module gguf_stats existant sous le namespace lib.

gguf_stats.py est déjà bien isolé (lecture header GGUF, support sharded).
On l'expose ici pour que les imports lib.gguf soient cohérents avec le reste.
"""
from __future__ import annotations

import sys
from pathlib import Path

# gguf_stats vit dans le parent de lib/ (BRAIN-DAEMON/quantize/gguf_stats.py).
# Pour permettre les deux modes d'usage (TUI lance depuis BRAIN-DAEMON/quantize/
# avec PYTHONPATH local, daemon lance depuis BRAIN-DAEMON/ avec PYTHONPATH parent),
# on s'assure que le dossier parent est dans sys.path.
_PARENT = Path(__file__).resolve().parent.parent
if str(_PARENT) not in sys.path:
    sys.path.insert(0, str(_PARENT))

from gguf_stats import (  # noqa: E402  (after sys.path tweak)
    GGUFHeader,
    GGUFTensor,
    family_of,
    group_by_family,
    read_gguf_header,
    read_gguf_header_sharded,
)

__all__ = [
    "GGUFHeader",
    "GGUFTensor",
    "family_of",
    "group_by_family",
    "read_gguf_header",
    "read_gguf_header_sharded",
]
