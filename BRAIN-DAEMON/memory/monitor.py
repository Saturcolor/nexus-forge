"""Memory monitoring: VRAM (sysfs), RAM (psutil), GGUF VRAM estimation."""
from __future__ import annotations

import glob
import logging
import os
import re
import struct
from typing import Any, Dict

import psutil

logger = logging.getLogger("brain-daemon.memory")

# ── VRAM (sysfs amdgpu) ─────────────────────────────────────────────────────

_vram_base: str | None = None


def _find_vram_base() -> str | None:
    global _vram_base
    if _vram_base is not None:
        return _vram_base
    paths = glob.glob("/sys/class/drm/card*/device/mem_info_vram_used")
    if paths:
        _vram_base = paths[0].rsplit("/", 1)[0]
    return _vram_base


def _read_sysfs_int(path: str) -> int:
    try:
        with open(path) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return 0


def read_vram_used_mb() -> float:
    base = _find_vram_base()
    if not base:
        return 0.0
    return _read_sysfs_int(f"{base}/mem_info_vram_used") / (1024 * 1024)


def read_vram_total_mb() -> float:
    base = _find_vram_base()
    if not base:
        return 0.0
    return _read_sysfs_int(f"{base}/mem_info_vram_total") / (1024 * 1024)


def read_ram_status() -> dict:
    """Return RAM pool status from psutil."""
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    return {
        "total_mb": round(mem.total / (1024 * 1024), 1),
        "used_mb": round(mem.used / (1024 * 1024), 1),
        "available_mb": round(mem.available / (1024 * 1024), 1),
        "percent": round(mem.percent, 1),
        "swap_used_mb": round(swap.used / (1024 * 1024), 1),
        "swap_total_mb": round(swap.total / (1024 * 1024), 1),
        "swap_percent": round(swap.percent, 1),
    }


def measure_process_ram_mb(pid: int) -> float:
    """RSS total of a process + all recursive children (toolbox process tree)."""
    try:
        proc = psutil.Process(pid)
        total = proc.memory_info().rss
        for child in proc.children(recursive=True):
            try:
                total += child.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return round(total / (1024 * 1024), 1)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return 0.0


# ── GGUF VRAM Estimator ─────────────────────────────────────────────────────
# Integrated from gguf-vram-estimator.py (stdlib only, zero external deps).
# Parses GGUF binary metadata to compute model + KV cache memory requirements.

GGUF_MAGIC = 0x46554747
GGUF_VALUE_TYPE = {
    0: "UINT8", 1: "INT8", 2: "UINT16", 3: "INT16", 4: "UINT32",
    5: "INT32", 6: "FLOAT32", 7: "BOOL", 8: "STRING", 9: "ARRAY",
}


class GGUFMetadataReader:
    """Minimal binary reader for GGUF metadata — reads only KV-relevant fields."""

    def __init__(self, path: str):
        self.path = path
        self.metadata: Dict[str, Any] = {}

    def read(self) -> "GGUFMetadataReader":
        with open(self.path, "rb") as f:
            self.f = f
            magic, _, _, metadata_kv_count = struct.unpack("<IIQQ", f.read(24))
            if magic != GGUF_MAGIC:
                raise ValueError("Invalid GGUF magic number")
            self._read_metadata(metadata_kv_count)
        return self

    def _read_string(self) -> str:
        (length,) = struct.unpack("<Q", self.f.read(8))
        return self.f.read(length).decode("utf-8", errors="replace")

    def _read_value(self, vtype: int):
        name = GGUF_VALUE_TYPE.get(vtype)
        if not name:
            raise ValueError(f"Unknown GGUF value type: {vtype}")
        if name == "STRING":
            return self._read_string()
        if name == "UINT32":
            return struct.unpack("<I", self.f.read(4))[0]
        if name == "INT32":
            return struct.unpack("<i", self.f.read(4))[0]
        self._skip_value(vtype)
        return None

    def _skip_value(self, vtype: int):
        name = GGUF_VALUE_TYPE.get(vtype)
        if not name:
            return
        if name in ("UINT8", "INT8", "BOOL"):
            self.f.seek(1, 1)
        elif name in ("UINT16", "INT16"):
            self.f.seek(2, 1)
        elif name in ("UINT32", "INT32", "FLOAT32"):
            self.f.seek(4, 1)
        elif name == "STRING":
            (length,) = struct.unpack("<Q", self.f.read(8))
            self.f.seek(length, 1)
        elif name == "ARRAY":
            array_type_idx, count = struct.unpack("<IQ", self.f.read(12))
            size_map = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
            elem_size = size_map.get(array_type_idx)
            if elem_size:
                self.f.seek(count * elem_size, 1)
            else:
                for _ in range(count):
                    self._skip_value(8)

    def _read_metadata(self, count: int):
        keys_to_read = {"general.architecture", "general.name"}
        arch_added = False
        for _ in range(count):
            key = self._read_string()
            (vtype,) = struct.unpack("<I", self.f.read(4))
            if not arch_added and "general.architecture" in self.metadata:
                prefix = self.metadata["general.architecture"]
                keys_to_read.update({
                    f"{prefix}.block_count", f"{prefix}.context_length",
                    f"{prefix}.embedding_length",
                    f"{prefix}.attention.head_count",
                    f"{prefix}.attention.head_count_kv",
                    f"{prefix}.attention.key_length",
                    f"{prefix}.attention.value_length",
                    f"{prefix}.attention.sliding_window_size",
                })
                arch_added = True
            if key in keys_to_read:
                self.metadata[key] = self._read_value(vtype)
            else:
                self._skip_value(vtype)


