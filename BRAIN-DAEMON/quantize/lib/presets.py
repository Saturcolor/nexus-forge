"""Registry des presets de quantization.

Source of truth pour les presets CANONIQUES : `config.yaml` (champ `quants:`).
Les presets CUSTOM (créés via Surgical Builder UI) sont persistés côté
AtlasMind DB ; brain-daemon ne les stocke pas mais accepte n'importe quel
PresetSpec dans le payload de `/quant/jobs`.

Fonctions clés :
    list_canonical(cfg)              → list de presets bruts de config.yaml
    get_canonical(cfg, name)         → preset par nom
    normalize_preset(raw, source_top_type) → injecte source_top_type pour quantize.run

Estimation taille :
    estimate_quant_bytes(f16_bytes, preset_dict) → bytes estimés
"""
from __future__ import annotations

from typing import Any, Optional


# Fallback ratios si un preset n'a pas de size_ratio explicite dans config.yaml.
# Port direct de brain-quant.py:150.
_FALLBACK_SIZE_RATIO: dict[str, float] = {
    "F16": 1.0, "BF16": 1.0,
    "Q8_0": 0.53, "Q8_K": 0.53,
    "Q6_K": 0.41, "Q5_K_M": 0.34, "Q4_K_M": 0.28,
    "Q3_K_M": 0.22, "IQ3_XXS": 0.17,
}


def estimate_quant_bytes(f16_bytes: int, preset: dict[str, Any]) -> int:
    """Estime la taille du quant produit à partir du F16 source.

    Prio 1 : size_ratio déclaré dans le preset (config.yaml)
    Prio 2 : fallback sur le type de base (Q8_0, Q6_K, etc.)
    Prio 3 : 0.5 par défaut (devrait ne jamais arriver)
    """
    ratio = preset.get("size_ratio")
    if ratio is None:
        ratio = _FALLBACK_SIZE_RATIO.get(preset.get("base", ""), 0.5)
    return int(f16_bytes * float(ratio))


def list_canonical(cfg: dict) -> list[dict[str, Any]]:
    """Retourne la liste des presets canoniques bruts.

    Ordre = ordre dans config.yaml = ordre d'affichage dans le TUI / UI.
    """
    return list(cfg.get("quants", []))


def get_canonical(cfg: dict, name: str) -> Optional[dict[str, Any]]:
    """Cherche un preset par nom dans config.yaml. Retourne None si absent."""
    for q in cfg.get("quants", []):
        if q.get("name") == name:
            return q
    return None


def default_canonical_names(cfg: dict) -> set[str]:
    """Set des presets avec `default: true` dans config.yaml — préselection TUI/UI."""
    return {q["name"] for q in cfg.get("quants", []) if q.get("default")}


def normalize_preset(raw: dict[str, Any], source_top_type: str = "F16") -> dict[str, Any]:
    """Prépare un preset pour quantize.build_quantize_overrides() / run_quantize().

    Injecte `source_top_type` (utilisé par le builder pour décider
    --allow-requantize et le type cible des embeddings).

    Retourne une COPIE — ne mute pas l'original.
    """
    out = dict(raw)
    out.setdefault("source_top_type", source_top_type)
    return out
