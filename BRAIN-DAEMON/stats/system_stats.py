"""Collecte des metriques systeme (CPU, memoire, temperature, GPU, reseau, uptime)."""
import glob
import logging
import time
from typing import Any, Dict, Optional

import psutil

logger = logging.getLogger("brain-daemon")


def _get_temperatures() -> Dict[str, Optional[float]]:
    """Temperatures par capteur : CPU (k10temp), GPU (amdgpu), NVMe."""
    result: Dict[str, Optional[float]] = {"cpu_c": None, "gpu_c": None, "nvme_c": None}
    try:
        if not hasattr(psutil, "sensors_temperatures"):
            return result
        sensors = psutil.sensors_temperatures() or {}
        for name, entries in sensors.items():
            n = name.lower()
            for e in entries if isinstance(entries, list) else [entries]:
                label = (getattr(e, "label", "") or "").lower()
                current = getattr(e, "current", None)
                if current is None:
                    continue
                if "k10temp" in n and label in ("tctl", "tccd1") and result["cpu_c"] is None:
                    result["cpu_c"] = round(float(current), 1)
                elif "amdgpu" in n and label == "edge" and result["gpu_c"] is None:
                    result["gpu_c"] = round(float(current), 1)
                elif "nvme" in n and label == "composite" and result["nvme_c"] is None:
                    result["nvme_c"] = round(float(current), 1)
    except Exception as e:
        logger.debug("Temperatures non disponibles: %s", e)
    return result


def _read_sysfs_int(path: str) -> Optional[int]:
    try:
        with open(path, "r") as f:
            return int(f.read().strip())
    except Exception:
        return None


def _get_gpu_amd() -> Dict[str, Any]:
    """GPU AMD via sysfs : utilisation, VRAM. Silencieux si absent."""
    result: Dict[str, Any] = {"percent": None, "vram_used_mb": None, "vram_total_mb": None}
    paths = glob.glob("/sys/class/drm/card*/device/gpu_busy_percent")
    if not paths:
        return result
    base = paths[0].rsplit("/", 1)[0]
    busy = _read_sysfs_int(f"{base}/gpu_busy_percent")
    if busy is not None:
        result["percent"] = busy
    vram_used = _read_sysfs_int(f"{base}/mem_info_vram_used")
    vram_total = _read_sysfs_int(f"{base}/mem_info_vram_total")
    if vram_used is not None:
        result["vram_used_mb"] = round(vram_used / (1024 * 1024), 1)
    if vram_total is not None:
        result["vram_total_mb"] = round(vram_total / (1024 * 1024), 1)
    return result


def _get_uptime() -> float:
    try:
        return round(time.time() - psutil.boot_time(), 0)
    except Exception:
        return 0.0


def _get_network() -> Dict[str, Optional[float]]:
    try:
        io = psutil.net_io_counters()
        return {
            "rx_mb": round(io.bytes_recv / (1024 * 1024), 1),
            "tx_mb": round(io.bytes_sent / (1024 * 1024), 1),
        }
    except Exception:
        return {"rx_mb": None, "tx_mb": None}


def collect_system_stats() -> Dict[str, Any]:
    """Retourne CPU, memoire, temperatures, GPU, uptime, reseau."""
    try:
        cpu = psutil.cpu_percent(interval=None)
        mem = psutil.virtual_memory()
        temps = _get_temperatures()
        gpu = _get_gpu_amd()
        uptime = _get_uptime()
        network = _get_network()
        return {
            "cpu_percent": round(cpu, 1),
            "memory": {
                "used_mb": round(mem.used / (1024 * 1024), 1),
                "total_mb": round(mem.total / (1024 * 1024), 1),
                "percent": round(mem.percent, 1),
            },
            "temperatures": temps,
            "gpu": gpu,
            "uptime_seconds": uptime,
            "network": network,
        }
    except Exception as e:
        logger.warning("Erreur collecte systeme: %s", e)
        return {
            "cpu_percent": None,
            "memory": {"used_mb": None, "total_mb": None, "percent": None},
            "temperatures": {"cpu_c": None, "gpu_c": None, "nvme_c": None},
            "gpu": {"percent": None, "vram_used_mb": None, "vram_total_mb": None},
            "uptime_seconds": None,
            "network": {"rx_mb": None, "tx_mb": None},
        }