def _total_file_size(gguf_path: str) -> int:
    """Sum file sizes — supports GGUF multi-shard, GGUF mono, and HF dirs.

    Pour un dir HF (vLLM), on somme les .safetensors. Cf bug "ModelInstance.gguf_path
    abuse" : le field porte un dir HF pour les backends vLLM, donc os.path.getsize
    raise IsADirectoryError si on tape direct dessus."""
    if os.path.isdir(gguf_path):
        total = 0
        try:
            for entry in os.listdir(gguf_path):
                if entry.endswith(".safetensors"):
                    total += os.path.getsize(os.path.join(gguf_path, entry))
        except OSError:
            return 0
        return total
    match = re.search(r"-(\d{5})-of-(\d{5})\.gguf$", gguf_path, re.IGNORECASE)
    if not match:
        return os.path.getsize(gguf_path)
    base = gguf_path[: match.start()]
    total_parts = int(match.group(2))
    total = 0
    for i in range(1, total_parts + 1):
        part = f"{base}-{i:05d}-of-{match.group(2)}.gguf"
        if os.path.exists(part):
            total += os.path.getsize(part)
    return total


class VRAMEstimator:
    """Estimate VRAM + KV cache requirements from GGUF metadata."""

    def __init__(self, gguf_path: str):
        self.gguf_path = gguf_path
        self._metadata: Dict[str, Any] | None = None

    def _ensure_metadata(self):
        if self._metadata is None:
            self._metadata = GGUFMetadataReader(self.gguf_path).read().metadata

    def estimate(self, ctx_size: int, overhead_gib: float = 2.0) -> dict:
        """Return {model_mb, kv_cache_mb, overhead_mb, total_mb}."""
        self._ensure_metadata()
        md = self._metadata
        prefix = md.get("general.architecture")
        if not prefix:
            raise KeyError("Cannot read general.architecture from GGUF metadata")

        n_layers = md[f"{prefix}.block_count"]
        n_head_kv = md.get(f"{prefix}.attention.head_count_kv")
        key_len = md.get(f"{prefix}.attention.key_length")
        val_len = md.get(f"{prefix}.attention.value_length")
        swa = md.get(f"{prefix}.attention.sliding_window_size", 0)

        # Fallback: derive head dimensions from embedding_length / head_count
        if (key_len is None or val_len is None) and n_head_kv:
            n_embd = md.get(f"{prefix}.embedding_length")
            n_head = md.get(f"{prefix}.attention.head_count")
            if n_embd and n_head:
                head_dim = n_embd // n_head
                key_len = key_len or head_dim
                val_len = val_len or head_dim

        if not n_head_kv or not key_len or not val_len:
            raise KeyError(
                f"Cannot compute KV cache: head_count_kv={n_head_kv}, "
                f"key_length={key_len}, value_length={val_len}"
            )

        # Special case: Scout models (36 SWA + 12 full)
        is_scout = "scout" in md.get("general.name", "").lower()
        if is_scout and swa == 0:
            n_swa, n_full, swa = 36, 12, 8192
        elif swa > 0:
            n_swa, n_full = n_layers, 0
        else:
            n_swa, n_full = 0, n_layers

        bytes_per_token_per_layer = n_head_kv * (key_len + val_len) * 2
        mem_full = ctx_size * n_full * bytes_per_token_per_layer
        mem_swa = min(ctx_size, swa) * n_swa * bytes_per_token_per_layer if swa > 0 else 0
        kv_bytes = mem_full + mem_swa

        model_bytes = _total_file_size(self.gguf_path)
        overhead_bytes = int(overhead_gib * 1024**3)

        return {
            "model_mb": round(model_bytes / (1024 * 1024), 1),
            "kv_cache_mb": round(kv_bytes / (1024 * 1024), 1),
            "overhead_mb": round(overhead_bytes / (1024 * 1024), 1),
            "total_mb": round((model_bytes + kv_bytes + overhead_bytes) / (1024 * 1024), 1),
        }


def estimate_model_memory(gguf_path: str, ctx_size: int, overhead_gib: float = 2.0) -> dict:
    """Convenience wrapper: estimate memory for a model at a given context size.
    Returns {model_mb, kv_cache_mb, overhead_mb, total_mb}.

    Pour un dir HF (vLLM), on skip l'estimateur GGUF et on calcule juste depuis
    la taille des safetensors + overhead. KV cache pas estimé en v1 (besoin de
    parser config.json HF — TODO si bench OOM observé)."""
    if os.path.isdir(gguf_path):
        size = _total_file_size(gguf_path)
        size_mb = round(size / (1024 * 1024), 1)
        overhead_mb = round(overhead_gib * 1024, 1)
        return {
            "model_mb": size_mb,
            "kv_cache_mb": 0.0,  # TODO: parser config.json HF pour estimer KV
            "overhead_mb": overhead_mb,
            "total_mb": round(size_mb + overhead_mb, 1),
        }
    try:
        return VRAMEstimator(gguf_path).estimate(ctx_size, overhead_gib)
    except Exception as exc:
        logger.warning("GGUF estimator failed for %s: %s — falling back to file size", gguf_path, exc)
        try:
            size = _total_file_size(gguf_path)
        except OSError:
            size = 0
        size_mb = round(size / (1024 * 1024), 1)
        overhead_mb = round(overhead_gib * 1024, 1)
        return {
            "model_mb": size_mb,
            "kv_cache_mb": 0.0,
            "overhead_mb": overhead_mb,
            "total_mb": round(size_mb + overhead_mb, 1),
        }
