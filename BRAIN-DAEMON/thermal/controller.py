"""Thermal controller — throttling progressif continu.
Courbe lineaire unique pour le CPU, GPU en auto des que la protection est active.
SIGSTOP uniquement en urgence absolue (au-dela du tctl ryzenadj)."""
import asyncio
import logging
import time
from typing import TYPE_CHECKING, Optional

from thermal import root_client

if TYPE_CHECKING:
    from manager import ModelManager

logger = logging.getLogger("brain-daemon")

# Fichier d'actions pour le crash-monitor — chaque action du controller y est loguée
# avec flush immédiat. Survit au crash, lisible par le crash-monitor.
_ACTION_LOG = "/tmp/brain-thermal-actions.log"


def _log_action(action: str, details: str = ""):
    """Écrit une action dans le fichier d'actions ET dans le logger."""
    try:
        line = f"{time.strftime('%H:%M:%S.', time.localtime())}{int(time.time()*1000)%1000:03d} {action}"
        if details:
            line += f" | {details}"
        with open(_ACTION_LOG, "a") as f:
            f.write(line + "\n")
            f.flush()
    except Exception:
        pass

# === Sysfs paths ===
HWMON_BASE = "/sys/class/drm/card0/device/hwmon"
TEMP_INPUT_SUFFIX = "temp1_input"
POWER_INPUT_SUFFIX = "power1_input"
GPU_PERF_PATH = "/sys/class/drm/card0/device/power_dpm_force_performance_level"
CPU_FREQ_PATH = "/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq"
CPU_GOVERNOR_PATH = "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"


def _find_hwmon() -> Optional[str]:
    import glob
    paths = glob.glob(f"{HWMON_BASE}/hwmon*/temp1_input")
    return paths[0].rsplit("/", 1)[0] if paths else None


