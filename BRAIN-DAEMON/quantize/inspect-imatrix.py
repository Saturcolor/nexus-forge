#!/usr/bin/env python3
"""
inspect-imatrix.py — analyse un fichier imatrix llama.cpp (.dat binaire)
et optionnellement émet un preset `tensor_overrides` basé sur l'importance
des tensors.

Format binaire llama.cpp :
  [int32] n_entries
  for each entry:
    [int32] name_len
    [char × name_len] name (utf-8)
    [int32] ncall      # nb d'appels enregistrés sur ce tensor
    [int32] nval       # taille du vecteur d'activation
    [float × nval] values   # sum(x^2) / ncall par colonne
  [int32] ncall_total      # optionnel (versions récentes)
  [int32] dataset_len      # optionnel
  [char × dataset_len] dataset   # optionnel

L'importance d'un tensor = somme des values (énergie d'activation totale
absorbée par ses lignes/colonnes). Plus c'est grand, plus la quantization
de ce tensor va amplifier les erreurs d'arrondi.

Usage :
  ./inspect-imatrix.py matrix/<model>.imatrix
  ./inspect-imatrix.py matrix/<model>.imatrix --top 30
  ./inspect-imatrix.py matrix/<model>.imatrix --group "blk\\.(\\d+)"
  ./inspect-imatrix.py matrix/<model>.imatrix \\
      --emit-preset --name Q_gemma_auto --profile 3tier \\
      --base Q6_K --top-f16 0.05 --top-q8 0.40
  ./inspect-imatrix.py matrix/<model>.imatrix --emit-preset ... --append-config
"""

from __future__ import annotations

import argparse
import math
import re
import struct
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

import yaml
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

console = Console()

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.yaml"


# ────────────────────────────────────────────────────────────────────────────
# Architecture (dense vs MoE)
# ────────────────────────────────────────────────────────────────────────────

ARCH_DENSE = "dense"
ARCH_MOE = "moe"
ARCH_HYBRID = "hybrid"  # MoE + SSM (ex: Qwen3.6, Jamba)

# Familles qui n'existent que dans les modèles MoE
_MOE_FAMILIES = {"ffn_gate_inp", "ffn_gate_exps", "ffn_up_exps",
                 "ffn_down_exps", "ffn_gate_up_exps"}

# Familles SSM (Mamba / State Space Model)
_SSM_FAMILIES = {"ssm_alpha", "ssm_beta", "ssm_conv1d", "ssm_out",
                 "ssm_norm", "ssm_dt"}


def detect_architecture(tensors) -> str:
    """Détecte l'architecture à partir des noms de tensors.
    Accepte tout objet avec attribut .name (TensorStat, GGUFTensor, etc.).
    - MoE + SSM → ARCH_HYBRID
    - MoE seul → ARCH_MOE
    - Dense      → ARCH_DENSE"""
    has_moe = False
    has_ssm = False
    for t in tensors:
        name = t.name
        for moe_fam in _MOE_FAMILIES:
            if f".{moe_fam}." in name or name.startswith(f"{moe_fam}."):
                has_moe = True
        for ssm_fam in _SSM_FAMILIES:
            if f".{ssm_fam}." in name or f".{ssm_fam}" in name:
                has_ssm = True
        if has_moe and has_ssm:
            return ARCH_HYBRID
    if has_moe:
        return ARCH_MOE
    return ARCH_DENSE


# ────────────────────────────────────────────────────────────────────────────
# Parser binaire
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class TensorStat:
    name: str
    ncall: int
    nval: int
    sum_values: float       # somme des values (énergie totale)
    l2_norm: float          # sqrt(sum(v^2)) — robuste aux outliers
    mean_value: float       # moyenne (comparable entre tensors de taille ≠)
    concentration_top10: float  # fraction d'énergie dans le top 10% des colonnes


