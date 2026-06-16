"""Scan filesystem : modèles sources, calibrations, GGUFs produits, imatrices.

Port direct de brain-quant.py:78-321 (data classes + scanners). Ajoute
`scan_imatrices()` pour lister les .imatrix cachés dans imatrix_dir
(consommé par le brain-daemon `/quant/imatrices` endpoint).

Toutes les data classes ont une méthode `.to_dict()` pour sérialisation JSON
(API brain-daemon).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# ────────────────────────────────────────────────────────────────────────────
# Data classes
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class ModelEntry:
    """Un modèle GGUF source détecté (F16/BF16/Q8_0, avec ses shards groupés)."""
    display_name: str        # chemin relatif au models_path, sans suffix quant
    first_shard: Path        # fichier 00001-of-NNNNN ou fichier unique
    total_shards: int        # 1 si pas sharded
    total_bytes: int         # somme de tous les shards
    quant_tag: str           # "F16", "BF16" ou "Q8_0"

    @property
    def is_requantize(self) -> bool:
        """True si la source est déjà quantisée (Q8_0) — nécessite --allow-requantize."""
        return self.quant_tag not in ("F16", "BF16")

    @property
    def top_type(self) -> str:
        """Type 'plafond' de la source (pour preserve_embeddings / bonus).

        F16/BF16 → F16, Q8_* → Q8_0. Un K-quant/IQ déjà bas (ex Q3_K_L) → renvoie
        son tag RÉEL : le builder ne tentera PAS de bumper output/embd vers le haut
        (llama-quantize l'interdit : "requantizing from type q6_K is disabled").
        --allow-requantize reste posé tant que ce n'est pas F16/BF16.
        """
        if not self.is_requantize:
            return "F16"
        if self.quant_tag in ("Q8_0", "Q8_K"):
            return "Q8_0"
        return self.quant_tag

    @property
    def base_name(self) -> str:
        """Nom de fichier sans shard suffix ni tag quant (pour naming output)."""
        name = self.first_shard.name
        name = re.sub(r"\.gguf$", "", name)
        name = re.sub(r"-\d{5}-of-\d{5}$", "", name)
        name = re.sub(r"[-_.](F16|BF16|FP16|Q8_\w+)$", "", name, flags=re.IGNORECASE)
        return name

    def to_dict(self) -> dict[str, Any]:
        return {
            "display_name": self.display_name,
            "first_shard": str(self.first_shard),
            "total_shards": self.total_shards,
            "total_bytes": self.total_bytes,
            "quant_tag": self.quant_tag,
            "is_requantize": self.is_requantize,
            "base_name": self.base_name,
        }


@dataclass
class CalibEntry:
    path: Path
    size_bytes: int

    @property
    def est_tokens(self) -> int:
        """Estimation grossière : ~3.8 bytes/token pour du FR/EN markdown mixé."""
        return int(self.size_bytes / 3.8)

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "name": self.path.name,
            "size_bytes": self.size_bytes,
            "est_tokens": self.est_tokens,
        }


@dataclass
class GgufEntry:
    """GGUF générique (sources + outputs). Utilisé par scan_all_gguf."""
    path: Path
    display: str
    size_bytes: int
    quant_tag: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "display": self.display,
            "size_bytes": self.size_bytes,
            "quant_tag": self.quant_tag,
        }


@dataclass
class ImatrixEntry:
    """Fichier .imatrix caché dans imatrix_dir."""
    name: str
    path: Path
    size_bytes: int
    mtime: float        # unix timestamp

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": str(self.path),
            "size_bytes": self.size_bytes,
            "mtime": self.mtime,
        }


# ────────────────────────────────────────────────────────────────────────────
# Regex patterns (partagés)
# ────────────────────────────────────────────────────────────────────────────

# F16 / BF16 / FP16 / Q8_* détectés avec n'importe quel séparateur autour.
# Capture aussi dans le nom du dossier parent ("F16/model.gguf").
_QUANT_TAG_RE = re.compile(
    r"(?:^|[-_.\s/\\])(F16|BF16|FP16|Q8_\w+)(?:[-_.\s/\\]|\.gguf$|$)",
    re.IGNORECASE,
)
# Sources REQUANTIZABLES : F16/BF16 (idéal) + tout quant standard llama.cpp.
# On peut requantizer un K-quant/IQ plus bas via --allow-requantize (ex:
# MiniMax Q3_K_L 110 GB → Q2_K ~80 GB). is_requantize=True pour tout sauf F16/BF16.
# ⚠ ordre de l'alternation : variantes suffixées AVANT la base (Q2_K_S avant Q2_K),
# sinon le séparateur `_` fait matcher la base et tronque le suffixe.
_SOURCE_TAG_RE = re.compile(
    r"(?:^|[-_.\s/\\])("
    r"F16|BF16|FP16"
    r"|Q8_0|Q8_K|Q6_K"
    r"|Q5_K_M|Q5_K_S|Q5_0|Q5_1"
    r"|Q4_K_M|Q4_K_S|Q4_0|Q4_1"
    r"|Q3_K_L|Q3_K_M|Q3_K_S"
    r"|Q2_K_S|Q2_K"
    r"|IQ4_XS|IQ4_NL|IQ3_M|IQ3_S|IQ3_XXS|IQ2_M|IQ2_S|IQ2_XS|IQ2_XXS|IQ1_M|IQ1_S"
    r")(?:[-_.\s/\\]|\.gguf$|$)",
    re.IGNORECASE,
)
_SHARD_RE = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$")

# Pour scan_all_gguf : tous les types de quant connus + noms custom du brain.
#
# Convention de nommage observée en prod (config.yaml `quants:` + builds manuels):
#   mercury/<base>-brain-Q_8C_BRAIN.gguf        ← 8-bit custom
#   mercury/<base>-brain-Q_C8+_BRAIN.gguf       ← Custom 8 plus
#   mercury/<base>-brain-Q_C6v2_BRAIN.gguf      ← Custom 6 v2
#   mercury/<base>-brain-UD-Q6_K_XL.gguf        ← preset UD-* canonique
#
# Le pattern `Q_<id>_BRAIN` ou `Q_<id>_custom` capture les presets custom de
# l'utilisateur. Aligné avec `BRAIN-DAEMON/atlas/routes.py:_QUANT_RE`.
_ANY_QUANT_RE = re.compile(
    r"(?:^|[-_.\s/\\])("
    # Standards llama.cpp
    r"F16|BF16|FP16|MXFP4"
    r"|Q8_0|Q8_K|Q6_K|Q5_K_M|Q5_K_S"
    r"|Q4_K_M|Q4_K_S|Q4_0|Q3_K_M|Q3_K_S|Q3_K_L|Q2_K"
    r"|IQ4_XS|IQ4_NL|IQ3_XXS|IQ3_S|IQ2_XXS|IQ2_XS|IQ2_S|IQ1_S|IQ1_M"
    # Custom brain : Q_<id>_BRAIN ou Q_<id>_custom (alphanum + + . _ v)
    r"|Q_[A-Za-z0-9+._]+_(?:BRAIN|custom)"
    # Presets canoniques UD-* (Unsloth Dynamic)
    r"|UD-Q[0-9]_[A-Z_]+"
    r")(?:[-_.\s/\\]|\.gguf$|$)",
    re.IGNORECASE,
)


# ────────────────────────────────────────────────────────────────────────────
# Scanners
# ────────────────────────────────────────────────────────────────────────────

def scan_source_models(models_path: Path) -> list[ModelEntry]:
    """Scan récursif, groupe les shards, garde les GGUF REQUANTIZABLES.

    Source idéale = F16/BF16 (aucune perte cumulée). Mais on accepte aussi tout
    K-quant / IQ (Q6_K…Q2_K, IQ*) car llama-quantize sait les requantizer plus bas
    avec --allow-requantize (posé automatiquement quand is_requantize=True). Permet
    p.ex. de descendre un Q3_K_L 110 GB → Q2_K ~80 GB sans re-télécharger le F16.

    Port direct de brain-quant.py:scan_models, élargi aux sources déjà quantisées.
    """
    if not models_path.is_dir():
        return []

    seen_bases: set[str] = set()
    entries: list[ModelEntry] = []

    for gguf in sorted(models_path.rglob("*.gguf")):
        name = gguf.name.lower()
        if any(x in name for x in ("mmproj", "projector", "clip")):
            continue

        shard_m = _SHARD_RE.search(gguf.name)
        if shard_m:
            if shard_m.group(1) != "00001":
                continue
            total_shards = int(shard_m.group(2))
            base_str = re.sub(r"-\d{5}-of-\d{5}\.gguf$", "", str(gguf))
        else:
            total_shards = 1
            base_str = str(gguf.with_suffix(""))

        rel_str = str(gguf.relative_to(models_path))
        # Prend le DERNIER tag (le vrai quant est près de .gguf), pas le premier :
        # certains noms portent un marqueur de lignée AVANT le quant réel, ex
        # "MiniMax-M2.7-BF16-...-Q3_K_L.gguf" → on veut Q3_K_L, pas BF16 (sinon
        # is_requantize=False → pas de --allow-requantize → quant qui plante).
        tag_all = _SOURCE_TAG_RE.findall(rel_str)
        if not tag_all:
            continue
        tag = tag_all[-1].upper()
        if tag == "FP16":
            tag = "F16"
        elif tag.startswith("Q8_"):
            tag = "Q8_0"
        # K-quants / IQ : on garde le tag réel (ex "Q3_K_L"). is_requantize=True
        # en découle → build_quantize_overrides pose --allow-requantize au quant.

        if base_str in seen_bases:
            continue
        seen_bases.add(base_str)

        total_bytes = 0
        if total_shards > 1:
            for i in range(1, total_shards + 1):
                shard = Path(f"{base_str}-{i:05d}-of-{total_shards:05d}.gguf")
                if shard.exists():
                    total_bytes += shard.stat().st_size
        else:
            total_bytes = gguf.stat().st_size

        rel = Path(base_str).relative_to(models_path)
        display = re.sub(r"[-_.](F16|BF16|FP16|Q8_\w+)$", "", str(rel), flags=re.IGNORECASE)

        entries.append(ModelEntry(
            display_name=display,
            first_shard=gguf,
            total_shards=total_shards,
            total_bytes=total_bytes,
            quant_tag=tag,
        ))

    return entries


# Alias rétro-compat pour le TUI existant
scan_models = scan_source_models


def scan_calibrations(calib_dir: Path) -> list[CalibEntry]:
    """Liste les .txt dans calib_dir.

    Port direct de brain-quant.py:scan_calibration.
    """
    if not calib_dir.is_dir():
        return []
    return [
        CalibEntry(path=p, size_bytes=p.stat().st_size)
        for p in sorted(calib_dir.glob("*.txt"))
    ]


# Alias rétro-compat
scan_calibration = scan_calibrations


def scan_all_gguf(models_path: Path) -> list[GgufEntry]:
    """Scan récursif de TOUS les .gguf (pas que F16/BF16).

    Port direct de brain-quant.py:scan_all_gguf. La signature historique
    retournait list[dict]; on retourne maintenant list[GgufEntry] avec
    `.to_dict()` pour rétro-compat (le TUI peut itérer `.path`, `.display`,
    `.size_bytes`, `.quant_tag` via attribut au lieu de `[ "key" ]`).
    """
    if not models_path.is_dir():
        return []

    seen: set[str] = set()
    entries: list[GgufEntry] = []

    for gguf in sorted(models_path.rglob("*.gguf")):
        name = gguf.name.lower()
        if any(x in name for x in ("mmproj", "projector", "clip")):
            continue

        shard_m = _SHARD_RE.search(gguf.name)
        if shard_m:
            if shard_m.group(1) != "00001":
                continue
            total_shards = int(shard_m.group(2))
            base_str = re.sub(r"-\d{5}-of-\d{5}\.gguf$", "", str(gguf))
        else:
            total_shards = 1
            base_str = str(gguf.with_suffix(""))

        if base_str in seen:
            continue
        seen.add(base_str)

        total_bytes = 0
        if total_shards > 1:
            for i in range(1, total_shards + 1):
                shard = Path(f"{base_str}-{i:05d}-of-{total_shards:05d}.gguf")
                if shard.exists():
                    total_bytes += shard.stat().st_size
        else:
            total_bytes = gguf.stat().st_size

        rel_str = str(gguf.relative_to(models_path))
        tag_m = _ANY_QUANT_RE.search(rel_str)
        quant_tag = tag_m.group(1).upper() if tag_m else "?"

        rel = Path(base_str).relative_to(models_path)
        entries.append(GgufEntry(
            path=gguf,
            display=str(rel),
            size_bytes=total_bytes,
            quant_tag=quant_tag,
        ))

    return entries


def scan_imatrices(imatrix_dir: Path) -> list[ImatrixEntry]:
    """Liste les fichiers .imatrix dans imatrix_dir (headers seulement).

    Pour récupérer les stats détaillées (TensorStat[], ncall total, dataset)
    appeler imatrix.parse_imatrix(entry.path).
    """
    if not imatrix_dir.is_dir():
        return []
    entries: list[ImatrixEntry] = []
    for p in sorted(imatrix_dir.glob("*.imatrix")):
        st = p.stat()
        entries.append(ImatrixEntry(
            name=p.name,
            path=p,
            size_bytes=st.st_size,
            mtime=st.st_mtime,
        ))
    return entries


_OUTPUT_PRESET_SUFFIX_RE = re.compile(r"-brain-[^/]+\.gguf$", re.IGNORECASE)


def output_base_name(output_path: Path) -> str:
    """Extrait le base_name d'un GGUF output en strippant le suffix `-brain-<preset>.gguf`.

    Ex: `Qwen3.6-27B-Uncensored-brain-Q_8C_BRAIN.gguf` → `Qwen3.6-27B-Uncensored`.
    Aligné avec `ModelEntry.base_name` qui strip aussi les tags F16/BF16/Q8 — donc
    `output_base_name(output) == model.base_name` quand l'output vient bien de
    cette source.
    """
    return _OUTPUT_PRESET_SUFFIX_RE.sub("", output_path.name)


def resolve_source_for_output(
    output_path: Path,
    models: list[ModelEntry],
) -> ModelEntry | None:
    """Trouve le `ModelEntry` source d'un GGUF output, par match exact sur base_name.

    Sans ça, l'heuristique naïve côté UI (`output_dir/<base>.gguf`) tombe à côté
    dès que la source n'est pas dans le même dossier que les outputs, ou que son
    nom contient un tag explicite (`-F16`, `-BF16`). Le bon match passe par
    `base_name`, qui est précisément nettoyé pour neutraliser ces variations.
    """
    target = output_base_name(output_path)
    for m in models:
        if m.base_name == target:
            return m
    return None


def next_versioned_gguf(base_path: Path) -> Path:
    """Si base_path existe déjà, retourne <stem>-v2.gguf, -v3.gguf, etc.

    Port direct de brain-quant.py:798.
    """
    if not base_path.exists():
        return base_path
    stem = base_path.stem
    parent = base_path.parent
    n = 2
    while True:
        candidate = parent / f"{stem}-v{n}.gguf"
        if not candidate.exists():
            return candidate
        n += 1
