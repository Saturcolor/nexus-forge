"""
gguf_stats.py — parseur minimal du header GGUF pour récupérer les shapes
et types de chaque tensor, sans dépendance externe (pas de gguf-py, pas de
llama.cpp python bindings).

Utilisé par inspect-imatrix.py pour estimer la taille de chaque tensor
selon la quant cible — indispensable pour le builder custom interactif qui
affiche "Q8_0 → 1.6 GB saved" en live.

Format GGUF (v2/v3) — on lit uniquement le header :

    [u32] magic = b"GGUF"
    [u32] version
    [u64] n_tensors
    [u64] n_metadata_kv
    for each metadata_kv:
        [gguf_string] key
        [u32] value_type
        [...] value (variable)
    for each tensor:
        [gguf_string] name
        [u32] n_dims
        [u64 × n_dims] shape   (v3)  ou [u32 × n_dims] shape (v1, rare)
        [u32] ggml_type
        [u64] offset

gguf_string = [u64 length][bytes].

On n'a pas besoin de lire les données des tensors (blob à la fin), juste le
header.
"""

from __future__ import annotations

import re
import struct
from dataclasses import dataclass
from pathlib import Path


# ── GGML tensor type enum (depuis llama.cpp ggml.h) ─────────────────────────
GGML_TYPE_NAMES: dict[int, str] = {
    0: "F32",
    1: "F16",
    2: "Q4_0",
    3: "Q4_1",
    6: "Q5_0",
    7: "Q5_1",
    8: "Q8_0",
    9: "Q8_1",
    10: "Q2_K",
    11: "Q3_K",
    12: "Q4_K",
    13: "Q5_K",
    14: "Q6_K",
    15: "Q8_K",
    16: "IQ2_XXS",
    17: "IQ2_XS",
    18: "IQ3_XXS",
    19: "IQ1_S",
    20: "IQ4_NL",
    21: "IQ3_S",
    22: "IQ2_S",
    23: "IQ4_XS",
    24: "I8",
    25: "I16",
    26: "I32",
    27: "I64",
    28: "F64",
    29: "IQ1_M",
    30: "BF16",
}

# Bits par poids effectifs pour chaque type (avec scales/zero-points des blocs).
# Source : ggml-common.h, TYPE_TRAITS blck_size et type_size.
#   bits_per_weight = (type_size_bytes × 8) / blck_size
BITS_PER_WEIGHT: dict[str, float] = {
    "F32":    32.0,
    "F16":    16.0,
    "BF16":   16.0,
    # Q_n classiques : type_size bytes pour 32 elements
    "Q4_0":    4.5,   # 18 bytes / 32 = 4.5 bpw
    "Q4_1":    5.0,
    "Q5_0":    5.5,
    "Q5_1":    6.0,
    "Q8_0":    8.5,   # 34 bytes / 32
    "Q8_1":    9.0,
    # K-quants : blocs de 256 éléments
    "Q2_K":    2.625,
    "Q3_K":    3.4375,  # moyenne entre S/M/L
    "Q4_K":    4.5,
    "Q5_K":    5.5,
    "Q6_K":    6.5625,
    "Q8_K":    8.5,
    # I-quants
    "IQ2_XXS": 2.0625,
    "IQ2_XS":  2.3125,
    "IQ2_S":   2.5,
    "IQ3_XXS": 3.0625,
    "IQ3_S":   3.4375,
    "IQ1_S":   1.5625,
    "IQ1_M":   1.75,
    "IQ4_NL":  4.5,
    "IQ4_XS":  4.25,
    # ── Recettes ftype MIXTES (_S/_M/_L) ────────────────────────────────────
    # Ces noms ne sont PAS des ggml_type per-tensor (le per-family les mappe vers
    # le K-type brut via quantize._TENSOR_TYPE_MAP). Ils n'apparaissent que comme
    # BASE/fallback global passé à llama-quantize. On les liste ici pour que
    # estimate_preset_size (bytes_as) ne retombe pas sur bytes_current (= "aucun
    # changement") quand la base est une recette mixte. Valeurs = bpw EFFECTIF
    # approximatif des recettes llama.cpp (la recette bump certains tensors vers
    # un type supérieur → > bpw du K-type brut). Approximations pour le PREVIEW —
    # la taille réelle est validée post-quant via /validate-gguf.
    "Q5_K_M":  5.69, "Q5_K_S":  5.52,
    "Q4_K_M":  4.85, "Q4_K_S":  4.58,
    "Q3_K_L":  4.27, "Q3_K_M":  3.91, "Q3_K_S":  3.50,
    # ⚠ "Q2_K" partage sa clé avec le ggml_type concret per-tensor (= 2.625 brut,
    # plus haut). On ne peut donc pas lui donner son bpw EFFECTIF de recette (~3.0).
    # On place Q2_K_S juste EN DESSOUS pour que le ladder base reste monotone
    # (Q2_K_S = recette la plus agressive). Les 2 sous-estiment l'absolu (réel
    # ~10-15% au-dessus) — validé post-quant. Reste cohérent en RANKING.
    "Q2_K_S":  2.5625,
    "IQ3_M":   3.70, "IQ2_M":   2.70,
}


