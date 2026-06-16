"""Surgical preset emitter — génère des presets quantize à partir des stats imatrix.

Stratégies :
  - cumulative (2tier/3tier/4tier) : tri global par sum_values, tiers cumulés.
    Pertinent pour modèles dense (Llama, Qwen, Phi, Mistral).
  - per_family (surgical-light/surgical/surgical-xl) : top X% par famille
    de tensors + pins F16 fixes (norms + routers MoE). Recommandé pour MoE
    (Gemma-4, Mixtral, DeepSeek) — garantit que chaque composant conserve
    ses outliers critiques au lieu de favoriser les familles bruyantes.
  - custom : choix explicites du builder UI (family_quants + top-K% bonus).

Pins F16 fixes (norms + routers) appliqués automatiquement par les modes
per_family et custom — quasi-gratuits en taille, désastreux si quantisés bas.

Port direct de inspect-imatrix.py:307-1310.
"""
from __future__ import annotations

import math
import re
from collections import defaultdict
from typing import Any, Union

from .imatrix import TensorStat


# ────────────────────────────────────────────────────────────────────────────
# Architecture (constants — partagés avec lib.imatrix.detect_architecture)
# ────────────────────────────────────────────────────────────────────────────

ARCH_DENSE = "dense"
ARCH_MOE = "moe"
ARCH_HYBRID = "hybrid"


# ────────────────────────────────────────────────────────────────────────────
# Profiles
# ────────────────────────────────────────────────────────────────────────────

PROFILES: dict[str, dict] = {
    # Modes cumulative : tri global par sum desc, cuts = fraction cumulée.
    "2tier": {
        "mode": "cumulative",
        "tiers": [("F16", 0.15)],
        "default_base": "Q8_0",
    },
    "3tier": {
        "mode": "cumulative",
        "tiers": [("F16", 0.05), ("Q8_0", 0.40)],
        "default_base": "Q6_K",
    },
    "4tier": {
        "mode": "cumulative",
        "tiers": [("F16", 0.03), ("Q8_0", 0.20), ("Q6_K", 0.50)],
        "default_base": "Q5_K_M",
    },
    # Modes per_family : stratification par composant + pins F16 fixes.
    "surgical-light": {
        "mode": "per_family",
        "top_per_family": 0.10,
        "default_base": "Q8_0",
    },
    "surgical": {
        "mode": "per_family",
        "top_per_family": 0.20,
        "default_base": "Q8_0",
    },
    "surgical-xl": {
        "mode": "per_family",
        "top_per_family": 0.35,
        "default_base": "Q8_0",
    },
}

# Pins F16 automatiques en mode surgical/custom — tensors critiques pour la
# qualité, quasi-gratuits en taille, désastreux si quantisés bas.
F16_PIN_REGEXES: list[str] = [
    r".+_norm\..*=F16",
    r"ffn_gate_inp\..*=F16",
    r"ffn_gate_inp_shexp\..*=F16",
    r"ssm_alpha\..*=F16",
    r"ssm_beta\..*=F16",
    r"ssm_conv1d\..*=F16",
]


# ────────────────────────────────────────────────────────────────────────────
# Catégories
# ────────────────────────────────────────────────────────────────────────────

CATEGORY_ATTENTION = "attention"
CATEGORY_FFN_DENSE = "ffn_dense"
CATEGORY_FFN_EXPERTS = "ffn_experts"
CATEGORY_FFN_SHARED_EXPERTS = "ffn_shared_experts"
CATEGORY_SSM = "ssm"
CATEGORY_ROUTER = "router"
CATEGORY_NORMS = "norms"
CATEGORY_IO = "io"
CATEGORY_OTHER = "other"

CATEGORY_LABELS: dict[str, str] = {
    CATEGORY_ATTENTION:          "Attention",
    CATEGORY_FFN_DENSE:          "Feed-Forward (dense)",
    CATEGORY_FFN_EXPERTS:        "Feed-Forward (experts MoE)",
    CATEGORY_FFN_SHARED_EXPERTS: "Feed-Forward (shared experts)",
    CATEGORY_SSM:                "SSM (Mamba)",
    CATEGORY_ROUTER:             "Routeur MoE",
    CATEGORY_NORMS:              "Normalizations",
    CATEGORY_IO:                 "Entrée / Sortie",
    CATEGORY_OTHER:              "Divers",
}


# ────────────────────────────────────────────────────────────────────────────
# Family docs (pédagogique pour le builder UI)
# ────────────────────────────────────────────────────────────────────────────

