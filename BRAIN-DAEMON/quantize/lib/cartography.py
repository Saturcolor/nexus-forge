"""cartography.py — lecture des VALEURS de poids + stats par tensor.

Contrairement à `gguf_stats` (header only : noms/shapes/types/offsets), ce module
LIT et DÉQUANTIZE les données de chaque tensor via gguf-py (GGUFReader +
quants.dequantize), pour produire une cartographie numérique réutilisable :

  - **importance proxy** (`l2_norm`) → alimente `surgical.emit_preset` SANS imatrix
    (via `to_tensorstats`). Pas besoin d'un run de calibration GPU.
  - **santé** (`near_max_frac`, `kurtosis`, scale-outlier vs famille, mean-drift)
    → diagnostic pour la passe de réparation post-abliteration.
  - **specs** affichées dans le popup « Inspect » de la carte modèle.

C'est LOURD (lit le blob de poids, ~30s-2min pour un 35B sur NVMe) — pensé comme un
job, pas un appel synchrone instantané. MAIS zéro GPU, zéro calibration (≠ imatrix).

Pur logique : aucune console/rich. Le caller injecte `progress_cb`.

Déps : numpy + gguf (gguf-py). Le déquant de TOUS les types (F16/BF16/Q8/Q6/Q4/IQ…)
est délégué à `gguf.dequantize` — on ne maintient aucun code de déquant maison.
"""
from __future__ import annotations

import json
import logging
import math
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("brain.quant.cartography")

# Réutilise la logique famille de gguf_stats (source de vérité unique). En mode
# package (daemon / `python -m`), on passe par lib.gguf qui gère déjà le tweak
# sys.path. En script direct, on retombe sur l'import absolu + tweak local.
try:
    from .gguf import family_of, read_gguf_header_sharded
except ImportError:  # exécution en script direct, hors package
    _QROOT = str(Path(__file__).resolve().parent.parent)
    if _QROOT not in sys.path:
        sys.path.insert(0, _QROOT)
    from gguf_stats import family_of, read_gguf_header_sharded  # noqa: E402


# ────────────────────────────────────────────────────────────────────────────
# Data classes
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class TensorCarto:
    """Stats numériques d'un tensor (valeurs déquantisées en float32)."""
    name: str
    family: str
    type_name: str          # F16 / Q8_0 / Q6_K ...
    n_params: int
    l2_norm: float          # ‖W‖₂ — proxy d'importance (clé de tri surgical)
    rms: float              # l2_norm / sqrt(n) — magnitude normalisée, comparable entre familles
    mean: float             # détection mean-drift (sain ≈ 0)
    std: float
    max_abs: float
    near_max_frac: float    # fraction |w| ≥ 0.95·max_abs — proxy saturation
    kurtosis: float         # Fisher (sain ≈ 0 ; élevé = fat tails / saturation)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name, "family": self.family, "type_name": self.type_name,
            "n_params": self.n_params, "l2_norm": self.l2_norm, "rms": self.rms,
            "mean": self.mean, "std": self.std, "max_abs": self.max_abs,
            "near_max_frac": self.near_max_frac, "kurtosis": self.kurtosis,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TensorCarto":
        return cls(
            name=str(d["name"]), family=str(d["family"]), type_name=str(d["type_name"]),
            n_params=int(d["n_params"]), l2_norm=float(d["l2_norm"]), rms=float(d["rms"]),
            mean=float(d["mean"]), std=float(d["std"]), max_abs=float(d["max_abs"]),
            near_max_frac=float(d["near_max_frac"]), kurtosis=float(d["kurtosis"]),
        )


@dataclass
class Cartography:
    """Résultat complet d'un scan de poids."""
    tensors: list[TensorCarto]
    architecture: str       # "dense" | "moe" | "hybrid"
    n_tensors: int
    total_params: int
    elapsed_sec: float
    model_name: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "tensors": [t.to_dict() for t in self.tensors],
            "architecture": self.architecture,
            "n_tensors": self.n_tensors,
            "total_params": self.total_params,
            "elapsed_sec": self.elapsed_sec,
            "model_name": self.model_name,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Cartography":
        """Reconstruit une Cartography depuis son to_dict() (cache disque)."""
        return cls(
            tensors=[TensorCarto.from_dict(t) for t in d.get("tensors", [])],
            architecture=str(d["architecture"]),
            n_tensors=int(d["n_tensors"]),
            total_params=int(d["total_params"]),
            elapsed_sec=float(d.get("elapsed_sec", 0.0)),
            model_name=str(d.get("model_name", "")),
        )