# ── GGUF value types (depuis gguf.h) ────────────────────────────────────────
(
    GGUF_UINT8, GGUF_INT8, GGUF_UINT16, GGUF_INT16,
    GGUF_UINT32, GGUF_INT32, GGUF_FLOAT32, GGUF_BOOL,
    GGUF_STRING, GGUF_ARRAY,
    GGUF_UINT64, GGUF_INT64, GGUF_FLOAT64,
) = range(13)

_GGUF_SCALAR_SIZE: dict[int, int] = {
    GGUF_UINT8: 1, GGUF_INT8: 1,
    GGUF_UINT16: 2, GGUF_INT16: 2,
    GGUF_UINT32: 4, GGUF_INT32: 4,
    GGUF_FLOAT32: 4, GGUF_BOOL: 1,
    GGUF_UINT64: 8, GGUF_INT64: 8, GGUF_FLOAT64: 8,
}


@dataclass
class GGUFTensor:
    name: str
    shape: tuple[int, ...]
    ggml_type: int
    type_name: str

    @property
    def n_params(self) -> int:
        """Nb d'éléments (produit des dimensions)."""
        p = 1
        for d in self.shape:
            p *= int(d)
        return p

    @property
    def bits_per_weight(self) -> float:
        return BITS_PER_WEIGHT.get(self.type_name, 16.0)

    @property
    def bytes_current(self) -> int:
        """Taille actuelle de ce tensor dans le fichier GGUF source."""
        return int(self.n_params * self.bits_per_weight / 8)

    def bytes_as(self, target_type_name: str) -> int:
        """Taille estimée si ce tensor était quantisé en target_type."""
        bpw = BITS_PER_WEIGHT.get(target_type_name)
        if bpw is None:
            return self.bytes_current  # fallback
        return int(self.n_params * bpw / 8)


@dataclass
class GGUFHeader:
    version: int
    tensors: list[GGUFTensor]

    @property
    def total_params(self) -> int:
        return sum(t.n_params for t in self.tensors)

    @property
    def total_bytes(self) -> int:
        return sum(t.bytes_current for t in self.tensors)

    def by_name(self) -> dict[str, GGUFTensor]:
        return {t.name: t for t in self.tensors}


class _Reader:
    """Stream reader buffer-backed pour le header GGUF."""

    def __init__(self, data: bytes):
        self.data = data
        self.off = 0

    def eof(self) -> bool:
        return self.off >= len(self.data)

    def _take(self, n: int) -> bytes:
        if self.off + n > len(self.data):
            raise ValueError(f"EOF inattendu à offset {self.off} (besoin {n} bytes)")
        b = self.data[self.off:self.off + n]
        self.off += n
        return b

    def u32(self) -> int:
        return struct.unpack("<I", self._take(4))[0]

    def u64(self) -> int:
        return struct.unpack("<Q", self._take(8))[0]

    def i32(self) -> int:
        return struct.unpack("<i", self._take(4))[0]

    def i64(self) -> int:
        return struct.unpack("<q", self._take(8))[0]

    def f32(self) -> float:
        return struct.unpack("<f", self._take(4))[0]

    def f64(self) -> float:
        return struct.unpack("<d", self._take(8))[0]

    def str(self) -> str:
        n = self.u64()
        if n > 100_000:
            raise ValueError(f"string length aberrant : {n} à offset {self.off}")
        return self._take(n).decode("utf-8", errors="replace")

    def skip_value(self, vtype: int) -> None:
        """Saute une valeur de type vtype (utilisé pour les metadata KV qu'on
        ne consomme pas)."""
        if vtype in _GGUF_SCALAR_SIZE:
            self._take(_GGUF_SCALAR_SIZE[vtype])
        elif vtype == GGUF_STRING:
            n = self.u64()
            self._take(n)
        elif vtype == GGUF_ARRAY:
            subtype = self.u32()
            count = self.u64()
            for _ in range(count):
                self.skip_value(subtype)
        else:
            raise ValueError(f"GGUF value type inconnu : {vtype}")