# Doc compacte des familles pour le Custom Builder UI. Format aligné sur ce que
# inspect-imatrix.py portait : (label, category, role, impact, reco). Recos
# conservatives sur prose FR/EN généraliste. Les familles non listées tombent
# sur family_category() pour la catégorie + reco "base".
FAMILY_DOCS: dict[str, dict[str, str]] = {
    # ── Attention ────────────────────────────────────────────────────────
    "attn_k": {
        "label": "Attention · Keys",
        "category": CATEGORY_ATTENTION,
        "role": "Clés d'indexation : chaque token publie une clé pour se faire reconnaître par les autres lors du matching.",
        "impact": "Très critique. Dégrade → tokens se 'voient' mal mutuellement, perte de cohérence long-contexte.",
        "reco": "Q8_0 (sûr) · F16 pour quali max",
    },
    "attn_q": {
        "label": "Attention · Queries",
        "category": CATEGORY_ATTENTION,
        "role": "Questions : ce qu'un token cherche chez les autres pour récupérer l'info pertinente.",
        "impact": "Très critique. Dégrade → perte de focus, réponses hors-sujet.",
        "reco": "Q8_0 (sûr) · F16 pour quali max",
    },
    "attn_v": {
        "label": "Attention · Values",
        "category": CATEGORY_ATTENTION,
        "role": "Contenu transmis quand K/Q matchent. L'info qui circule entre tokens.",
        "impact": "Critique mais moins fragile que K/Q.",
        "reco": "Q8_0 · Q6_K acceptable sur prose",
    },
    "attn_output": {
        "label": "Attention · Output projection",
        "category": CATEGORY_ATTENTION,
        "role": "Reprojette le résultat multi-head vers la dim normale pour transmission FFN.",
        "impact": "Modéré, compensable.",
        "reco": "Q8_0 safe · base OK sur prose",
    },
    "attn_qkv": {
        "label": "Attention · QKV fusionné",
        "category": CATEGORY_ATTENTION,
        "role": "Q/K/V fusionnés (hybrides ATT+SSM). Porte matching + contenu.",
        "impact": "Critique — équivalent à attn_k/q.",
        "reco": "Q8_0 · F16 pour quali max",
    },
    "attn_gate": {
        "label": "Attention · Gate (ATT/SSM)",
        "category": CATEGORY_ATTENTION,
        "role": "Pondère attention vs SSM en hybride. Décide combien passe par chaque branche.",
        "impact": "Critique sur hybride.",
        "reco": "Q8_0 · F16 si budget",
    },
    # ── FFN dense ────────────────────────────────────────────────────────
    "ffn_gate": {
        "label": "FFN · Gate (SwiGLU)",
        "category": CATEGORY_FFN_DENSE,
        "role": "Valve SwiGLU qui décide combien de signal passe dans la FFN.",
        "impact": "Modéré. Robuste à la quant.",
        "reco": "base OK · Q8 si budget",
    },
    "ffn_up": {
        "label": "FFN · Up projection",
        "category": CATEGORY_FFN_DENSE,
        "role": "Projette dans un espace ~4× plus grand (mémoire de travail FFN).",
        "impact": "Modéré. Robuste.",
        "reco": "base OK · Q8 si budget",
    },
    "ffn_down": {
        "label": "FFN · Down projection",
        "category": CATEGORY_FFN_DENSE,
        "role": "Re-projette avec la transformation apprise. Le 'cerveau' de la FFN.",
        "impact": "Plus critique que gate/up.",
        "reco": "Q8_0 recommandé · base acceptable",
    },
    # ── FFN experts MoE ──────────────────────────────────────────────────
    "ffn_gate_exps": {
        "label": "FFN experts · Gate",
        "category": CATEGORY_FFN_EXPERTS,
        "role": "Valve SwiGLU par expert MoE. N experts, 2-8 actifs/token.",
        "impact": "Modéré, dilué par la redondance experts.",
        "reco": "base OK (80% du volume)",
    },
    "ffn_up_exps": {
        "label": "FFN experts · Up",
        "category": CATEGORY_FFN_EXPERTS,
        "role": "Up projection par expert MoE.",
        "impact": "Modéré.",
        "reco": "base OK",
    },
    "ffn_down_exps": {
        "label": "FFN experts · Down",
        "category": CATEGORY_FFN_EXPERTS,
        "role": "Down projection par expert — 'savoir spécialisé' de chaque expert.",
        "impact": "Plus critique que gate/up experts. Mais redondant N experts.",
        "reco": "Q8_0 pour quali · base OK si budget",
    },
    "ffn_gate_up_exps": {
        "label": "FFN experts · Gate+Up fusionné",
        "category": CATEGORY_FFN_EXPERTS,
        "role": "Gate et Up fusionnés (Gemma-4 MoE).",
        "impact": "Modéré.",
        "reco": "base OK",
    },
    # ── Routeur MoE ──────────────────────────────────────────────────────
    "ffn_gate_inp": {
        "label": "Routeur MoE",
        "category": CATEGORY_ROUTER,
        "role": "Décide quel(s) expert(s) activer pour chaque token. Pivot central MoE.",
        "impact": "ULTRA critique. Dégrade → gating erratique, instabilité.",
        "reco": "F16 TOUJOURS (négligeable, impact énorme)",
    },
    "ffn_gate_inp_shexp": {
        "label": "Router shared expert",
        "category": CATEGORY_ROUTER,
        "role": "Routage du shared expert (active relative aux experts routés).",
        "impact": "Critique, minuscule.",
        "reco": "F16 TOUJOURS",
    },
    # ── Norms ────────────────────────────────────────────────────────────
    "attn_norm": {
        "label": "Norm avant attention",
        "category": CATEGORY_NORMS,
        "role": "RMSNorm/LayerNorm avant le bloc d'attention.",
        "impact": "Critique mais tout petit.",
        "reco": "F16 TOUJOURS (négligeable)",
    },
    "ffn_norm": {
        "label": "Norm avant FFN",
        "category": CATEGORY_NORMS,
        "role": "Normalisation avant le bloc FFN.",
        "impact": "Critique mais petit.",
        "reco": "F16 TOUJOURS",
    },
    "attn_k_norm": {
        "label": "Norm sur K",
        "category": CATEGORY_NORMS,
        "role": "Norm spécifique sur les keys (archi récentes).",
        "impact": "Critique, petit.",
        "reco": "F16 TOUJOURS",
    },
    "attn_q_norm": {
        "label": "Norm sur Q",
        "category": CATEGORY_NORMS,
        "role": "Norm spécifique sur les queries (archi récentes).",
        "impact": "Critique, petit.",
        "reco": "F16 TOUJOURS",
    },
    "output_norm": {
        "label": "Norm finale (pré-output)",
        "category": CATEGORY_NORMS,
        "role": "Dernière normalisation avant projection vers vocab.",
        "impact": "Critique, petit.",
        "reco": "F16 TOUJOURS",
    },
    "post_attention_norm": {
        "label": "Norm post-attention (Gemma)",
        "category": CATEGORY_NORMS,
        "role": "Norm après le bloc d'attention (post-norm archi).",
        "impact": "Critique, petit.",
        "reco": "F16 TOUJOURS",
    },
    "post_ffw_norm": {
        "label": "Norm post-FFN (Gemma)",
        "category": CATEGORY_NORMS,
        "role": "Norm après le bloc FFN (post-norm archi).",
        "impact": "Critique, petit.",
        "reco": "F16 TOUJOURS",
    },
    # ── Shared experts ───────────────────────────────────────────────────
    "ffn_gate_shexp": {
        "label": "Shared expert · Gate",
        "category": CATEGORY_FFN_SHARED_EXPERTS,
        "role": "Valve SwiGLU de l'expert commun activé pour TOUS les tokens.",
        "impact": "Modéré. Petit, robuste.",
        "reco": "base OK · Q8 si budget",
    },
    "ffn_up_shexp": {
        "label": "Shared expert · Up",
        "category": CATEGORY_FFN_SHARED_EXPERTS,
        "role": "Up projection du shared expert.",
        "impact": "Modéré.",
        "reco": "base OK",
    },
    "ffn_down_shexp": {
        "label": "Shared expert · Down",
        "category": CATEGORY_FFN_SHARED_EXPERTS,
        "role": "Down projection du shared expert — savoir commun.",
        "impact": "Plus critique que gate/up shared, mais dilué.",
        "reco": "Q8_0 recommandé · base acceptable",
    },
    # ── I/O ──────────────────────────────────────────────────────────────
    "token_embd": {
        "label": "Embedding d'entrée",
        "category": CATEGORY_IO,
        "role": "Token-ID → vecteur d'entrée. Tout passe par ici au début.",
        "impact": "Critique. Dégrade → entrée bruitée, tout en aval souffre.",
        "reco": "F16 (géré par preserve_embeddings)",
    },
    "output": {
        "label": "Projection finale (vocab)",
        "category": CATEGORY_IO,
        "role": "Hidden state final → logits sur vocab. Tout sort par ici.",
        "impact": "Critique. Dégrade → prédictions biaisées.",
        "reco": "F16 (géré par preserve_embeddings)",
    },
    # ── SSM ──────────────────────────────────────────────────────────────
    "ssm_out": {
        "label": "SSM · Output projection",
        "category": CATEGORY_SSM,
        "role": "Projette hidden state SSM vers dim réseau. Cerveau du SSM.",
        "impact": "Le plus critique du SSM.",
        "reco": "Q8_0 · F16 pour quali max",
    },
    "ssm_alpha": {
        "label": "SSM · Alpha (decay)",
        "category": CATEGORY_SSM,
        "role": "Taux de décroissance de la mémoire SSM.",
        "impact": "Critique mais minuscule.",
        "reco": "F16 (négligeable)",
    },
    "ssm_beta": {
        "label": "SSM · Beta (injection)",
        "category": CATEGORY_SSM,
        "role": "Combien du token courant injecté dans la mémoire SSM.",
        "impact": "Critique mais minuscule.",
        "reco": "F16 (négligeable)",
    },
    "ssm_conv1d": {
        "label": "SSM · Conv1D local",
        "category": CATEGORY_SSM,
        "role": "Convolution fenêtre 4 tokens avant injection récurrence.",
        "impact": "Modéré.",
        "reco": "F16 (négligeable)",
    },
    "ssm_dt": {
        "label": "SSM · Delta timestep",
        "category": CATEGORY_SSM,
        "role": "Régule la vitesse de transition d'état SSM.",
        "impact": "Critique, minuscule.",
        "reco": "F32/F16 TOUJOURS",
    },
    "ssm_norm": {
        "label": "SSM · Norm interne",
        "category": CATEGORY_NORMS,
        "role": "Normalisation du hidden state SSM entre pas.",
        "impact": "Critique, minuscule.",
        "reco": "F16 TOUJOURS",
    },
}