ProgressCallback = Callable[[int, int], None]   # (tensors_done, tensors_total)


# ────────────────────────────────────────────────────────────────────────────
# Shards
# ────────────────────────────────────────────────────────────────────────────

_SHARD_RE = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$")


def _shard_paths(first_shard: Path) -> list[Path]:
    """Liste les shards d'un modèle (ou [first_shard] si mono-fichier)."""
    m = _SHARD_RE.search(first_shard.name)
    if not m:
        return [first_shard]
    total = int(m.group(2))
    base = re.sub(r"-\d{5}-of-\d{5}\.gguf$", "", str(first_shard))
    return [Path(f"{base}-{i:05d}-of-{total:05d}.gguf") for i in range(1, total + 1)]


# ────────────────────────────────────────────────────────────────────────────
# Stats (numpy) — isolé pour être testable sans gguf
# ────────────────────────────────────────────────────────────────────────────

def tensor_float_stats(arr) -> dict[str, float]:
    """Stats d'un tensor déquantisé. Moments bruts via np.einsum (fusionné,
    accumulation float64, AUCUN tableau plein temporaire au-delà de `arr`) →
    mémoire plate. Critique sur les gros tensors (token_embd ~Go) car la machine
    brain est partagée avec l'inférence : l'ancienne version (upcast f64 + z**4)
    matérialisait ~4 copies pleines → OOM possible."""
    import numpy as np

    a = np.ravel(np.asarray(arr))
    n = int(a.size)
    if n == 0:
        return {"n_params": 0, "l2_norm": 0.0, "rms": 0.0, "mean": 0.0,
                "std": 0.0, "max_abs": 0.0, "near_max_frac": 0.0, "kurtosis": 0.0}
    if a.dtype != np.float32:
        a = a.astype(np.float32, copy=False)

    # Moments bruts (sommes des puissances) accumulés en f64, sans temp plein.
    s1 = float(np.einsum("i->", a, dtype=np.float64))
    s2 = float(np.einsum("i,i->", a, a, dtype=np.float64))
    s3 = float(np.einsum("i,i,i->", a, a, a, dtype=np.float64))
    s4 = float(np.einsum("i,i,i,i->", a, a, a, a, dtype=np.float64))

    mean = s1 / n
    m2 = max(s2 / n - mean * mean, 0.0)          # variance (clamp bruit num.)
    std = math.sqrt(m2)
    l2 = math.sqrt(s2)
    rms = l2 / math.sqrt(n)

    amax = float(a.max())
    amin = float(a.min())
    max_abs = max(abs(amax), abs(amin))

    # fraction near-max : count_nonzero (réductions ; temp bool 1B/élt seulement).
    if max_abs > 0:
        thr = 0.95 * max_abs
        near = int(np.count_nonzero(a >= thr)) + int(np.count_nonzero(a <= -thr))
        near_max_frac = near / n
    else:
        near_max_frac = 0.0

    # kurtosis Fisher via moments bruts : m4 = E[(x-μ)^4] développé.
    if m2 > 0:
        m4 = s4 / n - 4 * mean * (s3 / n) + 6 * mean * mean * (s2 / n) - 3 * mean ** 4
        kurtosis = m4 / (m2 * m2) - 3.0
    else:
        kurtosis = 0.0

    return {"n_params": n, "l2_norm": l2, "rms": rms, "mean": mean, "std": std,
            "max_abs": max_abs, "near_max_frac": near_max_frac, "kurtosis": kurtosis}


# ────────────────────────────────────────────────────────────────────────────
# Lecture + déquant (gguf-py)
# ────────────────────────────────────────────────────────────────────────────

def _get_dequantize():
    """Récupère gguf.dequantize (top-level récent) ou gguf.quants.dequantize."""
    try:
        from gguf import dequantize  # gguf-py récent
        return dequantize
    except Exception:
        from gguf.quants import dequantize  # fallback ancien layout
        return dequantize


def _detect_architecture(names: list[str]) -> str:
    """Heuristique dense/moe/hybrid depuis les noms (même logique que imatrix)."""
    has_exps = any("_exps" in n for n in names)
    if not has_exps:
        return "dense"
    has_dense_ffn = any(
        re.search(r"ffn_(gate|up|down)\.weight", n) and "_exps" not in n for n in names
    )
    has_shexp = any("_shexp" in n for n in names)
    has_ssm = any(re.search(r"(?:^|\.)ssm_", n) for n in names)
    has_attn_gate = any(re.search(r"(?:^|\.)attn_gate\.", n) for n in names)
    if has_dense_ffn or has_shexp or has_ssm or has_attn_gate:
        return "hybrid"
    return "moe"