def read_gguf_header(path: Path, max_read_mb: int = 64) -> GGUFHeader:
    """Parse le header GGUF d'un fichier (ou du shard 00001-of-NNNNN si
    sharded). Lit au max max_read_mb du début du fichier — assez pour couvrir
    tous les metadata + tensor descriptors même sur les gros modèles."""
    with open(path, "rb") as f:
        # Lecture du début du fichier — le header contient n_tensors + metadata
        # + descriptors tensors. Pour un 70B ça fait typiquement < 4 MB. On
        # prend large pour les edge cases.
        data = f.read(max_read_mb * 1024 * 1024)

    r = _Reader(data)

    magic = r._take(4)
    if magic != b"GGUF":
        raise ValueError(f"Pas un fichier GGUF : magic = {magic!r}")

    version = r.u32()
    if version not in (1, 2, 3):
        raise ValueError(f"Version GGUF non supportée : {version}")

    n_tensors = r.u64()
    n_metadata_kv = r.u64()

    # Skip tous les metadata
    for _ in range(n_metadata_kv):
        _key = r.str()
        vtype = r.u32()
        r.skip_value(vtype)

    tensors: list[GGUFTensor] = []
    for _ in range(n_tensors):
        name = r.str()
        n_dims = r.u32()
        # v2+ : u64 per dim ; v1 : u32 per dim. On detect par version.
        if version >= 2:
            shape = tuple(r.u64() for _ in range(n_dims))
        else:
            shape = tuple(r.u32() for _ in range(n_dims))
        ggml_type = r.u32()
        _offset = r.u64()  # offset dans le blob data, pas besoin
        tensors.append(GGUFTensor(
            name=name,
            shape=shape,
            ggml_type=ggml_type,
            type_name=GGML_TYPE_NAMES.get(ggml_type, f"UNKNOWN({ggml_type})"),
        ))

    return GGUFHeader(version=version, tensors=tensors)


def read_gguf_header_sharded(first_shard: Path, max_read_mb: int = 64) -> GGUFHeader:
    """Lit le header GGUF d'un modèle potentiellement shardé.

    Détecte le pattern -00001-of-NNNNN dans le nom du fichier, lit tous les
    shards et fusionne les listes de tensors. Pour un fichier non-shardé,
    se comporte comme read_gguf_header()."""
    shard_rx = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$")
    m = shard_rx.search(first_shard.name)
    if not m:
        return read_gguf_header(first_shard, max_read_mb)

    total_shards = int(m.group(2))
    base_str = re.sub(r"-\d{5}-of-\d{5}\.gguf$", "", str(first_shard))

    all_tensors: list[GGUFTensor] = []
    version = 3
    for i in range(1, total_shards + 1):
        shard_path = Path(f"{base_str}-{i:05d}-of-{total_shards:05d}.gguf")
        hdr = read_gguf_header(shard_path, max_read_mb)
        all_tensors.extend(hdr.tensors)
        version = hdr.version

    return GGUFHeader(version=version, tensors=all_tensors)


# ── Utilitaires d'agrégation ────────────────────────────────────────────────

def family_of(tensor_name: str) -> str:
    """Dernier segment avant '.weight'/'.bias'. Cohérent avec inspect-imatrix."""
    m = re.search(r"(?:^|\.)([^.]+)\.(?:weight|bias)$", tensor_name)
    return m.group(1) if m else "_other"


def group_by_family(header: GGUFHeader) -> dict[str, list[GGUFTensor]]:
    """Regroupe les tensors par famille (last segment avant .weight/.bias)."""
    out: dict[str, list[GGUFTensor]] = {}
    for t in header.tensors:
        fam = family_of(t.name)
        out.setdefault(fam, []).append(t)
    return out


if __name__ == "__main__":
    # CLI d'inspection quick : python gguf_stats.py <path.gguf>
    import sys
    if len(sys.argv) != 2:
        print("Usage: gguf_stats.py <path.gguf>")
        sys.exit(1)
    hdr = read_gguf_header(Path(sys.argv[1]))
    print(f"GGUF v{hdr.version} · {len(hdr.tensors)} tensors · "
          f"{hdr.total_params / 1e9:.2f}B params · "
          f"{hdr.total_bytes / (1024**3):.2f} GB")
    print()
    fams = group_by_family(hdr)
    print(f"{'Family':<25} {'N':>4} {'params':>12} {'size':>10}  type(majoritaire)")
    rows = []
    for fam, ts in fams.items():
        total_p = sum(t.n_params for t in ts)
        total_b = sum(t.bytes_current for t in ts)
        types = {}
        for t in ts:
            types[t.type_name] = types.get(t.type_name, 0) + 1
        maj = max(types.items(), key=lambda x: x[1])[0]
        rows.append((fam, len(ts), total_p, total_b, maj))
    rows.sort(key=lambda r: r[3], reverse=True)
    for fam, n, p, b, t in rows:
        print(f"{fam:<25} {n:>4} {p/1e6:>10.1f}M {b/(1024**3):>8.2f}GB  {t}")