_FAMILY_RX = re.compile(r"(?:^|\.)([^.]+)\.(?:weight|bias)$")


def _family_of(tensor_name: str) -> str:
    """Dernier segment avant .weight/.bias. Fallback '_other' si pas de match."""
    m = _FAMILY_RX.search(tensor_name)
    return m.group(1) if m else "_other"


def family_category(family: str) -> str:
    """Catégorie d'une famille (fallback heuristique pour familles inconnues)."""
    doc = FAMILY_DOCS.get(family)
    if doc:
        return doc["category"]
    if family.startswith("attn_") and family.endswith("_norm"):
        return CATEGORY_NORMS
    if "_norm" in family:
        return CATEGORY_NORMS
    if family.startswith("ssm"):
        return CATEGORY_SSM
    if family.startswith("attn"):
        return CATEGORY_ATTENTION
    if "_shexp" in family:
        return CATEGORY_FFN_SHARED_EXPERTS
    if "_exps" in family:
        return CATEGORY_FFN_EXPERTS
    if family.startswith("ffn_gate_inp"):
        return CATEGORY_ROUTER
    if family.startswith("ffn"):
        return CATEGORY_FFN_DENSE
    if family in ("token_embd", "output"):
        return CATEGORY_IO
    return CATEGORY_OTHER


