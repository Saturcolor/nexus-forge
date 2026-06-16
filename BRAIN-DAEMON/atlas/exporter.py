"""DEPRECATED — l'export GGUF est maintenant fait en C++ natif.

Voir `llama-extract-vector` dans atomic-llama-cpp-turboquant fork. Le binaire
écrit directement le .gguf au path donné via --output. Le wrapper Python n'a
plus besoin de toucher au format GGUF.

Le contrat de schéma GGUF (compatible llama.cpp --control-vector) reste
documenté dans BRAIN-DAEMON/atlas/README.md et memory/project_atlasmind.md.

Ce fichier est conservé en stub pour ne pas casser les imports historiques.
La fonction `detect_model_hint` reste valide et a déménagé dans extractor.py.
"""
from __future__ import annotations

from atlas.extractor import detect_model_hint  # noqa: F401 — re-export for back-compat


def export_gguf(*args, **kwargs):
    raise NotImplementedError(
        "atlas.exporter.export_gguf a été déplacé en C++ dans "
        "llama-extract-vector. Le binaire écrit directement au --output path. "
        "Pour le format de référence Python (regression test), voir "
        "ATLASMIND/poc/extract_vector.py:export_gguf."
    )
