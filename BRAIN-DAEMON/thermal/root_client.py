"""Operations privilegiees — appels directs sysfs/ryzenadj.
Le daemon tourne en root, pas besoin de helper IPC."""
import asyncio
import glob
import logging
import os
import signal
import subprocess

logger = logging.getLogger("brain-daemon")


def _write_sysfs(path: str, value: str) -> bool:
    try:
        with open(path, "w") as f:
            f.write(value)
        return True
    except Exception as e:
        logger.warning("sysfs write %s=%s failed: %s", path, value, e)
        return False


async def is_available() -> bool:
    """Toujours True — on tourne en root."""
    return os.geteuid() == 0


async def set_governor(mode: str) -> dict:
    if mode not in ("performance", "powersave", "schedutil", "ondemand"):
        return {"ok": False, "error": f"invalid governor: {mode}"}
    policies = sorted(glob.glob("/sys/devices/system/cpu/cpufreq/policy*/scaling_governor"))
    ok_count = sum(1 for p in policies if _write_sysfs(p, mode))
    return {"ok": ok_count > 0, "applied": ok_count, "total": len(policies)}


async def set_cpu_freq(freq_khz: int) -> dict:
    if freq_khz < 100000 or freq_khz > 10000000:
        return {"ok": False, "error": f"freq out of range: {freq_khz}"}
    policies = sorted(glob.glob("/sys/devices/system/cpu/cpufreq/policy*/scaling_max_freq"))
    ok_count = sum(1 for p in policies if _write_sysfs(p, str(freq_khz)))
    return {"ok": ok_count > 0, "applied": ok_count}


async def set_gpu_level(level: str) -> dict:
    if level not in ("high", "auto", "low", "manual"):
        return {"ok": False, "error": f"invalid gpu level: {level}"}
    ok = _write_sysfs("/sys/class/drm/card0/device/power_dpm_force_performance_level", level)
    return {"ok": ok}


async def ryzenadj(params: dict[str, int]) -> dict:
    param_map = {
        "stapm_limit": "--stapm-limit",
        "slow_limit": "--slow-limit",
        "fast_limit": "--fast-limit",
        "apu_slow_limit": "--apu-slow-limit",
        "tctl_temp": "--tctl-temp",
    }
    args = []
    for key, flag in param_map.items():
        if key in params:
            args.extend([flag, str(params[key])])
    if not args:
        return {"ok": False, "error": "no args"}
    try:
        result = subprocess.run(["ryzenadj"] + args, capture_output=True, text=True, timeout=10)
        return {"ok": result.returncode == 0, "stdout": result.stdout[:500], "stderr": result.stderr[:500]}
    except FileNotFoundError:
        return {"ok": False, "error": "ryzenadj not found"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "ryzenadj timeout"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def signal_process(sig: str, pid: int) -> dict:
    """Envoie SIGSTOP/SIGCONT au process group entier (sudo → toolbox → llama-server)."""
    sig_map = {"STOP": signal.SIGSTOP, "CONT": signal.SIGCONT}
    s = sig_map.get(sig.upper())
    if s is None:
        return {"ok": False, "error": f"invalid signal: {sig}"}
    try:
        pgid = os.getpgid(pid)
        os.killpg(pgid, s)
        return {"ok": True, "pgid": pgid}
    except ProcessLookupError:
        return {"ok": False, "error": f"process {pid} not found"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def drop_caches() -> dict:
    try:
        subprocess.run(["sync"], timeout=10)
        _write_sysfs("/proc/sys/vm/drop_caches", "3")
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def set_sysctl(key: str, value: str) -> dict:
    allowed = {"vm.swappiness", "vm.dirty_ratio", "vm.dirty_background_ratio"}
    if key not in allowed:
        return {"ok": False, "error": f"sysctl not allowed: {key}"}
    try:
        result = subprocess.run(["sysctl", "-q", f"{key}={value}"], capture_output=True, text=True, timeout=5)
        return {"ok": result.returncode == 0}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def set_thp(mode: str) -> dict:
    if mode not in ("always", "madvise", "never"):
        return {"ok": False, "error": f"invalid thp mode: {mode}"}
    ok = _write_sysfs("/sys/kernel/mm/transparent_hugepage/enabled", mode)
    return {"ok": ok}
