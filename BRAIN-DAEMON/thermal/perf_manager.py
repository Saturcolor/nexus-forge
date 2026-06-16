"""Performance mode manager — 3 modes : performance, optimized, eco.
Bascule CPU/GPU/power pour llama.cpp sur Ryzen AI Max+ 395."""
import logging

from thermal import root_client

logger = logging.getLogger("brain-daemon")

# ── Profiles ──────────────────────────────────────────────────────────────────

PROFILES = {
    "performance": {
        "governor": "performance",
        "gpu_level": "high",
        "ryzenadj": {
            "stapm_limit": 120000,
            "slow_limit": 120000,
            "fast_limit": 140000,
            "apu_slow_limit": 120000,
            "tctl_temp": 90,
        },
        "swappiness": "10",
        "dirty_ratio": "5",
        "dirty_bg": "2",
        "thp": "always",
        "drop_caches": True,
    },
    "turbo": {
        "governor": "performance",
        "gpu_level": "auto",
        "ryzenadj": {
            "stapm_limit": 150000,
            "slow_limit": 150000,
            "fast_limit": 170000,
            "apu_slow_limit": 150000,
            "tctl_temp": 95,
        },
        "swappiness": "10",
        "dirty_ratio": "5",
        "dirty_bg": "2",
        "thp": "always",
        "drop_caches": True,
    },
    "optimized": {
        "governor": "performance",
        "gpu_level": "auto",
        "ryzenadj": {
            "stapm_limit": 120000,
            "slow_limit": 120000,
            "fast_limit": 140000,
            "apu_slow_limit": 120000,
            "tctl_temp": 90,
        },
        "swappiness": "10",
        "dirty_ratio": "5",
        "dirty_bg": "2",
        "thp": "always",
        "drop_caches": True,
    },
    "custom": {
        "governor": "performance",
        "gpu_level": "auto",
        "ryzenadj": {
            "stapm_limit": 120000,
            "slow_limit": 120000,
            "fast_limit": 140000,
            "apu_slow_limit": 120000,
            "tctl_temp": 90,
        },
        "swappiness": "10",
        "dirty_ratio": "5",
        "dirty_bg": "2",
        "thp": "always",
        "drop_caches": True,
    },
    "eco": {
        "governor": "powersave",
        "gpu_level": "auto",
        "ryzenadj": {
            "stapm_limit": 85000,
            "slow_limit": 85000,
            "fast_limit": 120000,
            "apu_slow_limit": 70000,
            "tctl_temp": 98,
        },
        "swappiness": "60",
        "dirty_ratio": "20",
        "dirty_bg": "10",
        "thp": "madvise",
        "drop_caches": False,
    },
}


# Custom overrides — permettent de bypass les valeurs d'un profil
_custom_stapm_w: int | None = None
_custom_tctl_c: int | None = None


def set_custom_stapm(watts: int | None):
    """Set un override STAPM custom (en watts). None = utiliser le profil."""
    global _custom_stapm_w
    _custom_stapm_w = watts


def set_custom_tctl(temp_c: int | None):
    """Set un override tctl custom (en °C). None = utiliser le profil."""
    global _custom_tctl_c
    _custom_tctl_c = temp_c


async def set_mode(mode: str) -> dict:
    """Applique un profil de performance. Retourne le detail des actions."""
    profile = PROFILES.get(mode)
    if not profile:
        return {"error": f"mode inconnu: {mode}, valides: {list(PROFILES.keys())}"}

    # Switching to a preset clears custom overrides
    if mode != "custom":
        global _custom_stapm_w, _custom_tctl_c
        _custom_stapm_w = None
        _custom_tctl_c = None

    results = {}

    # Overrides custom
    radj = dict(profile["ryzenadj"])
    if _custom_stapm_w is not None:
        mw = _custom_stapm_w * 1000
        radj["stapm_limit"] = mw
        radj["slow_limit"] = mw
        radj["apu_slow_limit"] = mw
        radj["fast_limit"] = mw + 20000
        logger.info("[perf] Custom STAPM override: %dW", _custom_stapm_w)
    if _custom_tctl_c is not None:
        radj["tctl_temp"] = _custom_tctl_c
        logger.info("[perf] Custom tctl override: %d°C", _custom_tctl_c)

    stapm_w = radj["stapm_limit"] // 1000
    tctl = radj.get("tctl_temp", 90)
    logger.info("[perf] Passage en mode %s (STAPM=%dW tctl=%d°C GPU=%s)",
                mode.upper(), stapm_w, tctl, profile["gpu_level"])

    results["governor"] = await root_client.set_governor(profile["governor"])
    results["gpu"] = await root_client.set_gpu_level(profile["gpu_level"])
    results["ryzenadj"] = await root_client.ryzenadj(radj)
    results["swappiness"] = await root_client.set_sysctl("vm.swappiness", profile["swappiness"])
    results["dirty_ratio"] = await root_client.set_sysctl("vm.dirty_ratio", profile["dirty_ratio"])
    results["dirty_bg"] = await root_client.set_sysctl("vm.dirty_background_ratio", profile["dirty_bg"])
    results["thp"] = await root_client.set_thp(profile["thp"])
    if profile["drop_caches"]:
        results["drop_caches"] = await root_client.drop_caches()

    logger.info("[perf] Mode %s actif (GPU=%s, STAPM=%dW)",
                mode.upper(), profile["gpu_level"], profile["ryzenadj"]["stapm_limit"] // 1000)
    return {"mode": mode, "results": results}


async def get_status() -> dict:
    """Lit l'etat actuel des governors/power limits (sysfs world-readable)."""
    import glob

    def _read(path: str) -> str | None:
        try:
            with open(path, "r") as f:
                return f.read().strip()
        except Exception:
            return None

    governors = set()
    for p in sorted(glob.glob("/sys/devices/system/cpu/cpufreq/policy*/scaling_governor")):
        g = _read(p)
        if g:
            governors.add(g)

    gpu_level = _read("/sys/class/drm/card0/device/power_dpm_force_performance_level")
    swappiness = _read("/proc/sys/vm/swappiness")
    dirty_ratio = _read("/proc/sys/vm/dirty_ratio")
    thp = _read("/sys/kernel/mm/transparent_hugepage/enabled")
    is_root = __import__('os').geteuid() == 0

    # Detecter le mode actuel
    is_perf_gov = "performance" in governors
    is_high = gpu_level == "high"
    if _custom_stapm_w is not None or _custom_tctl_c is not None:
        current_mode = "custom"
    elif is_perf_gov and is_high:
        current_mode = "performance"
    elif is_perf_gov and not is_high:
        current_mode = "optimized"
    else:
        current_mode = "eco"

    return {
        "current_mode": current_mode,
        "governors": sorted(governors),
        "gpu_level": gpu_level,
        "swappiness": swappiness,
        "dirty_ratio": dirty_ratio,
        "thp": thp,
        "root": is_root,
        "available_modes": list(PROFILES.keys()),
        "custom_stapm_w": _custom_stapm_w,
        "custom_tctl_c": _custom_tctl_c,
    }