class ThermalController:
    # ── Config ────────────────────────────────────────────────────────────────
    # Courbe CPU : reduction lineaire de T_THROTTLE_START a T_THROTTLE_FULL
    T_THROTTLE_START = 75  # °C — en dessous = CPU freq max, au dessus = reduction progressive
    T_THROTTLE_FULL = 90   # °C — CPU freq min atteint (tout le budget thermique au GPU)
    T_EMERGENCY = 98       # °C — SIGSTOP (derniere protection avant trip kernel 110°C)
    T_EMERGENCY_HOLD = 2.0 # secondes au-dessus de T_EMERGENCY avant de trigger le SIGSTOP
    T_RESUME = 55          # °C — SIGCONT apres emergency
    COOLDOWN = 5           # secondes apres resume
    EMERGENCY_COOLDOWN = 0  # pas de cooldown — on resume immediatement a puissance reduite
    INTERVAL = 1.0         # secondes entre checks. 0.3s spammait sysfs 3.3 fois/sec et
                           # produisait des swings de freq violents qui finissaient par
                           # déstabiliser les rails partagés CPU/GPU (Vulkan device lost).
                           # La masse thermique du die ne bouge pas significativement en
                           # moins d'1s — pas la peine d'échantillonner plus vite.

    # CPU freq (kHz) — Ryzen AI Max+ 395
    CPU_MAX_FREQ = 5187500
    CPU_MIN_FREQ = 625000

    # Ecrire sysfs uniquement si la freq cible change de plus de ce delta (filtre le bruit thermique)
    FREQ_WRITE_THRESHOLD = 300000  # 300 MHz — ~1°C sur la courbe linéaire 75-90°C

    # Step max autorisé entre deux ticks consécutifs. Évite les swings brutaux genre
    # 5.2 GHz → 625 MHz en un tick (qui hammere les VRM et fait flancher les rails
    # partagés CPU/GPU). Avec INTERVAL=1s, ça plafonne le slew rate à 0.5 GHz/s.
    FREQ_MAX_STEP = 500000  # 500 MHz par tick

    # Lissage EMA de la température (Tctl est très bruyante sur Ryzen, oscille de ±2°C
    # facilement entre cores). Coefficient 0.4 → ~3 ticks de mémoire effective.
    TEMP_EMA_ALPHA = 0.4

    def __init__(self, manager: "ModelManager", config: dict | None = None):
        self.manager = manager
        self._running = False
        self._emergency = False
        self._stopped_pid: Optional[int] = None
        self._last_resume_ts: float = 0
        self._last_written_freq: int = 0
        self._last_gpu_level: str = ""
        self._emergency_since: float = 0  # timestamp du premier dépassement T_EMERGENCY
        self._emergency_started_at: float = 0  # timestamp du debut de l'emergency (pour cooldown)
        self._task: Optional[asyncio.Task] = None
        self._hwmon_path: Optional[str] = None
        self._temp_path: Optional[str] = None
        self._power_path: Optional[str] = None
        # EMA-smoothed temperature — None tant qu'on n'a pas reçu de première lecture
        self._temp_ema: Optional[float] = None

        if config:
            tc = config.get("thermal", {})
            self.T_THROTTLE_START = int(tc.get("throttle_start_c", self.T_THROTTLE_START))
            self.T_THROTTLE_FULL = int(tc.get("throttle_full_c", self.T_THROTTLE_FULL))
            self.T_EMERGENCY = int(tc.get("emergency_c", self.T_EMERGENCY))
            self.T_RESUME = int(tc.get("resume_c", self.T_RESUME))
            self.INTERVAL = float(tc.get("interval", self.INTERVAL))
            self.COOLDOWN = int(tc.get("cooldown", self.COOLDOWN))

    # ── Properties ────────────────────────────────────────────────────────────

    @property
    def running(self) -> bool:
        return self._running

    @property
    def level(self) -> str:
        """Niveau lisible pour l'API : throttle_pct (0-100) ou 'emergency'."""
        if not self._running:
            return "off"
        if self._emergency:
            return "emergency"
        return "active"

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self):
        if self._running:
            return
        self._hwmon_path = _find_hwmon()
        if self._hwmon_path:
            self._temp_path = f"{self._hwmon_path}/{TEMP_INPUT_SUFFIX}"
            self._power_path = f"{self._hwmon_path}/{POWER_INPUT_SUFFIX}"
            logger.info("Thermal: hwmon %s", self._hwmon_path)
        else:
            logger.warning("Thermal: hwmon introuvable")
        self._running = True
        self._emergency = False
        self._last_written_freq = 0
        self._last_gpu_level = ""
        self._emergency_since = 0
        # Clear action log on start
        try:
            with open(_ACTION_LOG, "w") as f:
                f.write(f"# brain-thermal actions — started {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        except Exception:
            pass
        self._task = asyncio.create_task(self._run())
        _log_action("CONTROLLER_START", f"throttle={self.T_THROTTLE_START}-{self.T_THROTTLE_FULL}°C emergency={self.T_EMERGENCY}°C resume={self.T_RESUME}°C")
        logger.info("Thermal started (throttle %d-%d°C, emergency %d°C, resume %d°C)",
                     self.T_THROTTLE_START, self.T_THROTTLE_FULL, self.T_EMERGENCY, self.T_RESUME)

    def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            self._task = None
        logger.info("Thermal stopped")

    # ── Readers (sysfs, world-readable) ───────────────────────────────────────

    def _ensure_hwmon(self):
        if not self._hwmon_path:
            self._hwmon_path = _find_hwmon()
            if self._hwmon_path:
                self._temp_path = f"{self._hwmon_path}/{TEMP_INPUT_SUFFIX}"
                self._power_path = f"{self._hwmon_path}/{POWER_INPUT_SUFFIX}"

    def read_temp(self) -> Optional[float]:
        if not self._temp_path:
            self._ensure_hwmon()
        if not self._temp_path:
            return None
        try:
            with open(self._temp_path, "r") as f:
                return int(f.read().strip()) / 1000.0
        except Exception:
            return None

    def read_power(self) -> Optional[float]:
        if not self._power_path:
            return None
        try:
            with open(self._power_path, "r") as f:
                return round(int(f.read().strip()) / 1_000_000, 1)
        except Exception:
            return None

    def read_cpu_freq(self) -> Optional[int]:
        try:
            with open(CPU_FREQ_PATH, "r") as f:
                return int(f.read().strip())
        except Exception:
            return None

    def read_gpu_level(self) -> Optional[str]:
        try:
            with open(GPU_PERF_PATH, "r") as f:
                return f.read().strip()
        except Exception:
            return None

    def read_governor(self) -> Optional[str]:
        try:
            with open(CPU_GOVERNOR_PATH, "r") as f:
                return f.read().strip()
        except Exception:
            return None

    # ── Status API ────────────────────────────────────────────────────────────

    def get_status(self) -> dict:
        self._ensure_hwmon()
        temp = self.read_temp()
        throttle_pct = self._calc_throttle_pct(temp) if temp is not None else None
        return {
            "running": self._running,
            "level": self.level,
            "emergency": self._emergency,
            "throttle_pct": throttle_pct,
            "temp_c": temp,
            "power_w": self.read_power(),
            "cpu_freq_khz": self.read_cpu_freq(),
            "gpu_level": self.read_gpu_level(),
            "governor": self.read_governor(),
            "stopped_pid": self._stopped_pid,
            "thresholds": {
                "throttle_start_c": self.T_THROTTLE_START,
                "throttle_full_c": self.T_THROTTLE_FULL,
                "emergency_c": self.T_EMERGENCY,
                "resume_c": self.T_RESUME,
            },
        }

    # ── Core logic ────────────────────────────────────────────────────────────

    def _calc_throttle_pct(self, temp: float) -> int:
        """Retourne 0 (aucun throttle) a 100 (freq min) selon la temperature."""
        if temp <= self.T_THROTTLE_START:
            return 0
        if temp >= self.T_THROTTLE_FULL:
            return 100
        return int((temp - self.T_THROTTLE_START) / (self.T_THROTTLE_FULL - self.T_THROTTLE_START) * 100)

    def _calc_target_freq(self, temp: float) -> int:
        """Calcule la freq CPU cible selon la temperature. Courbe lineaire."""
        pct = self._calc_throttle_pct(temp)
        if pct == 0:
            return self.CPU_MAX_FREQ
        if pct >= 100:
            return self.CPU_MIN_FREQ
        freq_range = self.CPU_MAX_FREQ - self.CPU_MIN_FREQ
        target = self.CPU_MAX_FREQ - int(freq_range * pct / 100)
        # Arrondir a 100 MHz
        target = (target // 100000) * 100000
        return max(self.CPU_MIN_FREQ, target)

    def _mark_instances_thermal(self, stopped: bool):
        for inst in self.manager.instances.values():
            if inst.is_running or stopped:
                inst.thermal_stopped = stopped

    async def _signal_llama(self, sig: str) -> bool:
        """Envoie STOP/CONT aux llama-server. Essaie plusieurs methodes."""
        import subprocess as sp

        instances = [i for i in self.manager.instances.values() if i.is_running and i.process]
        if not instances:
            logger.warning("THERMAL signal %s — aucune instance running", sig)
            return False

        ok = False
        for inst in instances:
            pid = inst.process.pid
            tbox = inst.toolbox_name or self.manager.toolbox_name
            run_as = self.manager.run_as_user
            signum = 19 if sig == "STOP" else 18  # SIGSTOP=19, SIGCONT=18

            # Methode 1: kill le process group host (sudo -> toolbox -> llama-server)
            # Pour les backends natifs, c'est la seule methode necessaire.
            try:
                import os
                pgid = os.getpgid(pid)
                os.killpg(pgid, signum)
                logger.info("THERMAL %s killpg(pgid=%d) OK (wrapper pid=%d)", sig, pgid, pid)
                ok = True
            except Exception as e:
                logger.warning("THERMAL %s killpg failed: %s", sig, e)

            # Methode 2: pkill par nom depuis l'host (pas dans le container)
            try:
                result = sp.run(["pkill", f"-{sig}", "-f", f"llama-server.*--port {inst.port}"],
                                capture_output=True, text=True, timeout=3)
                logger.info("THERMAL %s pkill host (port %d): rc=%d", sig, inst.port, result.returncode)
                if result.returncode == 0:
                    ok = True
            except Exception as e:
                logger.warning("THERMAL %s pkill host failed: %s", sig, e)

            # Methode 3: toolbox run kill (dans le container) — skip pour backends natifs
            if inst.backend_type != "native":
                try:
                    cmd = ["toolbox", "run", "-c", tbox, "pkill", f"-{sig}", "-f", "llama-server"]
                    if run_as:
                        cmd = ["sudo", "-u", run_as, "--"] + cmd
                    proc = await asyncio.create_subprocess_exec(
                        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    await asyncio.wait_for(proc.wait(), timeout=5)
                    logger.info("THERMAL %s toolbox pkill (tbox=%s): rc=%d", sig, tbox, proc.returncode or 0)
                    if proc.returncode == 0:
                        ok = True
                except Exception as e:
                    logger.warning("THERMAL %s toolbox pkill failed: %s", sig, e)

        return ok

    async def _apply_freq(self, freq: int, force: bool = False):
        """Ecrit la freq CPU avec deux protections (bypassables via `force=True`) :
         - threshold : ignore les variations < FREQ_WRITE_THRESHOLD (filtre le bruit thermique)
         - rate limit : plafonne le step à FREQ_MAX_STEP par tick (évite les swings brutaux
           qui hammerent les VRM et déstabilisent les rails partagés CPU/GPU → Vulkan device lost)

        `force=True` est utilisé par les transitions critiques (emergency thermal, cleanup
        au shutdown) où on veut atteindre la cible IMMÉDIATEMENT, sans slew rate. Pendant
        un emergency par exemple, le rate-limit ferait prendre 9 secondes pour passer de
        5.2 GHz à 625 MHz — temps pendant lequel le CPU continue de chauffer.
        """
        if force:
            result = await root_client.set_cpu_freq(freq)
            _log_action("SET_CPU_FREQ", f"target={freq}kHz ok={result.get('ok')} (forced)")
            self._last_written_freq = freq
            return

        if self._last_written_freq == 0:
            # Premier write — pas de référence pour le rate limit, on écrit direct.
            result = await root_client.set_cpu_freq(freq)
            _log_action("SET_CPU_FREQ", f"target={freq}kHz ok={result.get('ok')} (initial)")
            self._last_written_freq = freq
            return

        if abs(freq - self._last_written_freq) < self.FREQ_WRITE_THRESHOLD:
            return  # bruit, on ignore

        # Clamp le step pour ne jamais sauter de plus de FREQ_MAX_STEP en un tick.
        delta = freq - self._last_written_freq
        if abs(delta) > self.FREQ_MAX_STEP:
            clamped = self._last_written_freq + (self.FREQ_MAX_STEP if delta > 0 else -self.FREQ_MAX_STEP)
            clamped = max(self.CPU_MIN_FREQ, min(self.CPU_MAX_FREQ, clamped))
            result = await root_client.set_cpu_freq(clamped)
            _log_action("SET_CPU_FREQ", f"target={clamped}kHz ok={result.get('ok')} (clamped from {freq}kHz)")
            self._last_written_freq = clamped
            return

        result = await root_client.set_cpu_freq(freq)
        _log_action("SET_CPU_FREQ", f"target={freq}kHz ok={result.get('ok')}")
        self._last_written_freq = freq

    async def _apply_gpu(self, level: str):
        """Ecrit le GPU level seulement si change."""
        if level != self._last_gpu_level:
            result = await root_client.set_gpu_level(level)
            _log_action("SET_GPU_LEVEL", f"level={level} ok={result.get('ok')}")
            self._last_gpu_level = level

    async def _do_emergency(self, temp: float):
        if self._emergency:
            return
        logger.warning("THERMAL EMERGENCY — %.0f°C >= %d°C sustained %ds → SIGSTOP via toolbox",
                        temp, self.T_EMERGENCY, int(self.T_EMERGENCY_HOLD))
        _log_action("EMERGENCY_START", f"temp={temp:.1f}°C threshold={self.T_EMERGENCY}°C hold={self.T_EMERGENCY_HOLD}s")
        success = await self._signal_llama("STOP")
        _log_action("SIGSTOP_SENT", f"success={success}")
        if not success:
            logger.error("THERMAL EMERGENCY — SIGSTOP failed, no running instance found")
        self._mark_instances_thermal(True)
        self._emergency = True
        self._emergency_started_at = time.time()
        # force=True : pendant un emergency on bypass le rate-limit. Sinon le drop de
        # 5.2 GHz vers 625 MHz prendrait ~9 ticks (≈9s) et le CPU continuerait de chauffer.
        await self._apply_freq(self.CPU_MIN_FREQ, force=True)
        await self._apply_gpu("auto")
        _log_action("EMERGENCY_APPLIED", f"cpu={self.CPU_MIN_FREQ}kHz gpu=auto cooldown={self.EMERGENCY_COOLDOWN}s")

    async def _do_resume(self):
        if not self._emergency:
            return
        temp = self.read_temp()
        logger.info("THERMAL RESUME — %.0f°C → reducing power then SIGCONT", temp or 0)
        _log_action("RESUME_START", f"temp={temp:.1f}°C")

        # Reduire les power limits AVANT de resume — evite le spike a 200W+
        reduced = {"stapm_limit": 60000, "slow_limit": 60000, "fast_limit": 80000, "apu_slow_limit": 60000}
        r = await root_client.ryzenadj(reduced)
        _log_action("RESUME_POWER_REDUCED", f"stapm=60W fast=80W ok={r.get('ok')}")

        success = await self._signal_llama("CONT")
        _log_action("SIGCONT_SENT", f"success={success}")

        self._mark_instances_thermal(False)
        self._emergency = False
        self._last_resume_ts = time.time()
        # GPU reste en auto pendant le ramp-up — high force les clocks max et ignore les power limits
        _log_action("RESUME_APPLIED", "gpu=auto power=60W")

        # Remonter progressivement les power limits
        asyncio.create_task(self._ramp_up_power())

    async def _ramp_up_power(self):
        """Remonte les power limits par paliers de 15W toutes les 10s apres un resume.
        GPU reste en auto pendant le ramp, repasse en high au dernier palier."""
        ramp = [
            (10, 75000, 100000),
            (10, 90000, 110000),
            (10, 105000, 120000),
            (10, 120000, 140000),
        ]
        for i, (delay, stapm, fast) in enumerate(ramp):
            await asyncio.sleep(delay)
            if self._emergency:
                _log_action("RAMP_ABORT", "re-entered emergency")
                return
            temp = self.read_temp()
            if temp and temp > self.T_THROTTLE_FULL:
                _log_action("RAMP_PAUSED", f"temp={temp:.0f}°C too hot, staying at current limits")
                return
            limits = {"stapm_limit": stapm, "slow_limit": stapm, "fast_limit": fast, "apu_slow_limit": stapm}
            r = await root_client.ryzenadj(limits)
            _log_action("RAMP_UP", f"stapm={stapm//1000}W fast={fast//1000}W temp={temp:.0f}°C ok={r.get('ok')}")
            logger.info("THERMAL ramp-up: %dW (temp=%.0f°C)", stapm // 1000, temp or 0)

            if i == len(ramp) - 1:
                _log_action("RAMP_COMPLETE", f"stapm=120W gpu=auto (high disabled — bypasses power limits)")

    async def _run(self):
        """Boucle principale — throttling progressif continu.
        GPU en auto tout le temps. CPU reduit lineairement de T_THROTTLE_START a T_THROTTLE_FULL.
        SIGSTOP uniquement a T_EMERGENCY."""
        last_logged_pct = -1
        try:
            # GPU en auto — le mode "high" bypass les power limits et tire 200W+ (thermal crash garanti).
            # En auto le GPU tourne a ~2500MHz/100% busy/60-120W — ~15% moins vite mais stable.
            await self._apply_gpu("auto")

            while self._running:
                temp_raw = self.read_temp()
                if temp_raw is None:
                    await asyncio.sleep(1)
                    continue

                # EMA smoothing — Tctl bruit ±2°C entre cores. Sans lissage, la courbe
                # linéaire produit des swings de freq sur du bruit, pas du vrai signal.
                # IMPORTANT : on garde temp_raw pour le check emergency (un vrai spike
                # >98°C doit déclencher SIGSTOP même si l'EMA est encore en dessous).
                # L'EMA n'est utilisée QUE pour la courbe de throttle progressive.
                if self._temp_ema is None:
                    self._temp_ema = temp_raw
                else:
                    self._temp_ema = self.TEMP_EMA_ALPHA * temp_raw + (1 - self.TEMP_EMA_ALPHA) * self._temp_ema
                temp = temp_raw  # par défaut emergency-checks utilisent le raw
                temp_smooth = self._temp_ema  # courbe de throttle utilise le smoothed

                now = time.time()

                if self._emergency:
                    elapsed = now - self._emergency_started_at
                    if temp < self.T_RESUME and elapsed >= self.EMERGENCY_COOLDOWN:
                        await self._do_resume()
                    await asyncio.sleep(self.INTERVAL)
                    continue

                if (now - self._last_resume_ts) < self.COOLDOWN:
                    # En cooldown — seul un emergency soutenu peut re-trigger
                    if temp >= self.T_EMERGENCY:
                        if self._emergency_since == 0:
                            self._emergency_since = now
                        elif (now - self._emergency_since) >= self.T_EMERGENCY_HOLD:
                            await self._do_emergency(temp)
                    else:
                        self._emergency_since = 0
                    await asyncio.sleep(self.INTERVAL)
                    continue

                # Emergency check — seulement si temp >= T_EMERGENCY pendant T_EMERGENCY_HOLD secondes
                if temp >= self.T_EMERGENCY:
                    if self._emergency_since == 0:
                        self._emergency_since = now
                        logger.warning("THERMAL %.0f°C >= %d°C — compteur emergency demarre", temp, self.T_EMERGENCY)
                        _log_action("EMERGENCY_COUNTER_START", f"temp={temp:.1f}°C")
                    elif (now - self._emergency_since) >= self.T_EMERGENCY_HOLD:
                        await self._do_emergency(temp)
                        await asyncio.sleep(self.INTERVAL)
                        continue
                    # Pendant le hold : la courbe progressive continue de throttle le CPU
                else:
                    if self._emergency_since > 0:
                        self._emergency_since = 0  # reset, c'etait un spike

                # Courbe progressive — utilise la temp lissée pour éviter de réagir
                # au bruit de Tctl. L'emergency a déjà été vérifié sur temp_raw plus haut.
                target_freq = self._calc_target_freq(temp_smooth)
                await self._apply_freq(target_freq)

                # Log uniquement quand le % de throttle change de >=10 points
                pct = self._calc_throttle_pct(temp_smooth)
                bucket = (pct // 10) * 10
                if bucket != last_logged_pct:
                    if pct == 0:
                        logger.info("THERMAL %.0f°C (raw %.0f) — full perf (CPU %s)", temp_smooth, temp_raw, f"{target_freq/1e6:.1f}GHz")
                    else:
                        logger.info("THERMAL %.0f°C (raw %.0f) — throttle %d%% (CPU %s)", temp_smooth, temp_raw, pct, f"{target_freq/1e6:.1f}GHz")
                    last_logged_pct = bucket

                await asyncio.sleep(self.INTERVAL)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error("Thermal controller crash: %s", e, exc_info=True)
        finally:
            if self._emergency:
                await self._signal_llama("CONT")
                self._mark_instances_thermal(False)
            await root_client.set_cpu_freq(self.CPU_MAX_FREQ)
            # Ne PAS remettre high — le mode perf le fera si voulu
            self._last_written_freq = 0
            self._last_gpu_level = ""
            logger.info("Thermal cleanup: CPU freq max restored")