def _regex_escape_tensor(name: str) -> str:
    """Échappe un nom de tensor pour regex exacte (pour tensor-type override)."""
    return re.escape(name)


# ────────────────────────────────────────────────────────────────────────────
# Size estimation
# ────────────────────────────────────────────────────────────────────────────

# Familles toujours préservées (token_embd + output) quand preserve_embeddings=True.
# Source de vérité : brain-quant.py:1511 (TUI), garde l'estimation cohérente
# entre TUI et daemon.
_PRESERVED_FAMILIES = {"token_embd", "output"}


def estimate_preset_size(
    gguf_header: Any,
    preset: dict[str, Any],
    top_type: str = "F16",
) -> tuple[int, int]:
    """Estime (target_bytes, current_bytes) d'un preset appliqué à un GGUF source.

    Applique la même logique de priorité que llama-quantize :
        preserve_embeddings (top_type) → tensor_overrides regex → family_quants
        → base.

    `top_type` = type max disponible depuis la source. F16 pour source F16/BF16,
    Q8_0 pour source Q8_0 (sinon le bonus "F16" promu retomberait sur Q8_0).

    Port direct de brain-quant.py:_estimate_preset_size — version simplifiée
    (pas de preserved_f16_names car AtlasMind n'expose pas Q8_K_P sources).
    """
    base = preset.get("base", "Q8_0")
    preserve_embeddings = bool(preset.get("preserve_embeddings", True))
    tensor_overrides = preset.get("tensor_overrides") or []
    family_quants = preset.get("family_quants") or {}

    # Compile les overrides une fois (regex "PATTERN=TYPE")
    compiled_overrides: list[tuple[re.Pattern, str]] = []
    for rule in tensor_overrides:
        if "=" not in rule:
            continue
        pat, qtype = rule.rsplit("=", 1)
        try:
            compiled_overrides.append((re.compile(pat), qtype))
        except re.error:
            continue

    total_target = 0
    total_current = 0
    for t in gguf_header.tensors:
        fam = _family_of(t.name)
        target_type: str | None = None

        # 1) preserve_embeddings (top_type)
        if preserve_embeddings and fam in _PRESERVED_FAMILIES:
            target_type = top_type

        # 2) tensor_overrides (premier match gagne, comme llama-quantize)
        if target_type is None:
            for pat, qtype in compiled_overrides:
                if pat.search(t.name):
                    target_type = qtype
                    break

        # 3) family_quants
        if target_type is None:
            fq = family_quants.get(fam)
            if fq and fq != "base":
                target_type = fq

        # 4) base
        if target_type is None:
            target_type = base

        total_target += t.bytes_as(target_type)
        total_current += t.bytes_current

    return total_target, total_current


# ────────────────────────────────────────────────────────────────────────────
# Emit preset — dispatch
# ────────────────────────────────────────────────────────────────────────────