def compute_cartography(
    first_shard: Path,
    progress_cb: Optional[ProgressCallback] = None,
    model_name: str = "",
) -> Cartography:
    """Scanne les poids d'un GGUF (sharded ou non) et calcule les stats par tensor.

    Lit chaque tensor, le déquantize en float32 via gguf-py, réduit en scalaires,
    libère — donc pic mémoire ≈ le plus gros tensor (typiquement token_embd).
    """
    import numpy as np  # noqa: F401  (importé tôt pour fail fast si absent)
    from gguf import GGUFReader

    dequantize = _get_dequantize()
    shards = _shard_paths(first_shard)
    log.info("cartography: %d shard(s) pour %s", len(shards), first_shard.name)

    # Total tensors via header (léger) — ne garde aucun reader gguf-py ouvert.
    try:
        total = len(read_gguf_header_sharded(first_shard).tensors)
    except Exception:
        total = 0
    log.info("cartography: %d tensors à scanner", total)

    records: list[TensorCarto] = []
    names: list[str] = []
    t0 = time.time()
    done = 0
    for sh in shards:
        reader = GGUFReader(str(sh))   # un seul mmap à la fois, libéré en fin de shard
        for t in reader.tensors:
            name = str(t.name)
            type_name = t.tensor_type.name
            try:
                arr = dequantize(t.data, t.tensor_type)
                stats = tensor_float_stats(arr)
            except Exception as e:
                # Un type exotique non géré par cette version de gguf : on log et on
                # garde l'entrée avec des stats nulles (le popup affiche au moins le
                # type/taille via le header). Ne casse jamais le scan entier.
                log.warning("cartography: déquant échoué pour %s (%s): %s", name, type_name, e)
                stats = tensor_float_stats([])
                stats["n_params"] = int(np.prod(t.shape)) if len(t.shape) else 0

            records.append(TensorCarto(
                name=name, family=family_of(name), type_name=type_name,
                n_params=stats["n_params"], l2_norm=stats["l2_norm"], rms=stats["rms"],
                mean=stats["mean"], std=stats["std"], max_abs=stats["max_abs"],
                near_max_frac=stats["near_max_frac"], kurtosis=stats["kurtosis"],
            ))
            names.append(name)
            done += 1
            if progress_cb and (done % 25 == 0 or done == total):
                progress_cb(done, total)
            if done % 100 == 0:
                log.info("cartography: %d/%d (%.0fs)", done, total, time.time() - t0)
        del reader  # libère le mmap du shard avant de passer au suivant

    elapsed = time.time() - t0
    arch = _detect_architecture(names)
    total_params = sum(t.n_params for t in records)
    log.info("cartography: terminé — %d tensors, arch=%s, %.1fB params, %.0fs",
             len(records), arch, total_params / 1e9, elapsed)

    return Cartography(
        tensors=records, architecture=arch, n_tensors=len(records),
        total_params=total_params, elapsed_sec=elapsed, model_name=model_name,
    )


# ────────────────────────────────────────────────────────────────────────────
# Adapter → surgical (imatrix-free)
# ────────────────────────────────────────────────────────────────────────────

def to_tensorstats(carto: Cartography, importance: str = "l2_norm") -> list:
    """Convertit une Cartography en list[TensorStat] consommable TEL QUEL par
    `surgical.emit_preset`. `importance` = champ utilisé comme `sum_values`
    (clé de tri du top-X%/famille). 'l2_norm' (défaut) ou 'rms'.

    → surgical.py n'est PAS modifié : il trie sur sum_values, peu importe la source.
    """
    from .imatrix import TensorStat

    out: list[TensorStat] = []
    for t in carto.tensors:
        score = getattr(t, importance, t.l2_norm)
        out.append(TensorStat(
            name=t.name, ncall=0, nval=t.n_params,
            sum_values=float(score), l2_norm=t.l2_norm,
            mean_value=t.mean, concentration_top10=0.0,
        ))
    return out


# ────────────────────────────────────────────────────────────────────────────
# Agrégation par famille (pour le popup Inspect / santé)
# ────────────────────────────────────────────────────────────────────────────

