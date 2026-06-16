"""DEPRECATED — la logique diff-of-means + linear probe est maintenant en C++ natif.

Voir `llama-extract-vector` dans atomic-llama-cpp-turboquant fork. Le wrapper
Python `extractor.py` ne fait plus que spawn subprocess et parse stdout NDJSON.

Ce fichier est conservé en stub pour ne pas casser les imports historiques
éventuels. Les fonctions ci-dessous lèvent NotImplementedError — pas de code
mort qui pourrait diverger silencieusement du C++.

La référence Python du calcul vit dans `ATLASMIND/poc/extract_vector.py`
(regression test : cosine_similarity Py↔C++ ≥ 0.95).
"""
from __future__ import annotations


def diff_of_means(*args, **kwargs):
    raise NotImplementedError(
        "atlas.compute.diff_of_means a été déplacé en C++ dans "
        "llama-extract-vector. Pour le calcul de référence Python (regression "
        "test), voir ATLASMIND/poc/extract_vector.py:compute_direction_diff_of_means."
    )


def linear_probe_accuracy(*args, **kwargs):
    raise NotImplementedError(
        "atlas.compute.linear_probe_accuracy a été déplacé en C++ dans "
        "llama-extract-vector. Pour la référence Python, voir "
        "ATLASMIND/poc/extract_vector.py:linear_probe_accuracy."
    )