def emit_preset(
    tensors: list[TensorStat],
    profile: str,
    name: str,
    base: str | None = None,
    top_f16: float | None = None,
    top_q8: float | None = None,
    top_per_family: float | None = None,
) -> tuple[dict, dict]:
    """Dispatch vers la stratégie selon le mode du profile.

    Retourne (preset_dict, tier_counts) — le preset est directement consommable
    par lib.quantize.build_quantize_overrides + run_quantize.
    """
    if profile not in PROFILES:
        raise ValueError(f"profile inconnu : {profile} (dispo: {sorted(PROFILES)})")
    prof = PROFILES[profile]
    mode = prof.get("mode", "cumulative")

    if mode == "per_family":
        return _emit_preset_per_family(
            tensors, profile, name,
            base=base or prof["default_base"],
            top_per_family=top_per_family if top_per_family is not None
                           else prof["top_per_family"],
        )
    return _emit_preset_cumulative(
        tensors, profile, name, base=base,
        top_f16=top_f16, top_q8=top_q8,
    )


def _emit_preset_per_family(
    tensors: list[TensorStat],
    profile: str,
    name: str,
    base: str,
    top_per_family: float,
) -> tuple[dict, dict]:
    """Stratification par composant + pins F16 fixes. Plancher = base."""

    families: dict[str, list[TensorStat]] = defaultdict(list)
    for t in tensors:
        families[_family_of(t.name)].append(t)

    # Top N par famille (au moins 1 tensor par famille pour que les petites
    # familles soient aussi représentées).
    f16_names: set[str] = set()
    picks_per_family: dict[str, int] = {}
    for fam, ts in families.items():
        sorted_ts = sorted(ts, key=lambda t: t.sum_values, reverse=True)
        n_top = max(1, math.ceil(len(sorted_ts) * top_per_family))
        picks_per_family[fam] = n_top
        for t in sorted_ts[:n_top]:
            f16_names.add(t.name)

    overrides: list[str] = list(F16_PIN_REGEXES)
    for tname in sorted(f16_names):
        overrides.append(f"{re.escape(tname)}=F16")

    tier_counts: dict[str, Any] = {
        "F16 (data-driven)": len(f16_names),
        "F16 (pins auto)": "auto (norms + ffn_gate_inp)",
        f"{base} (base)": len(tensors) - len(f16_names),
    }

    preset = {
        "name": name,
        "base": base,
        "desc": (
            f"Chirurgical · F16 top {int(top_per_family*100)}%/famille "
            f"({len(f16_names)} tensors) + pins norms/routers · "
            f"plancher {base}"
        ),
        "preserve_embeddings": True,
        "tensor_overrides": overrides,
    }
    return preset, tier_counts


def _emit_preset_cumulative(
    tensors: list[TensorStat],
    profile: str,
    name: str,
    base: str | None = None,
    top_f16: float | None = None,
    top_q8: float | None = None,
) -> tuple[dict, dict]:
    """Mode cumulative historique : tri global par sum desc, tiers séquentiels."""
    prof = PROFILES[profile]
    base = base or prof["default_base"]

    # Override manuel des cuts
    tiers = [list(t) for t in prof["tiers"]]
    if top_f16 is not None and tiers and tiers[0][0] == "F16":
        tiers[0][1] = top_f16
    if top_q8 is not None and len(tiers) > 1 and tiers[1][0] == "Q8_0":
        tiers[1][1] = top_q8

    total = sum(t.sum_values for t in tensors) or 1.0
    sorted_t = sorted(tensors, key=lambda t: t.sum_values, reverse=True)

    assignments: dict[str, str] = {}
    cum = 0.0
    tier_idx = 0
    for t in sorted_t:
        if tier_idx < len(tiers):
            assignments[t.name] = tiers[tier_idx][0]
        cum += t.sum_values
        cum_ratio = cum / total
        while tier_idx < len(tiers) and cum_ratio > tiers[tier_idx][1]:
            tier_idx += 1

    by_type: dict[str, list[str]] = defaultdict(list)
    for tname, ttype in assignments.items():
        by_type[ttype].append(tname)

    type_order = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M"]
    order_sorted = sorted(
        by_type.keys(),
        key=lambda t: type_order.index(t) if t in type_order else 99,
    )

    overrides: list[str] = []
    for ttype in order_sorted:
        for tname in sorted(by_type[ttype]):
            overrides.append(f"{_regex_escape_tensor(tname)}={ttype}")

    tier_counts: dict[str, int] = defaultdict(int)
    for ttype in assignments.values():
        tier_counts[ttype] += 1
    tier_counts[f"{base} (base)"] = len(tensors) - len(assignments)

    preset = {
        "name": name,
        "base": base,
        "desc": f"Auto-tuné (profile={profile}) · " + " / ".join(
            f"{t}:{c}" for t, c in tier_counts.items()
        ),
        "preserve_embeddings": True,
        "tensor_overrides": overrides,
    }
    return preset, dict(tier_counts)