def family_health(carto: Cartography) -> dict[str, dict[str, Any]]:
    """Agrège par famille + flag les outliers de scale (rms ≫ médiane des frères)
    et la saturation. Réutilise l'instinct AtlasMind : outlier si > 2× médiane.

    Retourne {family: {count, rms_median, outliers: [{name, rms, ratio}], ...}}.
    """
    import numpy as np

    by_fam: dict[str, list[TensorCarto]] = {}
    for t in carto.tensors:
        by_fam.setdefault(t.family, []).append(t)

    out: dict[str, dict[str, Any]] = {}
    for fam, ts in by_fam.items():
        rms_vals = [t.rms for t in ts if t.rms > 0]
        median = float(np.median(rms_vals)) if rms_vals else 0.0
        # Outliers de scale : test ROBUSTE MAD, HAUT-côté seulement, seuil TRÈS
        # conservateur (z>8). Calibré sur Qwen3.6 : le scale par-couche varie
        # naturellement (rms conv1d 0.03→0.10), donc un seuil souple = flood de
        # faux positifs. On ne sort que les extrêmes. ⚠ "informatif" ≠ "dégât" :
        # le vrai diagnostic de dégât = DIFF entre deux scans, pas un seuil mono-modèle.
        outliers = []
        if len(rms_vals) >= 4:
            madv = float(np.median([abs(x - median) for x in rms_vals]))
            if madv > 1e-9 and median > 0:
                for t in ts:
                    if t.rms > median:  # haut-côté uniquement
                        z = (t.rms - median) / madv
                        if z > 8.0:
                            outliers.append({"name": t.name, "rms": t.rms, "ratio": t.rms / median})
        # Saturation : near_max_frac élevé UNIQUEMENT (kurtosis retiré — les norms/
        # routers/conv1d 1D sont naturellement spiky → kurtosis élevé = normal, pas
        # un dégât ; c'était la source du spam "satur 0%").
        saturated = [
            {"name": t.name, "near_max_frac": t.near_max_frac, "kurtosis": t.kurtosis}
            for t in ts if t.near_max_frac > 0.25
        ]
        out[fam] = {
            "count": len(ts),
            "rms_median": median,
            "outliers": sorted(outliers, key=lambda x: -x["ratio"]),
            "saturated": saturated,
            # mean_drift retiré : les poids ne sont pas zéro-mean par nature
            # (|mean|>0.6·std flaggait ~180 tensors = bruit, pas un dégât).
        }
    return out


# ────────────────────────────────────────────────────────────────────────────
# CLI — smoke test rapide (à lancer sur la machine brain sur un vrai modèle)
#   python -m quantize.lib.cartography /path/to/model-F16.gguf
# ────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    _ap = argparse.ArgumentParser(description="Cartographie des poids d'un GGUF (stats par tensor).")
    _ap.add_argument("model", help="GGUF source (1er shard si shardé)")
    _ap.add_argument("--json", dest="json_out", default=None,
                     help="Écrit la cartographie COMPLÈTE (stats par tensor) en JSON à ce path.")
    _args = _ap.parse_args()
    _path = Path(_args.model)
    _carto = compute_cartography(_path, model_name=_path.name)
    if _args.json_out:
        Path(_args.json_out).write_text(
            json.dumps(_carto.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"📄 JSON complet (stats/tensor) écrit : {_args.json_out}")
    print(f"\n{_carto.n_tensors} tensors · arch={_carto.architecture} · "
          f"{_carto.total_params / 1e9:.2f}B params · {_carto.elapsed_sec:.0f}s")
    _fh = family_health(_carto)
    print(f"\n{'famille':22} {'N':>4} {'rms_med':>10} {'outliers':>9} {'satur':>6} {'drift':>6}")
    for _fam in sorted(_fh, key=lambda f: -_fh[f]["count"]):
        _h = _fh[_fam]
        print(f"{_fam:22} {_h['count']:>4} {_h['rms_median']:>10.4f} "
              f"{len(_h['outliers']):>9} {len(_h['saturated']):>6} {len(_h['mean_drift']):>6}")
    if any(_h["outliers"] or _h["saturated"] for _h in _fh.values()):
        print("\n⚠ Outliers notables (informatif — ≠ forcément un dégât ; diff 2 scans = fiable) :")
        for _fam, _h in _fh.items():
            for _o in _h["outliers"]:
                print(f"   [scale]  {_o['name']}  rms×{_o['ratio']:.2f} vs médiane famille")
            for _s in _h["saturated"]:
                print(f"   [satur]  {_s['name']}  near_max={_s['near_max_frac']:.2%} kurt={_s['kurtosis']:.1f}")