def parse_imatrix(path: Path) -> tuple[list[TensorStat], int, str]:
    """Lit un fichier .imatrix binaire llama.cpp. Retourne
    (tensors, ncall_total, dataset_name). Tolérant sur le trailer optionnel."""
    data = path.read_bytes()
    if len(data) < 4:
        raise ValueError(f"Fichier trop court : {path}")

    off = 0

    def read_i32() -> int:
        nonlocal off
        if off + 4 > len(data):
            raise ValueError(f"EOF inattendu à offset {off}")
        (v,) = struct.unpack_from("<i", data, off)
        off += 4
        return v

    def read_floats(n: int) -> list[float]:
        nonlocal off
        if off + 4 * n > len(data):
            raise ValueError(f"EOF inattendu (floats) à offset {off}")
        fmt = f"<{n}f"
        vals = struct.unpack_from(fmt, data, off)
        off += 4 * n
        return list(vals)

    n_entries = read_i32()
    if n_entries <= 0 or n_entries > 100_000:
        raise ValueError(f"n_entries aberrant : {n_entries} (fichier corrompu ?)")

    tensors: list[TensorStat] = []
    for i in range(n_entries):
        name_len = read_i32()
        if name_len <= 0 or name_len > 1024:
            raise ValueError(f"name_len aberrant entry {i} : {name_len}")
        name = data[off:off + name_len].decode("utf-8", errors="replace")
        off += name_len

        ncall = read_i32()
        nval = read_i32()
        if nval < 0 or nval > 10_000_000:
            raise ValueError(f"nval aberrant pour {name} : {nval}")

        values = read_floats(nval) if nval > 0 else []

        s = sum(values)
        l2 = math.sqrt(sum(v * v for v in values)) if values else 0.0
        mean = (s / nval) if nval > 0 else 0.0

        # Concentration : fraction d'énergie dans le top 10% des colonnes
        if values and s > 0:
            k = max(1, nval // 10)
            top_k = sorted(values, reverse=True)[:k]
            conc = sum(top_k) / s
        else:
            conc = 0.0

        tensors.append(TensorStat(
            name=name, ncall=ncall, nval=nval,
            sum_values=s, l2_norm=l2, mean_value=mean,
            concentration_top10=conc,
        ))

    # Trailer optionnel (ncall_total + dataset)
    ncall_total = 0
    dataset = ""
    try:
        if off + 4 <= len(data):
            ncall_total = read_i32()
        if off + 8 <= len(data):
            dataset_len = read_i32()
            if 0 < dataset_len < 4096 and off + dataset_len <= len(data):
                dataset = data[off:off + dataset_len].decode("utf-8", errors="replace")
    except Exception:
        pass

    return tensors, ncall_total, dataset


# ────────────────────────────────────────────────────────────────────────────
# Affichage
# ────────────────────────────────────────────────────────────────────────────

def fmt_float(f: float) -> str:
    if f == 0:
        return "0"
    if abs(f) < 1e-3:
        return f"{f:.2e}"
    if abs(f) < 1000:
        return f"{f:.3f}"
    return f"{f:.2e}"


def show_tensor_table(tensors: list[TensorStat], top: int, sort_by: str) -> None:
    """Tableau trié des tensors individuels."""
    sorter = {
        "sum": lambda t: t.sum_values,
        "l2": lambda t: t.l2_norm,
        "mean": lambda t: t.mean_value,
    }[sort_by]
    sorted_t = sorted(tensors, key=sorter, reverse=True)

    total_sum = sum(t.sum_values for t in tensors) or 1.0

    table = Table(
        title=f"Tensors triés par {sort_by} (top {top} sur {len(tensors)})",
        header_style="bold magenta", box=None, padding=(0, 2),
    )
    table.add_column("#", justify="right", style="dim")
    table.add_column("Tensor")
    table.add_column("ncall", justify="right")
    table.add_column("nval", justify="right")
    table.add_column("sum", justify="right")
    table.add_column("L2", justify="right")
    table.add_column("mean", justify="right")
    table.add_column("% total", justify="right")

    for i, t in enumerate(sorted_t[:top], start=1):
        pct = (t.sum_values / total_sum) * 100
        color = "bold green" if pct > 1.0 else "cyan" if pct > 0.3 else "white"
        table.add_row(
            str(i),
            f"[{color}]{t.name}[/]",
            str(t.ncall),
            str(t.nval),
            fmt_float(t.sum_values),
            fmt_float(t.l2_norm),
            fmt_float(t.mean_value),
            f"{pct:.2f}%",
        )
    console.print(table)


def show_grouped_table(tensors: list[TensorStat], pattern: str, sort_by: str) -> None:
    """Regroupe par capture du pattern, agrège les stats."""
    rx = re.compile(pattern)
    groups: dict[str, list[TensorStat]] = defaultdict(list)
    unmatched = 0
    for t in tensors:
        m = rx.search(t.name)
        if m:
            # Filtre les groupes None (issus de sous-groupes optionnels) pour
            # éviter TypeError dans "|".join.
            captured = [g for g in m.groups() if g is not None]
            key = "|".join(captured) if captured else m.group(0)
            groups[key].append(t)
        else:
            unmatched += 1

    total_sum = sum(t.sum_values for t in tensors) or 1.0
    sorter = {
        "sum": lambda items: sum(t.sum_values for t in items),
        "l2": lambda items: math.sqrt(sum(t.l2_norm ** 2 for t in items)),
        "mean": lambda items: sum(t.mean_value for t in items) / len(items),
    }[sort_by]

    rows = [(k, v, sorter(v)) for k, v in groups.items()]
    rows.sort(key=lambda r: r[2], reverse=True)

    table = Table(
        title=f"Groupes par `{pattern}` triés par {sort_by}",
        header_style="bold cyan", box=None, padding=(0, 2),
    )
    table.add_column("Groupe")
    table.add_column("N tensors", justify="right")
    table.add_column("Σ sum", justify="right")
    table.add_column("Σ L2", justify="right")
    table.add_column("% total", justify="right")

    for key, items, _score in rows[:60]:
        gsum = sum(t.sum_values for t in items)
        gl2 = math.sqrt(sum(t.l2_norm ** 2 for t in items))
        pct = (gsum / total_sum) * 100
        color = "bold green" if pct > 5.0 else "cyan" if pct > 1.0 else "white"
        table.add_row(
            f"[{color}]{key}[/]",
            str(len(items)),
            fmt_float(gsum),
            fmt_float(gl2),
            f"{pct:.2f}%",
        )
    console.print(table)
    if unmatched:
        console.print(f"[dim]Non matchés : {unmatched} tensors[/]")


# ────────────────────────────────────────────────────────────────────────────
# Émission preset
# ────────────────────────────────────────────────────────────────────────────

PROFILES: dict[str, dict] = {
    # ── Guide de choix ─────────────────────────────────────────────────────
    #
    # DENSE (Llama, Mistral, Phi, Qwen, …) :
    #   → cumulative (2tier / 3tier / 4tier) fonctionne bien. Le tri global
    #     par énergie imatrix est pertinent car tous les tensors sont du même
    #     type (pas de sous-populations structurellement différentes).
    #   → surgical est aussi valable mais le gain marginal est faible.
    #
    # MoE (Gemma-4, Mixtral, DeepSeek-V2, …) :
    #   → cumulative est DÉCONSEILLÉ. Les experts FFN dominent le volume
    #     (~85%) ET l'énergie imatrix — le tri global pousse presque tout
    #     en F16 ou tout en base, sans granularité par composant.
    #   → surgical / custom est RECOMMANDÉ. La stratégie per_family garantit
    #     que attention, experts et norms sont traités indépendamment, et que
    #     chaque composant conserve ses propres outliers critiques.
    #
    # En cas de doute → utiliser le Custom Builder (mode interactif) qui
    # affiche la concentration d'énergie par famille et guide le choix.
    # ───────────────────────────────────────────────────────────────────────

    # Modes "cumulative" : tri global par sum desc, cuts = fraction cumulée.
    # cuts = fraction cumulée du sum_values total
    "2tier": {
        "mode": "cumulative",
        "tiers": [("F16", 0.15)],         # top 15% sum → F16, reste → base
        "default_base": "Q8_0",
    },
    "3tier": {
        "mode": "cumulative",
        "tiers": [("F16", 0.05), ("Q8_0", 0.40)],  # top 5% F16, next 40% Q8, reste base
        "default_base": "Q6_K",
    },
    "4tier": {
        "mode": "cumulative",
        "tiers": [("F16", 0.03), ("Q8_0", 0.20), ("Q6_K", 0.50)],
        "default_base": "Q5_K_M",
    },
    # Modes "per_family" : stratification PAR composant + pins F16 fixes.
    # Plancher systématique Q8_0 (jamais moins). Top X% de chaque famille passe
    # F16, le reste reste sur la base. Meilleur que tier cumulatif car garantit
    # que CHAQUE composant préserve ses outliers réels au lieu d'appliquer une
    # règle globale qui privilégie les familles bruyantes.
    "surgical-light": {
        "mode": "per_family",
        "top_per_family": 0.10,   # top 10% par famille → F16
        "default_base": "Q8_0",
    },
    "surgical": {
        "mode": "per_family",
        "top_per_family": 0.20,   # top 20% (sweet spot, ~0.60× F16)
        "default_base": "Q8_0",
    },
    "surgical-xl": {
        "mode": "per_family",
        "top_per_family": 0.35,   # top 35% (max quali avant F16 pur)
        "default_base": "Q8_0",
    },
}

# Pins F16 automatiques en mode surgical — tensors critiques pour la qualité,
# quasi-gratuits en taille, désastreux si quantisés bas. token_embd + output
# sont déjà couverts par preserve_embeddings=true, on ajoute :
#   - tous les norms (attn_norm, ffn_norm, output_norm, k_norm, q_norm, …)
#   - routeurs MoE ffn_gate_inp (décide quel expert est appelé : si le routeur
#     se dégrade, le gating devient instable → pathologies type répétition).
F16_PIN_REGEXES: list[str] = [
    r".+_norm\..*=F16",
    r"ffn_gate_inp\..*=F16",
    r"ffn_gate_inp_shexp\..*=F16",
    r"ssm_alpha\..*=F16",
    r"ssm_beta\..*=F16",
    r"ssm_conv1d\..*=F16",
]


# ────────────────────────────────────────────────────────────────────────────
# Documentation pédagogique des familles (pour le builder custom)
# ────────────────────────────────────────────────────────────────────────────

# Catégories utilisées pour regrouper les familles dans le TUI builder.
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

# Chaque entrée : (label, category, rôle, impact si dégradé, reco).
# Les "reco" sont conservatives pour un modèle généraliste sur prose FR/EN.
FAMILY_DOCS: dict[str, dict[str, str]] = {
    # ── Attention ────────────────────────────────────────────────────────
    "attn_k": {
        "label": "Attention · Keys (K)",
        "category": CATEGORY_ATTENTION,
        "role": (
            "Les 'clés d'indexation'. Chaque token publie une clé pour se "
            "faire reconnaître par les autres tokens lors du matching."
        ),
        "impact": (
            "Très critique. Dégrade → les tokens se 'voient' mal mutuellement, "
            "confusion contextuelle, pertes de cohérence long-contexte."
        ),
        "reco": "Q8_0 (sûr) · F16 pour quali max",
    },
    "attn_q": {
        "label": "Attention · Queries (Q)",
        "category": CATEGORY_ATTENTION,
        "role": (
            "Les 'questions'. Chaque token formule ce qu'il cherche chez les "
            "autres tokens pour récupérer l'info pertinente."
        ),
        "impact": (
            "Très critique. Dégrade → perte de focus, le modèle 'rate' les "
            "infos clés du contexte, réponses hors-sujet."
        ),
        "reco": "Q8_0 (sûr) · F16 pour quali max",
    },
    "attn_v": {
        "label": "Attention · Values (V)",
        "category": CATEGORY_ATTENTION,
        "role": (
            "Le contenu qui circule. L'info qu'un token donne à un autre "
            "quand K et Q se sont matchés."
        ),
        "impact": (
            "Critique mais moins fragile que K/Q. Dégrade → perte de nuance "
            "sémantique, réponses plus approximatives."
        ),
        "reco": "Q8_0 (sûr) · Q6_K acceptable sur prose",
    },
    "attn_output": {
        "label": "Attention · Projection sortie",
        "category": CATEGORY_ATTENTION,
        "role": (
            "Reprojette le résultat de l'attention multi-tête vers la "
            "dimension normale pour transmission à la FFN."
        ),
        "impact": (
            "Modéré. Dégrade → léger flou sur la synthèse des informations "
            "mais compensable par d'autres couches."
        ),
        "reco": "Q8_0 (safe) · base OK sur prose",
    },
    # ── FFN dense ────────────────────────────────────────────────────────
    "ffn_gate": {
        "label": "FFN · Gate (valve SwiGLU)",
        "category": CATEGORY_FFN_DENSE,
        "role": (
            "La 'valve' qui décide combien de signal passe dans la FFN. "
            "Multiplie ffn_up pour contrôler le flot (mécanisme SwiGLU)."
        ),
        "impact": (
            "Modéré. Dégrade → filtrage moins sélectif, raisonnement un peu "
            "plus bruité."
        ),
        "reco": "base OK · Q8 si budget",
    },
    "ffn_up": {
        "label": "FFN · Up projection",
        "category": CATEGORY_FFN_DENSE,
        "role": (
            "Projette chaque token dans un espace ~4× plus grand (la 'mémoire "
            "de travail' de la FFN où s'opère la transformation)."
        ),
        "impact": (
            "Modéré. Symétrique à ffn_gate dans SwiGLU. Robuste à la quant."
        ),
        "reco": "base OK · Q8 si budget",
    },
    "ffn_down": {
        "label": "FFN · Down projection",
        "category": CATEGORY_FFN_DENSE,
        "role": (
            "Re-projette vers la dimension normale avec la transformation "
            "apprise. C'est le 'cerveau' de la FFN — porte le vrai savoir."
        ),
        "impact": (
            "Plus critique que gate/up. Dégrade → transformations appauvries, "
            "le modèle perd en profondeur de raisonnement."
        ),
        "reco": "Q8_0 recommandé · base acceptable",
    },
    # ── FFN experts MoE ──────────────────────────────────────────────────
    "ffn_gate_exps": {
        "label": "FFN experts · Gate",
        "category": CATEGORY_FFN_EXPERTS,
        "role": (
            "La valve SwiGLU mais pour chaque expert MoE (N experts par "
            "couche, chacun spécialisé)."
        ),
        "impact": (
            "Modéré. Les experts sont nombreux donc l'impact est dilué."
        ),
        "reco": "base OK (les experts portent 80% des params)",
    },
    "ffn_up_exps": {
        "label": "FFN experts · Up",
        "category": CATEGORY_FFN_EXPERTS,
        "role": "Up projection par expert MoE. Symétrique à ffn_gate_exps.",
        "impact": "Modéré.",
        "reco": "base OK",
    },
    "ffn_down_exps": {
        "label": "FFN experts · Down",
        "category": CATEGORY_FFN_EXPERTS,
        "role": (
            "Down projection par expert MoE — le 'savoir spécialisé' de "
            "chaque expert."
        ),
        "impact": (
            "Plus critique que gate/up experts. Mais toujours redondant "
            "(N experts, seulement 2-8 actifs par token)."
        ),
        "reco": "Q8_0 pour quali · base OK si budget",
    },
    "ffn_gate_up_exps": {
        "label": "FFN experts · Gate+Up (fusionné)",
        "category": CATEGORY_FFN_EXPERTS,
        "role": (
            "Gate et Up fusionnés dans un seul tensor pour efficacité "
            "(architecture moderne type Gemma-4 MoE)."
        ),
        "impact": (
            "Modéré. Même logique que ffn_gate_exps + ffn_up_exps séparés."
        ),
        "reco": "base OK",
    },
    # ── Routeur MoE ──────────────────────────────────────────────────────
    "ffn_gate_inp": {
        "label": "Routeur MoE",
        "category": CATEGORY_ROUTER,
        "role": (
            "Décide quel(s) expert(s) activer pour chaque token. Pivot "
            "central du mécanisme MoE."
        ),
        "impact": (
            "ULTRA critique. Dégrade → gating erratique, experts mal choisis, "
            "comportement appauvri ou instable. Petit tensor, gros levier."
        ),
        "reco": "F16 TOUJOURS (taille négligeable, impact énorme)",
    },
    # ── Norms ────────────────────────────────────────────────────────────
    "attn_norm": {
        "label": "Norm avant attention",
        "category": CATEGORY_NORMS,
        "role": "Normalisation RMSNorm/LayerNorm avant le bloc d'attention.",
        "impact": (
            "Critique mais tout petit (quelques k params). Dégrade → "
            "instabilité numérique, outputs extrêmes."
        ),
        "reco": "F16 TOUJOURS (taille négligeable)",
    },
    "ffn_norm": {
        "label": "Norm avant FFN",
        "category": CATEGORY_NORMS,
        "role": "Normalisation avant le bloc FFN.",
        "impact": "Même logique que attn_norm.",
        "reco": "F16 TOUJOURS",
    },
    "attn_k_norm": {
        "label": "Norm sur les Keys",
        "category": CATEGORY_NORMS,
        "role": "Normalisation spécifique sur K (architectures récentes).",
        "impact": "Critique, petit.",
        "reco": "F16 TOUJOURS",
    },
    "attn_q_norm": {
        "label": "Norm sur les Queries",
        "category": CATEGORY_NORMS,
        "role": "Normalisation spécifique sur Q (architectures récentes).",
        "impact": "Critique, petit.",
        "reco": "F16 TOUJOURS",
    },
    "output_norm": {
        "label": "Norm finale (pré-sortie)",
        "category": CATEGORY_NORMS,
        "role": "Dernière normalisation avant la projection vers vocab.",
        "impact": "Critique, petit.",
        "reco": "F16 TOUJOURS",
    },
    "post_attention_norm": {
        "label": "Norm post-attention (Gemma-4)",
        "category": CATEGORY_NORMS,
        "role": "Normalisation appliquée après le bloc d'attention (post-norm architecture).",
        "impact": "Critique, petit.",
        "reco": "F16 TOUJOURS",
    },
    "post_ffw_norm": {
        "label": "Norm post-FFN (Gemma-4)",
        "category": CATEGORY_NORMS,
        "role": "Normalisation appliquée après le bloc FFN (post-norm architecture).",
        "impact": "Critique, petit.",
        "reco": "F16 TOUJOURS",
    },
    # ── I/O ──────────────────────────────────────────────────────────────
    "token_embd": {
        "label": "Embedding d'entrée",
        "category": CATEGORY_IO,
        "role": (
            "Transforme chaque token-ID en vecteur d'entrée. TOUT passe par "
            "ici au début."
        ),
        "impact": (
            "Critique. Dégrade → représentation d'entrée bruitée, tous les "
            "calculs en aval en souffrent."
        ),
        "reco": "F16 (géré par preserve_embeddings)",
    },
    "output": {
        "label": "Projection finale vers vocab",
        "category": CATEGORY_IO,
        "role": (
            "Transforme le dernier hidden state en logits sur le vocabulaire. "
            "TOUT sort par ici."
        ),
        "impact": (
            "Critique. Dégrade → prédictions de tokens biaisées, "
            "probabilités déformées."
        ),
        "reco": "F16 (géré par preserve_embeddings)",
    },
    # ── Attention hybride (QKV fusionné, gate SSM/ATT) ───────────────────
    "attn_qkv": {
        "label": "Attention · QKV fusionné",
        "category": CATEGORY_ATTENTION,
        "role": (
            "Q, K et V fusionnés en un seul tensor pour les layers hybrides "
            "(ATT+SSM). Même rôle que Q+K+V séparés, format compact."
        ),
        "impact": (
            "Critique — porte à la fois le matching (K·Q) et le contenu (V) "
            "en un seul bloc. Aussi sensible que attn_k/q."
        ),
        "reco": "Q8_0 (sûr) · F16 pour quali max",
    },
    "attn_gate": {
        "label": "Attention · Gate (pondération ATT/SSM)",
        "category": CATEGORY_ATTENTION,
        "role": (
            "Pondère la contribution de l'attention vs le SSM en sortie "
            "(architectures hybrides Mamba+Attention). Décide combien de "
            "signal passe par l'attention vs par le SSM."
        ),
        "impact": (
            "Critique sur hybride — si dégradé, le modèle perd l'équilibre "
            "entre mémoire locale (SSM) et contexte global (attention)."
        ),
        "reco": "Q8_0 recommandé · F16 si budget",
    },
    # ── Shared experts (MoE avec expert commun) ──────────────────────────
    "ffn_gate_shexp": {
        "label": "Shared expert · Gate (valve SwiGLU)",
        "category": CATEGORY_FFN_SHARED_EXPERTS,
        "role": (
            "Valve SwiGLU du shared expert — l'expert commun activé pour "
            "TOUS les tokens, en plus des experts routés. Capture le savoir "
            "généraliste que tous les tokens partagent."
        ),
        "impact": "Modéré. Petit (1M params/layer), robuste.",
        "reco": "base OK · Q8 si budget",
    },
    "ffn_up_shexp": {
        "label": "Shared expert · Up projection",
        "category": CATEGORY_FFN_SHARED_EXPERTS,
        "role": "Up projection du shared expert. Symétrique à gate_shexp.",
        "impact": "Modéré. Petit, robuste.",
        "reco": "base OK",
    },
    "ffn_down_shexp": {
        "label": "Shared expert · Down projection",
        "category": CATEGORY_FFN_SHARED_EXPERTS,
        "role": (
            "Down projection du shared expert — la transformation apprise "
            "commune à tous les tokens."
        ),
        "impact": (
            "Plus critique que gate/up shared. Mais un seul expert parmi N+1 "
            "(N routés + 1 shared), donc impact dilué."
        ),
        "reco": "Q8_0 recommandé · base acceptable",
    },
    "ffn_gate_inp_shexp": {
        "label": "Routeur shared expert (bias/scale)",
        "category": CATEGORY_ROUTER,
        "role": (
            "Paramètre de routage du shared expert — contrôle son activation "
            "relative aux experts routés."
        ),
        "impact": "Critique, minuscule (2K params). F16/F32 obligatoire.",
        "reco": "F16 TOUJOURS (taille négligeable)",
    },
    # ── SSM (Mamba / State Space Model) ──────────────────────────────────
    "ssm_out": {
        "label": "SSM · Projection sortie",
        "category": CATEGORY_SSM,
        "role": (
            "Projette le hidden state SSM vers la dimension du réseau. "
            "C'est le 'cerveau' du SSM — porte la transformation apprise "
            "de la mémoire récurrente vers le résidu."
        ),
        "impact": (
            "Le plus critique du SSM. Dégrade → le modèle perd sa mémoire "
            "séquentielle locale, perte de cohérence sur les dépendances "
            "proches (<1K tokens)."
        ),
        "reco": "Q8_0 recommandé · F16 pour quali max",
    },
    "ssm_alpha": {
        "label": "SSM · Alpha (decay récurrence)",
        "category": CATEGORY_SSM,
        "role": (
            "Contrôle le taux de décroissance de la mémoire SSM — combien "
            "d'information des tokens précédents est conservée vs oubliée. "
            "Petit (65K params/layer)."
        ),
        "impact": (
            "Critique mais minuscule. Dégrade → dynamique temporelle "
            "perturbée, le modèle 'oublie' trop vite ou trop lentement."
        ),
        "reco": "F16 (taille négligeable, impact haut)",
    },
    "ssm_beta": {
        "label": "SSM · Beta (injection input)",
        "category": CATEGORY_SSM,
        "role": (
            "Contrôle combien de signal du token courant est injecté dans "
            "la mémoire SSM. Complémentaire à alpha. Petit (65K params/layer)."
        ),
        "impact": (
            "Critique mais minuscule. Dégrade → mauvais dosage "
            "token courant vs mémoire."
        ),
        "reco": "F16 (taille négligeable, impact haut)",
    },
    "ssm_conv1d": {
        "label": "SSM · Convolution 1D locale",
        "category": CATEGORY_SSM,
        "role": (
            "Convolution sur une fenêtre locale (4 tokens). Capture les "
            "patterns locaux avant injection dans la récurrence SSM. "
            "Très petit (33K params/layer)."
        ),
        "impact": "Modéré. Petit, fenêtre courte, robuste.",
        "reco": "F16 (taille négligeable)",
    },
    "ssm_dt": {
        "label": "SSM · Delta timestep",
        "category": CATEGORY_SSM,
        "role": (
            "Contrôle le 'pas de temps' de la dynamique SSM — régule la "
            "vitesse de transition d'état. Minuscule (32 params/layer)."
        ),
        "impact": "Critique, minuscule.",
        "reco": "F32/F16 TOUJOURS",
    },
    "ssm_norm": {
        "label": "SSM · Normalisation interne",
        "category": CATEGORY_NORMS,
        "role": "Normalisation du hidden state SSM entre les pas.",
        "impact": "Critique, minuscule (128 params/layer).",
        "reco": "F16 TOUJOURS",
    },
}


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


def family_doc(family: str, arch: str | None = None) -> dict[str, str]:
    """Docs pour une famille avec fallback générique.
    Si arch est fourni, enrichit la reco avec le contexte architectural."""
    if family in FAMILY_DOCS:
        doc = dict(FAMILY_DOCS[family])  # copie pour ne pas muter l'original
    else:
        doc = {
            "label": family,
            "category": family_category(family),
            "role": "(famille inconnue — pas de documentation pédagogique)",
            "impact": "Inconnu — laisser à la base du preset par défaut.",
            "reco": "base",
        }
    # Enrichissement contextuel par architecture
    if arch is not None:
        arch_reco = ARCH_RECO.get((doc["category"], arch))
        if arch_reco:
            doc["reco"] = arch_reco
    return doc


# Recommandations spécialisées par (catégorie, architecture).
# Quand l'architecture est connue, ces recos remplacent la reco générique
# de FAMILY_DOCS. L'ordre du texte détermine le défaut TUI (premier trouvé).
ARCH_RECO: dict[tuple[str, str], str] = {
    # ── Attention : même priorité dense et MoE ──────────────────────────
    # (pas de surcharge → garde la reco FAMILY_DOCS)

    # ── FFN dense ─────────────────────────────────────────────────────────
    (CATEGORY_FFN_DENSE, ARCH_DENSE): (
        "Q8_0 recommandé — seuls 3 tensors FFN par layer (gate/up/down), "
        "pas de redondance d'experts pour absorber le bruit"
    ),
    (CATEGORY_FFN_DENSE, ARCH_MOE): (
        "base OK — ne devrait pas exister sur MoE, ignorer"
    ),
    (CATEGORY_FFN_DENSE, ARCH_HYBRID): (
        "base OK — ne devrait pas exister sur hybride MoE, ignorer"
    ),

    # ── FFN experts ───────────────────────────────────────────────────────
    (CATEGORY_FFN_EXPERTS, ARCH_MOE): (
        "base OK — experts = 80-85% du volume, redondance naturelle "
        "(N experts, 2-8 actifs/token). Q8_0 si budget taille"
    ),
    (CATEGORY_FFN_EXPERTS, ARCH_HYBRID): (
        "base OK — experts = ~92% du volume, redondance naturelle + "
        "shared expert absorbe une partie du bruit"
    ),
    (CATEGORY_FFN_EXPERTS, ARCH_DENSE): (
        "base OK — ne devrait pas exister sur dense, ignorer"
    ),

    # ── Shared experts ────────────────────────────────────────────────────
    (CATEGORY_FFN_SHARED_EXPERTS, ARCH_HYBRID): (
        "base OK — expert commun, petit (~1M/layer), robuste. "
        "Q8_0 pour ffn_down_shexp si budget"
    ),
    (CATEGORY_FFN_SHARED_EXPERTS, ARCH_MOE): (
        "base OK — expert commun, petit, robuste"
    ),

    # ── Routeur ───────────────────────────────────────────────────────────
    (CATEGORY_ROUTER, ARCH_MOE): (
        "F16 TOUJOURS — pivot du gating MoE, taille négligeable, "
        "impact maximal si dégradé"
    ),
    (CATEGORY_ROUTER, ARCH_HYBRID): (
        "F16 TOUJOURS — pivot du gating MoE+shared, taille négligeable"
    ),

    # ── SSM ───────────────────────────────────────────────────────────────
    (CATEGORY_SSM, ARCH_HYBRID): (
        "ssm_out = Q8_0 (le plus gros, porte le savoir SSM) · "
        "alpha/beta/conv1d/dt = F16 (minuscules, critiques pour "
        "la dynamique temporelle)"
    ),
}

# Priorité de bump par (famille, architecture).
# Répond à la question "est-ce que ça vaut le coup de monter cette famille
# au-dessus de la base ?" — c'est ce qui guide la décision dans le builder.
#
# Labels :
#   "prioritaire" = bump rentable, mettre des bits ici en premier
#   "si budget"   = bump utile mais pas critique, Q6_K suffit souvent
#   "base OK"     = tolérant, garder la base
#   "auto F16"    = géré automatiquement (norms, router, I/O)
#
# Lookup : d'abord par (famille, arch), puis fallback par (catégorie, arch).
_FAMILY_PRIORITY: dict[tuple[str, str], tuple[str, str, int]] = {
    # ── Dense ──────────────────────────────────────────────────────────────
    # Attention
    ("attn_k",       ARCH_DENSE): ("prioritaire", "[red]",    0),
    ("attn_q",       ARCH_DENSE): ("prioritaire", "[red]",    0),
    ("attn_v",       ARCH_DENSE): ("si budget",   "[yellow]", 2),
    ("attn_output",  ARCH_DENSE): ("si budget",   "[yellow]", 2),
    # FFN dense — ffn_down est le plus rentable à bumper
    ("ffn_down",     ARCH_DENSE): ("prioritaire", "[red]",    1),
    ("ffn_gate",     ARCH_DENSE): ("base OK",     "[green]",  3),
    ("ffn_up",       ARCH_DENSE): ("base OK",     "[green]",  3),

    # ── MoE ────────────────────────────────────────────────────────────────
    # Attention (même que dense)
    ("attn_k",       ARCH_MOE):   ("prioritaire", "[red]",    0),
    ("attn_q",       ARCH_MOE):   ("prioritaire", "[red]",    0),
    ("attn_v",       ARCH_MOE):   ("si budget",   "[yellow]", 2),
    ("attn_output",  ARCH_MOE):   ("si budget",   "[yellow]", 2),
    # Experts — redondance naturelle, tolérants
    ("ffn_down_exps",     ARCH_MOE): ("si budget",   "[yellow]", 2),
    ("ffn_gate_exps",     ARCH_MOE): ("base OK",     "[green]",  3),
    ("ffn_up_exps",       ARCH_MOE): ("base OK",     "[green]",  3),
    ("ffn_gate_up_exps",  ARCH_MOE): ("base OK",     "[green]",  3),

    # ── Hybride MoE+SSM (Qwen3.6, Jamba, …) ──────────────────────────────
    # Attention — QKV fusionné porte K+Q+V, aussi critique que K/Q séparés
    ("attn_qkv",     ARCH_HYBRID): ("prioritaire", "[red]",    0),
    ("attn_k",       ARCH_HYBRID): ("prioritaire", "[red]",    0),
    ("attn_q",       ARCH_HYBRID): ("prioritaire", "[red]",    0),
    ("attn_v",       ARCH_HYBRID): ("si budget",   "[yellow]", 2),
    ("attn_output",  ARCH_HYBRID): ("si budget",   "[yellow]", 2),
    # attn_gate — pondère ATT vs SSM, plus critique sur hybride que sur dense
    ("attn_gate",    ARCH_HYBRID): ("prioritaire", "[red]",    1),
    # Experts MoE — même logique que MoE pur
    ("ffn_down_exps",     ARCH_HYBRID): ("si budget",   "[yellow]", 2),
    ("ffn_gate_exps",     ARCH_HYBRID): ("base OK",     "[green]",  3),
    ("ffn_up_exps",       ARCH_HYBRID): ("base OK",     "[green]",  3),
    ("ffn_gate_up_exps",  ARCH_HYBRID): ("base OK",     "[green]",  3),
    # Shared experts — petits, robustes
    ("ffn_down_shexp",    ARCH_HYBRID): ("si budget",   "[yellow]", 2),
    ("ffn_gate_shexp",    ARCH_HYBRID): ("base OK",     "[green]",  3),
    ("ffn_up_shexp",      ARCH_HYBRID): ("base OK",     "[green]",  3),
    # SSM — ssm_out est le cerveau, alpha/beta/conv1d/dt sont minuscules
    ("ssm_out",      ARCH_HYBRID): ("prioritaire", "[red]",    1),
    ("ssm_alpha",    ARCH_HYBRID): ("auto F16",    "[dim]",   -1),
    ("ssm_beta",     ARCH_HYBRID): ("auto F16",    "[dim]",   -1),
    ("ssm_conv1d",   ARCH_HYBRID): ("auto F16",    "[dim]",   -1),
    ("ssm_dt",       ARCH_HYBRID): ("auto F16",    "[dim]",   -1),
}

# Fallback par catégorie quand la famille exacte n'est pas listée
_CATEGORY_PRIORITY: dict[tuple[str, str], tuple[str, str, int]] = {
    (CATEGORY_NORMS,        ARCH_DENSE): ("auto F16",    "[dim]",    -1),
    (CATEGORY_IO,           ARCH_DENSE): ("auto F16",    "[dim]",    -1),
    (CATEGORY_ATTENTION,    ARCH_DENSE): ("si budget",   "[yellow]", 2),
    (CATEGORY_FFN_DENSE,    ARCH_DENSE): ("base OK",     "[green]",  3),
    (CATEGORY_OTHER,        ARCH_DENSE): ("?",           "[dim]",    4),

    (CATEGORY_NORMS,        ARCH_MOE):   ("auto F16",    "[dim]",    -1),
    (CATEGORY_ROUTER,       ARCH_MOE):   ("auto F16",    "[dim]",    -1),
    (CATEGORY_IO,           ARCH_MOE):   ("auto F16",    "[dim]",    -1),
    (CATEGORY_ATTENTION,    ARCH_MOE):   ("si budget",   "[yellow]", 2),
    (CATEGORY_FFN_EXPERTS,  ARCH_MOE):   ("base OK",     "[green]",  3),
    (CATEGORY_FFN_DENSE,    ARCH_MOE):   ("base OK",     "[green]",  3),
    (CATEGORY_OTHER,        ARCH_MOE):   ("?",           "[dim]",    4),

    (CATEGORY_NORMS,               ARCH_HYBRID): ("auto F16",    "[dim]",    -1),
    (CATEGORY_ROUTER,              ARCH_HYBRID): ("auto F16",    "[dim]",    -1),
    (CATEGORY_IO,                  ARCH_HYBRID): ("auto F16",    "[dim]",    -1),
    (CATEGORY_SSM,                 ARCH_HYBRID): ("si budget",   "[yellow]", 2),
    (CATEGORY_ATTENTION,           ARCH_HYBRID): ("si budget",   "[yellow]", 2),
    (CATEGORY_FFN_EXPERTS,         ARCH_HYBRID): ("base OK",     "[green]",  3),
    (CATEGORY_FFN_SHARED_EXPERTS,  ARCH_HYBRID): ("base OK",     "[green]",  3),
    (CATEGORY_FFN_DENSE,           ARCH_HYBRID): ("base OK",     "[green]",  3),
    (CATEGORY_OTHER,               ARCH_HYBRID): ("?",           "[dim]",    4),
}


def family_priority(family: str, arch: str) -> tuple[str, str, int]:
    """Retourne (label, couleur_rich, ordre_tri) de priorité de bump.
    Lookup par famille exacte, puis fallback par catégorie."""
    result = _FAMILY_PRIORITY.get((family, arch))
    if result:
        return result
    cat = family_category(family)
    return _CATEGORY_PRIORITY.get((cat, arch), ("?", "[dim]", 4))


def _regex_escape_tensor(name: str) -> str:
    """Échappe un nom de tensor pour regex exacte (pour tensor-type override)."""
    return re.escape(name)


_FAMILY_RX = re.compile(r"(?:^|\.)([^.]+)\.(?:weight|bias)$")


def _family_of(tensor_name: str) -> str:
    """Dernier segment avant .weight. Fallback '_other' si pas de match."""
    m = _FAMILY_RX.search(tensor_name)
    return m.group(1) if m else "_other"


def emit_preset(
    tensors: list[TensorStat],
    profile: str,
    name: str,
    base: str | None = None,
    top_f16: float | None = None,
    top_q8: float | None = None,
    top_per_family: float | None = None,
) -> tuple[dict, dict]:
    """Dispatch vers la stratégie selon le mode du profile."""
    prof = PROFILES[profile]
    mode = prof.get("mode", "cumulative")

    if mode == "per_family":
        return _emit_preset_per_family(
            tensors, profile, name,
            base=base or prof["default_base"],
            top_per_family=top_per_family if top_per_family is not None
                           else prof["top_per_family"],
        )
    # Mode historique cumulative
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
    """Stratification par composant + pins F16 fixes. Plancher = base (Q8_0).

    Pour chaque famille (attn_k, ffn_down, ffn_gate_up_exps, …), les top X%
    par sum_values passent F16 individuellement. Le reste retombe sur base.
    Plus les pins F16 fixes (norms + routers) via regex larges."""

    families: dict[str, list[TensorStat]] = defaultdict(list)
    for t in tensors:
        families[_family_of(t.name)].append(t)

    # Top N par famille (au moins 1 tensor par famille pour que les petites
    # familles soient aussi représentées)
    f16_names: set[str] = set()
    picks_per_family: dict[str, int] = {}
    for fam, ts in families.items():
        sorted_ts = sorted(ts, key=lambda t: t.sum_values, reverse=True)
        n_top = max(1, math.ceil(len(sorted_ts) * top_per_family))
        picks_per_family[fam] = n_top
        for t in sorted_ts[:n_top]:
            f16_names.add(t.name)

    # Construit les overrides : pins (regex larges) d'abord, puis tensors
    # individuels (regex exacts).
    overrides: list[str] = list(F16_PIN_REGEXES)
    for tname in sorted(f16_names):
        overrides.append(f"{re.escape(tname)}=F16")

    # Stats tiers
    tier_counts = {
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
    """Mode cumulative historique : tri global par sum desc, tiers séquentiels.

    Stratégie : trie les tensors par sum_values desc, cumule, affecte chaque
    tensor au tier dont la borne cumulative couvre sa position.
    """
    prof = PROFILES[profile]
    base = base or prof["default_base"]

    # Override manuel des cuts
    tiers = [list(t) for t in prof["tiers"]]
    if top_f16 is not None and tiers and tiers[0][0] == "F16":
        tiers[0][1] = top_f16
    if top_q8 is not None and len(tiers) > 1 and tiers[1][0] == "Q8_0":
        tiers[1][1] = top_q8

    # Cuts en valeurs absolues (cumul progressif)
    total = sum(t.sum_values for t in tensors) or 1.0
    sorted_t = sorted(tensors, key=lambda t: t.sum_values, reverse=True)

    overrides: list[str] = []
    assignments: dict[str, str] = {}  # tensor_name → target_type

    cum = 0.0
    tier_idx = 0

    for t in sorted_t:
        # Assigne au tier courant AVANT de cumuler — garantit que le tensor
        # qui croise la borne appartient au tier qu'il fait déborder.
        if tier_idx < len(tiers):
            assignments[t.name] = tiers[tier_idx][0]
        # else : tombe sur le base, pas d'override explicite

        cum += t.sum_values
        cum_ratio = cum / total

        # Si on a dépassé la borne courante, on avance au tier suivant pour
        # le prochain tensor.
        while tier_idx < len(tiers) and cum_ratio > tiers[tier_idx][1]:
            tier_idx += 1

    # Construit les overrides regex (un par tensor exact) en regroupant par
    # type pour produire moins de règles quand un pattern simple couvre tout.
    # On essaie un regroupement naïf : si un type couvre 100% d'un pattern
    # "^blk\.N\..+=TYPE", on émet le pattern ; sinon on émet individuel.
    # Pour rester prévisible, on émet individuel par défaut.
    by_type: dict[str, list[str]] = defaultdict(list)
    for tname, ttype in assignments.items():
        by_type[ttype].append(tname)

    # Ordre de sortie : F16 en premier (priorité visuelle), puis Q8, etc.
    type_order = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M"]
    order_sorted = sorted(by_type.keys(),
                          key=lambda t: type_order.index(t) if t in type_order else 99)

    for ttype in order_sorted:
        for tname in sorted(by_type[ttype]):
            overrides.append(f"{_regex_escape_tensor(tname)}={ttype}")

    # Résumé tiers
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
    return preset, tier_counts


def emit_preset_custom(
    tensors: list[TensorStat],
    name: str,
    base: str,
    family_quants: dict[str, str],
    top_per_family_f16: dict[str, float] | float = 0.0,
    f16_pins: list[str] | None = None,
    bonus_type: str = "F16",
) -> tuple[dict, dict]:
    """Émet un preset depuis les choix explicites du builder TUI.

    Arguments :
    - family_quants : map {famille → type}. Type peut être "F16", "Q8_0",
      "Q6_K", "Q5_K_M", "Q4_K_M" ou "base" (= fallback sur `base`). Si une
      famille n'est pas dans la map, elle tombe sur `base`.
    - top_per_family_f16 : fraction [0..1] des top tensors de chaque famille
      (par sum_values) à forcer en bonus_type, indépendamment du family_quants.
      Accepte un float global OU un dict {famille → pct} pour un bonus
      différent par famille. Les familles absentes du dict → 0%.
    - f16_pins : liste de regex supplémentaires en F16/bonus_type (par défaut:
      norms + ffn_gate_inp via F16_PIN_REGEXES).
    - bonus_type : type pour les bonus et pins. "F16" pour source F16/BF16,
      "Q8_0" pour source Q8 (re-quantize). Les pins =F16 sont remplacés par
      =bonus_type.

    Retourne (preset_dict, tier_counts) — le preset contient un champ
    `family_quants` (consommé par build_quantize_overrides côté brain-quant)
    plus les `tensor_overrides` spécifiques (pins + top-par-famille bonus)."""
    # Remplacer =F16 dans les pins par =bonus_type si source Q8
    if f16_pins is not None:
        if bonus_type != "F16":
            f16_pins = [p.replace("=F16", f"={bonus_type}") for p in f16_pins]
    else:
        pins = list(F16_PIN_REGEXES)
        if bonus_type != "F16":
            pins = [p.replace("=F16", f"={bonus_type}") for p in pins]
        f16_pins = pins

    # Normalise top_per_family_f16 en dict {fam → pct}
    if isinstance(top_per_family_f16, dict):
        bonus_map = top_per_family_f16
    else:
        # Float global → appliqué à toutes les familles
        bonus_map = None  # sentinel: global value
        global_bonus = top_per_family_f16

    # Grouper par famille pour top_per_family_f16
    families_in_imatrix: dict[str, list[TensorStat]] = defaultdict(list)
    for t in tensors:
        families_in_imatrix[_family_of(t.name)].append(t)

    # Sélection des top-X% par famille si demandé (s'applique par-dessus
    # family_quants : un tensor F16 par top-X% override le family_quants).
    top_f16_names: set[str] = set()
    top_f16_by_family: dict[str, int] = {}  # pour le récap
    for fam, ts in families_in_imatrix.items():
        # Détermine le bonus pour cette famille
        if bonus_map is not None:
            fam_bonus = bonus_map.get(fam, 0.0)
        else:
            fam_bonus = global_bonus
        if fam_bonus <= 0:
            continue
        # Skip si la famille est déjà au bonus_type ou base == bonus_type
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

    # Construit tensor_overrides : pins (regex large) + top-X% (exact)
    overrides: list[str] = list(f16_pins)
    for tname in sorted(top_f16_names):
        overrides.append(f"{_regex_escape_tensor(tname)}={bonus_type}")

    # Nettoie family_quants : retire les entrées "base" (inutile, c'est le
    # fallback implicite)
    clean_family_quants = {
        fam: quant for fam, quant in family_quants.items()
        if quant != "base"
    }

    # Compte tiers pour l'affichage récap
    tier_counts: dict[str, int] = defaultdict(int)
    tier_counts[f"{bonus_type} (pins auto)"] = len(f16_pins)
    # Bonus par famille (détaillé si per-family, global sinon)
    if top_f16_by_family:
        for bf, bn in sorted(top_f16_by_family.items(), key=lambda x: -x[1]):
            fam_total = len(families_in_imatrix.get(bf, []))
            pct_actual = int(bn / fam_total * 100) if fam_total > 0 else 0
            tier_counts[f"{bonus_type} bonus {pct_actual}% (famille {bf})"] = bn
    for fam, quant in clean_family_quants.items():
        n_fam = len(families_in_imatrix.get(fam, []))
        # Soustraire les tensors bonus F16 de cette famille
        n_bonus = top_f16_by_family.get(fam, 0)
        n_remaining = n_fam - n_bonus
        if n_remaining > 0:
            tier_counts[f"{quant} (famille {fam})"] = n_remaining
    # Tensors restants tombent sur base (aussi soustraire les bonus)
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


def append_preset_to_config(preset: dict, config_path: Path) -> None:
    """Append le preset à config.yaml sous `quants:`. Backup .bak."""
    if not config_path.exists():
        raise FileNotFoundError(config_path)
    backup = config_path.with_suffix(".yaml.bak")
    backup.write_bytes(config_path.read_bytes())

    cfg = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    quants = cfg.get("quants", [])
    # Vire le preset existant de même nom (idempotence)
    quants = [q for q in quants if q.get("name") != preset["name"]]
    quants.append(preset)
    cfg["quants"] = quants

    # On ré-écrit en YAML. Perd les commentaires — backup sauve le cul.
    config_path.write_text(
        yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False, width=120),
        encoding="utf-8",
    )
    console.print(f"[green]✓[/] Preset [bold]{preset['name']}[/] ajouté à {config_path}")
    console.print(f"  [dim]Backup : {backup}[/]")


# ────────────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Inspecte un fichier imatrix llama.cpp.")
    ap.add_argument("imatrix", type=Path, help="Chemin vers le .imatrix (.dat)")
    ap.add_argument("--top", type=int, default=40,
                    help="Nombre de tensors à afficher (default: 40)")
    ap.add_argument("--sort", choices=("sum", "l2", "mean"), default="sum",
                    help="Tri : sum des values (default), L2-norm, ou mean")
    ap.add_argument("--group", metavar="REGEX",
                    help="Regex de groupement (ex: 'blk\\.(\\d+)' par couche, "
                         "'blk\\.\\d+\\.(.+?)\\.' par composant)")
    ap.add_argument("--no-detail", action="store_true",
                    help="Skip le tableau détaillé (juste groupes)")

    # Émission preset
    ap.add_argument("--emit-preset", action="store_true",
                    help="Émet un preset YAML tensor_overrides.")
    ap.add_argument("--name", default="Q_auto",
                    help="Nom du preset (default: Q_auto)")
    ap.add_argument("--profile", choices=list(PROFILES.keys()), default="3tier",
                    help="Profile de tiering (default: 3tier). "
                         "cumulative (2/3/4tier) = reco dense ; "
                         "surgical* = reco MoE")
    ap.add_argument("--base", help="Quant de base (default: selon profile)")
    ap.add_argument("--top-f16", type=float,
                    help="[cumulative] Override ratio cumulé F16 (default: selon profile)")
    ap.add_argument("--top-q8", type=float,
                    help="[cumulative] Override ratio cumulé Q8 (default: selon profile)")
    ap.add_argument("--top-per-family", type=float,
                    help="[surgical] Override fraction F16 par famille (default: selon profile)")
    ap.add_argument("--append-config", action="store_true",
                    help="Append le preset au config.yaml (backup .bak créé).")
    ap.add_argument("--config", type=Path, default=CONFIG_PATH,
                    help=f"Chemin config.yaml (default: {CONFIG_PATH})")

    args = ap.parse_args()

    if not args.imatrix.exists():
        console.print(f"[red]✗[/] Introuvable : {args.imatrix}")
        sys.exit(1)

    console.print()
    console.print(Panel.fit(
        f"[bold magenta]inspect-imatrix[/] · {args.imatrix.name}",
        border_style="magenta",
    ))

    try:
        tensors, ncall_total, dataset = parse_imatrix(args.imatrix)
    except Exception as e:
        console.print(f"[red]✗ parse error:[/] {e}")
        sys.exit(2)

    total_sum = sum(t.sum_values for t in tensors)
    console.print(
        f"  [dim]tensors   [/] {len(tensors)}\n"
        f"  [dim]ncall tot.[/] {ncall_total}\n"
        f"  [dim]dataset   [/] {dataset or '(non renseigné)'}\n"
        f"  [dim]Σ sum     [/] {fmt_float(total_sum)}"
    )
    console.print()

    if not args.no_detail:
        show_tensor_table(tensors, args.top, args.sort)
        console.print()

    if args.group:
        show_grouped_table(tensors, args.group, args.sort)
        console.print()

    if args.emit_preset:
        preset, tier_counts = emit_preset(
            tensors,
            profile=args.profile,
            name=args.name,
            base=args.base,
            top_f16=args.top_f16,
            top_q8=args.top_q8,
            top_per_family=args.top_per_family,
        )

        # Affiche le résumé tiers
        tier_table = Table(title=f"Preset [bold]{preset['name']}[/]",
                           header_style="bold green", box=None, padding=(0, 2))
        tier_table.add_column("Tier")
        tier_table.add_column("Tensors", justify="right")
        for t, c in tier_counts.items():
            tier_table.add_row(str(t), str(c))
        console.print(tier_table)
        console.print()

        # YAML prêt à coller
        yaml_block = yaml.safe_dump([preset], allow_unicode=True,
                                    sort_keys=False, width=120)
        console.print(Panel(
            yaml_block.rstrip(),
            title="[bold]Preset YAML (prêt à coller sous `quants:`)[/]",
            border_style="green",
            padding=(1, 2),
        ))
        console.print()

        if args.append_config:
            append_preset_to_config(preset, args.config)


# ════════════════════════════════════════════════════════════════════════════
# FAQ — Guide de quantization pour débutants et référence avancée
# ════════════════════════════════════════════════════════════════════════════
#
# ── Concepts fondamentaux ──────────────────────────────────────────────────
#
# Q: C'est quoi une imatrix ?
# A: Une "importance matrix" — on fait tourner le modèle F16 sur un corpus de
#    calibration et on mesure l'énergie d'activation (sum(x²)) de chaque
#    colonne de chaque tensor. Plus un tensor absorbe d'énergie, plus il est
#    "chaud" — le quantiser agressivement amplifiera les erreurs d'arrondi.
#    L'imatrix guide llama-quantize pour allouer plus de précision aux zones
#    critiques (colonnes chaudes gardent plus de bits).
#
# Q: C'est quoi "bits per weight" (bpw) ?
# A: Le nombre moyen de bits utilisés pour stocker un poids du modèle.
#    F16 = 16 bpw (référence), Q8_0 ≈ 8.5 bpw, Q6_K ≈ 6.5 bpw,
#    Q4_K_M ≈ 4.5 bpw. Plus c'est bas, plus le fichier est petit, mais plus
#    la qualité se dégrade. Le sweet spot dépend du modèle et de l'usage.
#
# Q: Quelle différence entre Q6_K et Q6_K avec imatrix ?
# A: Sans imatrix, llama-quantize traite toutes les colonnes d'un tensor de
#    manière identique. Avec imatrix, il alloue plus de bits aux colonnes
#    chaudes (outliers) et compresse davantage les colonnes froides. Même
#    type de quant, même taille fichier, mais meilleure qualité.
#
# ── Familles de tensors ────────────────────────────────────────────────────
#
# Q: C'est quoi une "famille" de tensors ?
# A: Le dernier segment du nom avant .weight/.bias. Par exemple
#    "blk.0.attn_k.weight" → famille "attn_k". Tous les layers partagent
#    la même structure, donc "attn_k" regroupe les tensors K de tous les
#    layers. Le builder travaille par famille car un même composant a le
#    même rôle et la même priorité partout dans le réseau.
#
# Q: Quelles familles sont prioritaires pour le bump ?
# A: Par priorité de bump décroissante (où mettre ses bits en premier) :
#
#    1. NORMS (attn_norm, ffn_norm, output_norm, k/q_norm…)
#       → F16 TOUJOURS. Tout petits (quelques Ko), mais stabilisent
#         numériquement chaque layer. Les quantiser = instabilité.
#
#    2. ROUTEUR MOE (ffn_gate_inp) — MoE uniquement
#       → F16 TOUJOURS. Décide quel expert traite chaque token. Petit
#         tensor, levier énorme. Dégrader = gating erratique, experts mal
#         choisis, comportement instable ou répétitif.
#
#    3. I/O (token_embd, output)
#       → F16 via preserve_embeddings. TOUT le signal entre/sort par là.
#
#    4. ATTENTION K et Q (attn_k, attn_q)
#       → Q8_0 minimum, F16 idéal. C'est le "matching" : chaque token
#         publie une clé (K) et formule une requête (Q). Si K·Q est bruité,
#         le modèle "rate" des connexions contextuelles. Effet amplifié en
#         long context (>4K tokens) car les erreurs s'accumulent sur de
#         nombreuses paires.
#       → Portent typiquement 50-60% de l'énergie imatrix totale à eux deux.
#       → Si tu ne peux mettre que 2 familles en F16, c'est celles-ci.
#
#    5. ATTENTION V (attn_v)
#       → Q8_0 sûr, Q6_K acceptable. C'est le contenu qui circule une fois
#         que K et Q se sont matchés. Moins fragile car le "routage" (K·Q)
#         est déjà fait.
#
#    6. ATTENTION OUTPUT (attn_output)
#       → Base OK, Q8_0 si budget. Reprojection de sortie, compensable par
#         les couches suivantes.
#
#    7. FFN DOWN (ffn_down / ffn_down_exps)
#       → Le plus critique des FFN. Porte le "savoir appris" — la
#         transformation finale de chaque bloc. Q8_0 recommandé.
#       → Sur dense : pas de redondance, chaque layer n'a qu'un ffn_down.
#       → Sur MoE : redondance naturelle (N experts), plus tolérant.
#
#    8. FFN GATE et UP (ffn_gate, ffn_up / ffn_gate_up_exps)
#       → Les plus tolérants. Base OK. Gate = valve SwiGLU, Up = projection
#         vers l'espace de travail. Robustes à la quantization.
#       → Sur MoE, les experts FFN font 80-85% du volume total. C'est en
#         les compressant qu'on gagne le plus de taille.
#
# ── Recettes par objectif ──────────────────────────────────────────────────
#
# Q: Je veux la meilleure qualité possible en dessous de F16 ?
# A: Preset type "Q8_K_MAX" (MoE) ou Q8_0 avec attn K/Q en F16 (dense).
#    Tout en Q8_0 sauf norms/emb/output en F16. ~0.55× F16.
#    Le Q8_0 a un léger effet régularisant qui peut STABILISER certains
#    modèles instables en F16 pur (observé sur distills Opus-like).
#
# Q: Je veux un bon compromis taille/qualité ?
# A: UD-Q6_K_XL ou le Custom Builder avec :
#      base=Q6_K, attn_k=Q8_0, attn_q=Q8_0, reste=base
#      preserve_embeddings=true, pins F16, top 5-10% F16/famille
#    → ~0.43× F16. Quasi indiscernable du F16 sur prose.
#
# Q: Je veux un "Q6++" — Q6 mais un peu mieux ?
# A: Pareil que ci-dessus. Le "++" vient du ciblage, pas du volume F16 :
#      - attn_k + attn_q → Q8_0 (bump le matching)
#      - ffn_down → Q8_0 (bump le savoir)
#      - tout le reste → Q6_K (base)
#    → ~0.45× F16. Mieux qu'un Q6_K brut pour à peine plus gros.
#
# Q: Et un "Q6++" avec du F16 chirurgical ?
# A: Si tu peux te permettre un peu plus de taille, les deux familles les
#    plus rentables à passer en F16 sont attn_k et attn_q :
#      - attn_k + attn_q → F16 (56% de l'énergie, coût ~8 GB)
#      - ffn_down → Q8_0
#      - tout le reste → Q6_K
#    → ~0.48× F16. Le meilleur ratio quali/taille sur base Q6.
#
# Q: Je veux du compact (budget taille limité) ?
# A: UD-Q5_K_M (~0.36×) ou UD-Q4_K_M (~0.30×) avec imatrix custom.
#    En dessous de Q4_K_M, la qualité chute vite sauf IQ quants avec
#    une très bonne imatrix.
#
# ── Dense vs MoE ──────────────────────────────────────────────────────────
#
# Q: Pourquoi la distinction dense/MoE est importante ?
# A: Parce que la structure du modèle change radicalement la stratégie :
#
#    DENSE (Llama, Mistral, Phi, Qwen…)
#    - 3 tensors FFN par layer (gate, up, down) — pas de redondance
#    - ffn_down est critique, un seul exemplaire par layer
#    - Les profils cumulatifs (2tier/3tier) fonctionnent bien : le tri
#      global par énergie est pertinent car tous les tensors sont du même
#      type
#
#    MOE (Gemma-4, Mixtral, DeepSeek-V2…)
#    - N experts FFN par layer (8, 16, 64…), seulement 2-8 actifs/token
#    - Les experts = 80-85% du volume et de l'énergie imatrix
#    - Redondance naturelle → plus tolérants à la quantization
#    - MAIS le routeur (ffn_gate_inp) est ULTRA critique → F16 obligatoire
#    - Les profils cumulatifs ÉCHOUENT : les experts dominent l'énergie,
#      le tri global met tout en F16 ou tout en base, sans granularité
#    - → Utiliser surgical ou custom (per-family) pour que chaque composant
#      conserve ses propres outliers indépendamment
#
# Q: Comment savoir si mon modèle est dense ou MoE ?
# A: brain-quant le détecte automatiquement en cherchant les familles MoE
#    dans l'imatrix (ffn_gate_inp, *_exps). Tu confirmes au lancement.
#    En cas de doute : si le modèle a "MoE" dans le nom ou si sa taille
#    F16 est disproportionnée par rapport au nombre de paramètres "actifs"
#    annoncé (ex: 27B actifs mais 52 GB F16), c'est un MoE.
#
# ── Concentration d'énergie ────────────────────────────────────────────────
#
# Q: C'est quoi l'indicateur "Concentration top 10%" dans le builder ?
# A: Il mesure quelle fraction de l'énergie totale d'une famille est
#    concentrée dans les 10% de colonnes les plus chaudes.
#      - >50% concentré (rouge) → quelques colonnes portent presque tout le
#        signal. Ces outliers sont fragiles : si la quant les arrondit, la
#        qualité chute. → Privilégier Q8_0 ou F16.
#      - <25% diffus (vert) → l'énergie est répartie uniformément. Pas
#        d'outliers dominants, la quant impacte tout pareil. → Base OK,
#        l'imatrix n'a pas grand-chose à sauver.
#      - 25-50% modéré (jaune) → entre les deux, choix selon le budget.
#
# ── Calibration ────────────────────────────────────────────────────────────
#
# Q: Le corpus de calibration change quelque chose ?
# A: Oui, significativement pour les quants agressifs (Q4 et en dessous).
#    L'imatrix mesure quelles colonnes sont chaudes SUR CE CORPUS. Un corpus
#    de code produira une imatrix différente d'un corpus de prose littéraire.
#    Idéal : corpus représentatif de l'usage cible (même langue, même
#    domaine, même style). Pour un usage généraliste, un mix diversifié
#    (prose + code + dialogue) est le meilleur compromis.
#
# Q: Combien de chunks faut-il ?
# A: 100-200 chunks est le sweet spot. En dessous de 50, l'imatrix est
#    bruitée (pas assez de statistiques). Au-dessus de 300, les rendements
#    sont décroissants — le temps de calcul augmente mais la qualité de
#    l'imatrix plafonne. ctx=4096 est le minimum raisonnable ; ctx=8192
#    améliore la couverture long-context si ton usage le nécessite.
#
# ── Pièges courants ────────────────────────────────────────────────────────
#
# Q: J'ai mis le max de F16 possible mais le modèle est instable ?
# A: Paradoxalement, F16 peut être MOINS stable que Q8_0 sur certains
#    modèles (observé sur distills type Claude-Opus → Gemma). Le Q8 a un
#    léger effet de bruit/régularisation qui casse les attracteurs de
#    répétition. Si F16 est instable, essayer Q8_K_MAX (tout Q8 sauf
#    norms/emb/output en F16).
#
# Q: Pourquoi ne pas quantiser chaque layer différemment (mix F16/Q8) ?
# A: Les quants HÉTÉROGÈNES par layer (couche 0 en F16, couche 1 en Q8…)
#    sont INSTABLES sur long context. Les conversions de type entre layers
#    adjacents accumulent des erreurs d'arrondi asymétriques qui poussent
#    vers des attracteurs de répétition. Les quants UNIFORMES par layer
#    (même type partout au sein d'une famille) sont stables même agressifs.
#
# Q: Mon preset custom est plus gros que prévu ?
# A: Vérifier que preserve_embeddings est activé (sinon token_embd/output
#    tombent au plancher base au lieu de F16 — et l'estimation de taille
#    sera fausse car elle assume F16 pour ces tensors). Vérifier aussi que
#    les pins F16 sont activés — les norms sont petits mais le routeur MoE
#    non-pinné sera compté à la base.
#
# ════════════════════════════════════════════════════════════════════════════


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrompu.[/]")
        sys.exit(130)