def emit_preset_custom(
    tensors: list[TensorStat],
    name: str,
    base: str,
    family_quants: dict[str, str],
    top_per_family_f16: Union[dict[str, float], float] = 0.0,
    f16_pins: list[str] | None = None,
    bonus_type: str = "F16",
) -> tuple[dict, dict]:
    """Émet un preset depuis les choix explicites du builder (UI ou TUI).

    - family_quants : map {famille → type}. "base" = fallback. Familles absentes
      tombent sur `base`.
    - top_per_family_f16 : fraction [0..1] par famille des top tensors à forcer
      en bonus_type. Float global ou dict {fam → pct}.
    - f16_pins : regex supplémentaires (par défaut F16_PIN_REGEXES).
    - bonus_type : "F16" pour source F16/BF16, "Q8_0" pour source Q8 (re-quantize).

    Retourne (preset_dict, tier_counts). Le preset contient family_quants
    (consommé par lib.quantize.build_quantize_overrides) + tensor_overrides
    spécifiques (pins + top-par-famille bonus).
    """
    if f16_pins is not None:
        if bonus_type != "F16":
            f16_pins = [p.replace("=F16", f"={bonus_type}") for p in f16_pins]
    else:
        pins = list(F16_PIN_REGEXES)
        if bonus_type != "F16":
            pins = [p.replace("=F16", f"={bonus_type}") for p in pins]
        f16_pins = pins

    if isinstance(top_per_family_f16, dict):
        bonus_map = top_per_family_f16
        global_bonus = 0.0
    else:
        bonus_map = None  # sentinel
        global_bonus = top_per_family_f16

    families_in_imatrix: dict[str, list[TensorStat]] = defaultdict(list)
    for t in tensors:
        families_in_imatrix[_family_of(t.name)].append(t)

    top_f16_names: set[str] = set()
    top_f16_by_family: dict[str, int] = {}
    for fam, ts in families_in_imatrix.items():
        if bonus_map is not None:
            fam_bonus = bonus_map.get(fam, 0.0)
        else:
            fam_bonus = global_bonus
        if fam_bonus <= 0:
            continue
        fam_quant = family_quants.get(fam, "base")
        if fam_quant == bonus_type:
            continue
        if fam_quant == "base" and base == bonus_type:
            continue
        sorted_ts = sorted(ts, key=lambda t: t.sum_values, reverse=True)
        n_top = max(1, math.ceil(len(sorted_ts) * fam_bonus))
        top_f16_by_family[fam] = n_top
        for t in sorted_ts[:n_top]:
            top_f16_names.add(t.name)

    overrides: list[str] = list(f16_pins)
    for tname in sorted(top_f16_names):
        overrides.append(f"{_regex_escape_tensor(tname)}={bonus_type}")

    clean_family_quants = {
        fam: quant for fam, quant in family_quants.items()
        if quant != "base"
    }

    tier_counts: dict[str, int] = defaultdict(int)
    tier_counts[f"{bonus_type} (pins auto)"] = len(f16_pins)
    if top_f16_by_family:
        for bf, bn in sorted(top_f16_by_family.items(), key=lambda x: -x[1]):
            fam_total = len(families_in_imatrix.get(bf, []))
            pct_actual = int(bn / fam_total * 100) if fam_total > 0 else 0
            tier_counts[f"{bonus_type} bonus {pct_actual}% (famille {bf})"] = bn
    for fam, quant in clean_family_quants.items():
        n_fam = len(families_in_imatrix.get(fam, []))
        n_bonus = top_f16_by_family.get(fam, 0)
        n_remaining = n_fam - n_bonus
        if n_remaining > 0:
            tier_counts[f"{quant} (famille {fam})"] = n_remaining
    accounted_families = set(clean_family_quants.keys())
    base_count = sum(
        len(ts) - top_f16_by_family.get(fam, 0)
        for fam, ts in families_in_imatrix.items()
        if fam not in accounted_families
    )
    if base_count > 0:
        tier_counts[f"{base} (base)"] = base_count

    desc_parts = [f"Custom builder · base {base}"]
    if clean_family_quants:
        fams_summary = ", ".join(
            f"{fam}={q}" for fam, q in list(clean_family_quants.items())[:4]
        )
        if len(clean_family_quants) > 4:
            fams_summary += f", +{len(clean_family_quants) - 4} autres"
        desc_parts.append(fams_summary)
    if top_f16_names:
        desc_parts.append(f"+{len(top_f16_names)} tensors {bonus_type} bonus")
    if f16_pins:
        desc_parts.append("+pins norms/routers")

    preset = {
        "name": name,
        "base": base,
        "desc": " · ".join(desc_parts),
        "preserve_embeddings": True,
    }
    if clean_family_quants:
        preset["family_quants"] = clean_family_quants
    preset["tensor_overrides"] = overrides
    return preset, dict(tier_counts)


# ────────────────────────────────────────────────────────────────────────────
# Arch-aware recos + priorités (per family / per category × arch)
# ────────────────────────────────────────────────────────────────────────────

# Recos enrichies par (catégorie, arch). Quand l'arch est connue (via
# detect_architecture(tensors)), la UI peut afficher CETTE reco au lieu de la
# reco générique de FAMILY_DOCS. Port de inspect-imatrix.py:835-891.
ARCH_RECO: dict[str, dict[str, str]] = {
    ARCH_DENSE: {
        CATEGORY_FFN_DENSE: (
            "Q8_0 recommandé — seuls 3 tensors FFN par layer (gate/up/down), "
            "pas de redondance d'experts pour absorber le bruit"
        ),
        CATEGORY_FFN_EXPERTS:        "base OK — ne devrait pas exister sur dense, ignorer",
        CATEGORY_FFN_SHARED_EXPERTS: "base OK — ne devrait pas exister sur dense, ignorer",
        CATEGORY_ROUTER:             "base OK — ne devrait pas exister sur dense, ignorer",
        CATEGORY_SSM:                "base OK — ne devrait pas exister sur dense, ignorer",
    },
    ARCH_MOE: {
        CATEGORY_FFN_DENSE: "base OK — ne devrait pas exister sur MoE, ignorer",
        CATEGORY_FFN_EXPERTS: (
            "base OK — experts = 80-85% du volume, redondance naturelle "
            "(N experts, 2-8 actifs/token). Q8_0 si budget taille"
        ),
        CATEGORY_FFN_SHARED_EXPERTS: "base OK — expert commun, petit, robuste",
        CATEGORY_ROUTER: (
            "F16 TOUJOURS — pivot du gating MoE, taille négligeable, "
            "impact maximal si dégradé"
        ),
        CATEGORY_SSM: "base OK — ne devrait pas exister sur MoE pur, ignorer",
    },
    ARCH_HYBRID: {
        CATEGORY_FFN_DENSE: "base OK — ne devrait pas exister sur hybride MoE, ignorer",
        CATEGORY_FFN_EXPERTS: (
            "base OK — experts = ~92% du volume, redondance naturelle + "
            "shared expert absorbe une partie du bruit"
        ),
        CATEGORY_FFN_SHARED_EXPERTS: (
            "base OK — expert commun, petit (~1M/layer), robuste. "
            "Q8_0 pour ffn_down_shexp si budget"
        ),
        CATEGORY_ROUTER:    "F16 TOUJOURS — pivot du gating MoE+shared, taille négligeable",
        CATEGORY_SSM: (
            "ssm_out = Q8_0 (le plus gros, porte le savoir SSM) · "
            "alpha/beta/conv1d/dt = F16 (minuscules, critiques pour "
            "la dynamique temporelle)"
        ),
    },
}

# Priorité de bump par (famille, arch) — label + couleur + ordre de tri.
# Répond à "vaut-il le coup de monter cette famille au-dessus de la base ?".
# Labels :
#   prioritaire = bump rentable, mettre des bits ici en premier
#   si budget   = bump utile mais pas critique
#   base OK     = tolérant, garder la base
#   auto F16    = géré automatiquement (norms, router, IO)
# Port de inspect-imatrix.py:_FAMILY_PRIORITY:904-952.
# Format JSON-friendly : dict[family][arch] = {label, color, order}.
FAMILY_PRIORITY: dict[str, dict[str, dict[str, Any]]] = {
    # Attention — même priorité dense / MoE / hybrid
    "attn_k":      {a: {"label": "prioritaire", "color": "red",    "order": 0} for a in (ARCH_DENSE, ARCH_MOE, ARCH_HYBRID)},
    "attn_q":      {a: {"label": "prioritaire", "color": "red",    "order": 0} for a in (ARCH_DENSE, ARCH_MOE, ARCH_HYBRID)},
    "attn_v":      {a: {"label": "si budget",   "color": "yellow", "order": 2} for a in (ARCH_DENSE, ARCH_MOE, ARCH_HYBRID)},
    "attn_output": {a: {"label": "si budget",   "color": "yellow", "order": 2} for a in (ARCH_DENSE, ARCH_MOE, ARCH_HYBRID)},
    # FFN dense (n'existe que sur dense)
    "ffn_down":    {ARCH_DENSE: {"label": "prioritaire", "color": "red",    "order": 1}},
    "ffn_gate":    {ARCH_DENSE: {"label": "base OK",     "color": "green",  "order": 3}},
    "ffn_up":      {ARCH_DENSE: {"label": "base OK",     "color": "green",  "order": 3}},
    # FFN experts MoE
    "ffn_down_exps":    {a: {"label": "si budget", "color": "yellow", "order": 2} for a in (ARCH_MOE, ARCH_HYBRID)},
    "ffn_gate_exps":    {a: {"label": "base OK",   "color": "green",  "order": 3} for a in (ARCH_MOE, ARCH_HYBRID)},
    "ffn_up_exps":      {a: {"label": "base OK",   "color": "green",  "order": 3} for a in (ARCH_MOE, ARCH_HYBRID)},
    "ffn_gate_up_exps": {a: {"label": "base OK",   "color": "green",  "order": 3} for a in (ARCH_MOE, ARCH_HYBRID)},
    # Hybride spécifique
    "attn_qkv":         {ARCH_HYBRID: {"label": "prioritaire", "color": "red",    "order": 0}},
    "attn_gate":        {ARCH_HYBRID: {"label": "prioritaire", "color": "red",    "order": 1}},
    "ffn_down_shexp":   {ARCH_HYBRID: {"label": "si budget",   "color": "yellow", "order": 2}},
    "ffn_gate_shexp":   {ARCH_HYBRID: {"label": "base OK",     "color": "green",  "order": 3}},
    "ffn_up_shexp":     {ARCH_HYBRID: {"label": "base OK",     "color": "green",  "order": 3}},
    "ssm_out":          {ARCH_HYBRID: {"label": "prioritaire", "color": "red",    "order": 1}},
    "ssm_alpha":        {ARCH_HYBRID: {"label": "auto F16",    "color": "dim",    "order": -1}},
    "ssm_beta":         {ARCH_HYBRID: {"label": "auto F16",    "color": "dim",    "order": -1}},
    "ssm_conv1d":       {ARCH_HYBRID: {"label": "auto F16",    "color": "dim",    "order": -1}},
    "ssm_dt":           {ARCH_HYBRID: {"label": "auto F16",    "color": "dim",    "order": -1}},
}

# Fallback par (catégorie, arch) — appliqué quand la famille n'a pas d'entrée
# spécifique dans FAMILY_PRIORITY.
CATEGORY_PRIORITY: dict[str, dict[str, dict[str, Any]]] = {
    ARCH_DENSE: {
        CATEGORY_NORMS:                {"label": "auto F16",  "color": "dim",    "order": -1},
        CATEGORY_IO:                   {"label": "auto F16",  "color": "dim",    "order": -1},
        CATEGORY_ATTENTION:            {"label": "si budget", "color": "yellow", "order": 2},
        CATEGORY_FFN_DENSE:            {"label": "base OK",   "color": "green",  "order": 3},
        CATEGORY_OTHER:                {"label": "?",         "color": "dim",    "order": 4},
    },
    ARCH_MOE: {
        CATEGORY_NORMS:                {"label": "auto F16",  "color": "dim",    "order": -1},
        CATEGORY_ROUTER:               {"label": "auto F16",  "color": "dim",    "order": -1},
        CATEGORY_IO:                   {"label": "auto F16",  "color": "dim",    "order": -1},
        CATEGORY_ATTENTION:            {"label": "si budget", "color": "yellow", "order": 2},
        CATEGORY_FFN_EXPERTS:          {"label": "base OK",   "color": "green",  "order": 3},
        # Fallbacks défensifs : si l'archi-detect rate l'hybride mais qu'on voit
        # des shared experts ou des SSM dans un modèle marqué MoE, on donne
        # quand même un badge sensé au lieu de None → "—" sans signal.
        CATEGORY_FFN_SHARED_EXPERTS:   {"label": "base OK",   "color": "green",  "order": 3},
        CATEGORY_SSM:                  {"label": "si budget", "color": "yellow", "order": 2},
        CATEGORY_FFN_DENSE:            {"label": "base OK",   "color": "green",  "order": 3},
        CATEGORY_OTHER:                {"label": "?",         "color": "dim",    "order": 4},
    },
    ARCH_HYBRID: {
        CATEGORY_NORMS:                {"label": "auto F16",  "color": "dim",    "order": -1},
        CATEGORY_ROUTER:               {"label": "auto F16",  "color": "dim",    "order": -1},
        CATEGORY_IO:                   {"label": "auto F16",  "color": "dim",    "order": -1},
        CATEGORY_SSM:                  {"label": "si budget", "color": "yellow", "order": 2},
        CATEGORY_ATTENTION:            {"label": "si budget", "color": "yellow", "order": 2},
        CATEGORY_FFN_EXPERTS:          {"label": "base OK",   "color": "green",  "order": 3},
        CATEGORY_FFN_SHARED_EXPERTS:   {"label": "base OK",   "color": "green",  "order": 3},
        CATEGORY_FFN_DENSE:            {"label": "base OK",   "color": "green",  "order": 3},
        CATEGORY_OTHER:                {"label": "?",         "color": "dim",    "order": 4},
    },
}


def family_catalog() -> dict[str, Any]:
    """Doc pédagogique + recos arch-aware + priorités (pour /quant/family-catalog).

    Retourne :
      - families : dict[family, {label, category, role, impact, reco}]
      - categories : dict[category, label affichable]
      - f16_pins_default : pins F16 appliqués par défaut sur les modes auto
      - arch_reco : dict[arch, dict[category, reco_text contextualisé]]
      - family_priority : dict[family, dict[arch, {label, color, order}]]
      - category_priority : dict[arch, dict[category, {label, color, order}]] (fallback)

    La UI consomme ça pour afficher des badges priorité par famille selon
    l'arch détectée de l'imatrix sélectionnée (dense vs moe vs hybrid).
    """
    return {
        "families": dict(FAMILY_DOCS),
        "categories": dict(CATEGORY_LABELS),
        "f16_pins_default": list(F16_PIN_REGEXES),
        "arch_reco": ARCH_RECO,
        "family_priority": FAMILY_PRIORITY,
        "category_priority": CATEGORY_PRIORITY,
    }
