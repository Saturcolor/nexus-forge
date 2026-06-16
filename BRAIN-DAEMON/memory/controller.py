"""MemoryController — Proactive RAM-based memory management for LLM models.
VRAM is monitored for visibility but never triggers eviction (it should stay full).
Only RAM pressure triggers eviction — the model with the highest RAM footprint is evicted first."""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import TYPE_CHECKING, Optional

from memory import monitor

if TYPE_CHECKING:
    from manager import ModelManager
    from thermal.controller import ThermalController

logger = logging.getLogger("brain-daemon.memory")


class MemoryController:
    """Monitors RAM + VRAM usage, evicts models when RAM pressure thresholds are hit.
    VRAM is display-only — it should always be full on Strix Halo."""

    def __init__(self, manager: "ModelManager", thermal: "ThermalController", config: dict,
                 persist_fn: Optional[callable] = None):
        self.manager = manager
        self.thermal = thermal
        self._persist_fn = persist_fn  # callback(model_id, key, value) → persists to load_configs

        mem = config.get("memory", {})
        # RAM thresholds (the only pool that matters for eviction)
        self.ram_warn_pct: float = mem.get("ram_warn_percent", 75)
        self.ram_evict_pct: float = mem.get("ram_evict_percent", 85)
        self.ram_emergency_pct: float = mem.get("ram_emergency_percent", 93)
        # Swap: auto-flush when swap above this % (sustained), eviction only at 90%+ with RAM pressure
        self.swap_flush_pct: float = mem.get("swap_flush_percent", 50)
        self.swap_hold_seconds: float = mem.get("swap_hold_seconds", 90)
        # Common
        self.interval: float = mem.get("interval", 2.0)
        self.headroom_gb: float = mem.get("preload_headroom_gb", 4.0)
        self.estimator_overhead_gib: float = mem.get("estimator_overhead_gib", 2.0)
        self.kv_save_timeout: float = mem.get("kv_save_timeout", 10.0)
        self.max_loaded: int = mem.get("max_loaded_models", 0)

        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._events: deque = deque(maxlen=100)
        self._estimate_cache: dict[str, dict] = {}  # model_id → estimate result (cached)

        # Hold timers: pressure must be sustained before eviction
        self._swap_pressure_since: float = 0.0   # time.time() when swap first exceeded threshold (0 = not in pressure)
        self._ram_pressure_since: float = 0.0

        # Snapshot updated each tick
        self._last_ram: dict = {}
        self._last_vram_used_mb: float = 0.0
        self._last_vram_total_mb: float = 0.0

    # ── Lifecycle ────────────────────────────────────────────────────────────

    @property
    def running(self) -> bool:
        return self._running

    def start(self):
        if self._running:
            return
        self._running = True
        self._task = asyncio.ensure_future(self._run())
        logger.info("Memory controller started (RAM %s/%s/%s%% swap=%s%% hold=%ss)",
                     self.ram_warn_pct, self.ram_evict_pct, self.ram_emergency_pct,
                     self.swap_flush_pct, self.swap_hold_seconds)

    def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            self._task = None
        logger.info("Memory controller stopped")

    # ── Main loop ────────────────────────────────────────────────────────────

    async def _run(self):
        try:
            while self._running:
                await self._tick()
                await asyncio.sleep(self.interval)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Memory controller loop crashed")
            self._running = False

    async def _tick(self):
        """One monitoring cycle: read pools, update per-model stats, check RAM pressure."""
        # Read system-level pools
        self._last_ram = monitor.read_ram_status()
        self._last_vram_used_mb = monitor.read_vram_used_mb()
        self._last_vram_total_mb = monitor.read_vram_total_mb()

        ram_pct = self._last_ram.get("percent", 0.0)

        # Update per-model memory stats
        for inst in self.manager.instances.values():
            if inst.process and inst.is_running:
                inst.ram_rss_mb = monitor.measure_process_ram_mb(inst.process.pid)
                # Backfill VRAM estimate for models loaded before memory controller
                if inst.vram_delta_mb < 1 and inst.gguf_path:
                    if inst.model_id not in self._estimate_cache:
                        est = monitor.estimate_model_memory(
                            inst.gguf_path, inst.ctx_size, self.estimator_overhead_gib
                        )
                        self._estimate_cache[inst.model_id] = est
                    est = self._estimate_cache.get(inst.model_id)
                    if est:
                        inst.vram_delta_mb = est["model_mb"]
                # RAM estimate = spillover only (weights that didn't fit in VRAM)
                # KV cache grows dynamically and is NOT pre-allocated in RAM
                if inst.gguf_path:
                    file_mb = self._estimate_cache.get(inst.model_id, {}).get("model_mb")
                    if not file_mb:
                        try:
                            file_mb = monitor._total_file_size(inst.gguf_path) / (1024 * 1024)
                        except OSError:
                            file_mb = 0
                    inst.ram_estimated_mb = max(0, file_mb - inst.vram_delta_mb)

        now = time.time()
        swap_pct = self._last_ram.get("swap_percent", 0.0)
        swap_used_mb = self._last_ram.get("swap_used_mb", 0)
        ram_avail_mb = self._last_ram.get("available_mb", 0)
        ram_pressure = ram_pct >= self.ram_evict_pct

        # ── Swap: sustained → auto-flush if RAM can absorb ───────────────
        if swap_pct >= self.swap_flush_pct:
            if self._swap_pressure_since == 0:
                self._swap_pressure_since = now
                logger.info("Swap pressure started — %.1f%% (%.0f MB), hold %ss",
                            swap_pct, swap_used_mb, self.swap_hold_seconds)
            held = now - self._swap_pressure_since
            if held >= self.swap_hold_seconds:
                if ram_avail_mb > swap_used_mb * 1.2:
                    logger.info("Auto-flushing swap (%.0f MB swap, %.0f MB RAM free)", swap_used_mb, ram_avail_mb)
                    await self._flush_swap()
                    await asyncio.sleep(2)
                    self._last_ram = monitor.read_ram_status()
                    swap_pct = self._last_ram.get("swap_percent", 0.0)
                    if swap_pct < self.swap_flush_pct:
                        logger.info("Swap flushed OK — %.1f%%", swap_pct)
                    else:
                        logger.warning("Swap still %.1f%% after flush — waiting for RAM pressure to evict", swap_pct)
                else:
                    logger.info("Swap %.1f%% but not enough free RAM to flush (%.0f MB free < %.0f MB swap)",
                                swap_pct, ram_avail_mb, swap_used_mb)
                self._swap_pressure_since = 0  # Reset timer, re-evaluate next cycle
        else:
            if self._swap_pressure_since > 0:
                logger.info("Swap pressure cleared — %.1f%%", swap_pct)
            self._swap_pressure_since = 0

        # ── Eviction: ONLY when swap full AND RAM exceeds threshold ───────
        # Single eviction gate: both conditions must be true.
        # Swap alone = flush. RAM alone = system handles it. Both = evict.
        swap_full = swap_pct >= 90  # swap nearly saturated
        if swap_full and ram_pressure:
            if self._ram_pressure_since == 0:
                self._ram_pressure_since = now
            held = now - self._ram_pressure_since
            if held >= 30:
                logger.warning("EVICTION TRIGGERED — swap %.1f%% + RAM %.1f%% >= %s%% sustained %.0fs",
                               swap_pct, ram_pct, self.ram_evict_pct, held)
                await self._evict_until_below()
                self._ram_pressure_since = 0
        else:
            self._ram_pressure_since = 0

        # Warnings (no action)
        if ram_pct >= self.ram_warn_pct and not (swap_full and ram_pressure):
            logger.info("Memory warning — RAM %.1f%% swap %.1f%%", ram_pct, swap_pct)

    # ── Eviction ─────────────────────────────────────────────────────────────

    def _select_candidate(self) -> Optional[str]:
        """Select the best eviction candidate (highest RAM footprint).
        Protected models are NEVER evicted, no exceptions.
        Returns model_id or None."""
        now = time.time()
        candidates = []
        for inst in self.manager.instances.values():
            if not inst.is_running:
                continue
            if inst.thermal_stopped:
                continue
            if inst.protected:
                continue
            # Skip actively inferring
            if (now - inst.last_inference_ts) < 5 and inst.prompt_pct > 0:
                continue
            candidates.append(inst)

        if not candidates:
            return None

        # Highest RAM footprint first (measured delta > estimate > RSS), oldest inference as tiebreaker
        candidates.sort(key=lambda i: (-(i.ram_delta_mb or i.ram_estimated_mb or i.ram_rss_mb), i.last_inference_ts))
        return candidates[0].model_id

    async def _evict_model(self, model_id: str, reason: str, save_kv: bool = True) -> bool:
        """Evict a specific model. Returns True if successfully unloaded."""
        inst = self.manager.instances.get(model_id)
        if not inst or not inst.is_running:
            return False

        ram_before = self._last_ram.get("percent", 0.0)
        freed_mb = inst.ram_delta_mb or inst.ram_estimated_mb or inst.ram_rss_mb

        # KV cache save
        kv_saved = False
        if save_kv and inst.kv_cache_auto_dump and self.manager.kv_cache_dir:
            try:
                await asyncio.wait_for(
                    self.manager.save_kv_cache(model_id),
                    timeout=self.kv_save_timeout,
                )
                kv_saved = True
            except Exception as exc:
                logger.warning("KV save failed for %s before eviction: %s", model_id, exc)

        logger.info("EVICTING model %s — reason: %s", model_id, reason)
        await self.manager.unload_model(model_id)

        ram_after = monitor.read_ram_status()
        ram_after_pct = ram_after.get("percent", 0.0)

        event = {
            "ts": time.time(),
            "type": "auto_evict",
            "model_id": model_id,
            "reason": reason,
            "memory_before_pct": round(ram_before, 1),
            "memory_after_pct": round(ram_after_pct, 1),
            "freed_mb": round(freed_mb, 1),
            "kv_saved": kv_saved,
        }
        self._events.append(event)
        logger.info("Evicted %s — RAM %.1f%% -> %.1f%%, freed ~%.0f MB (kv_saved=%s)",
                     model_id, ram_before, ram_after_pct, freed_mb, kv_saved)
        return True

    async def _evict_until_below(self):
        """Evict models until RAM is below eviction threshold. Protected models are never touched."""
        for _ in range(5):  # Safety limit
            candidate = self._select_candidate()
            if not candidate:
                logger.warning("No eviction candidate available (all models protected or active)")
                break

            ram_pct = self._last_ram.get("percent", 0.0)
            swap_pct = self._last_ram.get("swap_percent", 0.0)
            inst = self.manager.instances[candidate]
            idle = time.time() - inst.last_inference_ts
            ram_val = inst.ram_delta_mb or inst.ram_estimated_mb or inst.ram_rss_mb
            reason = f"ram {ram_pct:.1f}% swap {swap_pct:.1f}%, model idle {idle:.0f}s, ram ~{ram_val:.0f}MB"

            await self._evict_model(candidate, reason)

            # Re-check
            self._last_ram = monitor.read_ram_status()
            if self._last_ram.get("percent", 0.0) < self.ram_evict_pct:
                break

    # ── Pre-load check ───────────────────────────────────────────────────────

    async def preload_check(self, model_id: str, gguf_path: str, ctx_size: int) -> tuple[bool, str]:
        """Check if there is enough unified memory (VRAM + RAM) to load a model.
        On Strix Halo, weights go to VRAM first, then spill to RAM via UMA.
        May evict to make room. Returns (can_load, reason)."""
        estimate = monitor.estimate_model_memory(gguf_path, ctx_size, self.estimator_overhead_gib)
        headroom_mb = self.headroom_gb * 1024

        # Read current state
        ram = monitor.read_ram_status()
        vram_used = monitor.read_vram_used_mb()
        vram_total = monitor.read_vram_total_mb()
        vram_avail = max(0, vram_total - vram_used)
        ram_avail = ram.get("available_mb", 0)

        # Unified memory model: total weights + KV must fit in VRAM + RAM combined
        model_mb = estimate["model_mb"]
        kv_mb = estimate["kv_cache_mb"]
        needed_mb = model_mb + kv_mb + headroom_mb
        unified_avail = vram_avail + ram_avail

        if unified_avail >= needed_mb:
            logger.info("Pre-load %s OK — need %.1f GB (model %.1f + KV %.1f + headroom %.1f), avail %.1f GB (VRAM %.1f + RAM %.1f)",
                         model_id, needed_mb / 1024, model_mb / 1024, kv_mb / 1024, headroom_mb / 1024,
                         unified_avail / 1024, vram_avail / 1024, ram_avail / 1024)
            return True, ""

        # Tolerate small deficit (mmap will page in gradually, swap available)
        deficit = needed_mb - unified_avail
        tolerance_mb = max(2048, needed_mb * 0.03)  # 2 GB or 3% of needed, whichever is larger
        if deficit <= tolerance_mb:
            logger.info("Pre-load %s tight but OK — deficit %.1f GB within tolerance %.1f GB",
                         model_id, deficit / 1024, tolerance_mb / 1024)
            return True, ""

        # Not enough — try to free by evicting unprotected models
        logger.info("Pre-load %s: need %.1f GB unified, avail %.1f GB (VRAM %.1f + RAM %.1f), deficit %.1f GB (> tolerance %.1f GB)",
                     model_id, needed_mb / 1024, unified_avail / 1024,
                     vram_avail / 1024, ram_avail / 1024, deficit / 1024, tolerance_mb / 1024)

        # Freeable: sum of VRAM+RAM footprint of unprotected running models
        freeable = sum(
            (inst.vram_delta_mb + (inst.ram_delta_mb or inst.ram_estimated_mb or inst.ram_rss_mb))
            for inst in self.manager.instances.values()
            if inst.is_running and not inst.protected and not inst.thermal_stopped
        )

        if freeable < deficit:
            return False, (
                f"Memoire insuffisante: besoin ~{needed_mb / 1024:.1f} GB unifie, "
                f"disponible {unified_avail / 1024:.1f} GB (VRAM {vram_avail / 1024:.1f} + RAM {ram_avail / 1024:.1f}), "
                f"liberables {freeable / 1024:.1f} GB (modeles proteges exclus)"
            )

        await self._evict_until_below()

        # Re-check unified availability
        ram = monitor.read_ram_status()
        vram_used = monitor.read_vram_used_mb()
        vram_avail = max(0, vram_total - vram_used)
        ram_avail = ram.get("available_mb", 0)
        unified_avail = vram_avail + ram_avail
        if unified_avail >= needed_mb:
            return True, f"evicted models to free {needed_mb / 1024:.1f} GB"
        return False, (
            f"Memoire toujours insuffisante apres eviction: "
            f"{unified_avail / 1024:.1f} GB unifie disponible"
        )

    # ── Config update ────────────────────────────────────────────────────────

    def update_config(self, cfg: dict):
        """Update thresholds at runtime."""
        if "ram_warn_percent" in cfg:
            self.ram_warn_pct = cfg["ram_warn_percent"]
        if "ram_evict_percent" in cfg:
            self.ram_evict_pct = cfg["ram_evict_percent"]
        if "ram_emergency_percent" in cfg:
            self.ram_emergency_pct = cfg["ram_emergency_percent"]
        if "interval" in cfg:
            self.interval = cfg["interval"]
        if "max_loaded_models" in cfg:
            self.max_loaded = cfg["max_loaded_models"]
        if "swap_flush_percent" in cfg:
            self.swap_flush_pct = cfg["swap_flush_percent"]
        if "swap_hold_seconds" in cfg:
            self.swap_hold_seconds = cfg["swap_hold_seconds"]
        logger.info("Memory config updated: RAM %s/%s/%s swap=%s interval=%s",
                     self.ram_warn_pct, self.ram_evict_pct, self.ram_emergency_pct,
                     self.swap_flush_pct, self.interval)

    async def _flush_swap(self):
        """Run swapoff -a && swapon -a to move swap pages back to RAM."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "bash", "-c", "swapoff -a && swapon -a",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
            if proc.returncode == 0:
                logger.info("Swap flushed successfully")
            else:
                logger.warning("Swap flush failed (rc=%d): %s", proc.returncode,
                               (stderr or stdout or b"").decode().strip())
        except asyncio.TimeoutError:
            logger.error("Swap flush timed out (120s)")
        except Exception as e:
            logger.error("Swap flush error: %s", e)

    def set_protected(self, model_id: str, protected: bool):
        """Set protected flag on a model and persist to load_configs."""
        inst = self.manager.instances.get(model_id)
        if inst:
            inst.protected = protected
        if self._persist_fn:
            self._persist_fn(model_id, "protected", protected)
        logger.info("Model %s %s", model_id, "protected" if protected else "unprotected")

    # ── Status ───────────────────────────────────────────────────────────────

    def get_status(self) -> dict:
        now = time.time()

        # Read live if controller hasn't ticked yet or is stopped
        ram = self._last_ram if self._last_ram else monitor.read_ram_status()
        vram_used = self._last_vram_used_mb if self._last_vram_total_mb > 0 else monitor.read_vram_used_mb()
        vram_total = self._last_vram_total_mb if self._last_vram_total_mb > 0 else monitor.read_vram_total_mb()
        vram_pct = (vram_used / vram_total * 100) if vram_total > 0 else 0.0

        models = []
        for inst in self.manager.instances.values():
            if not inst.is_running:
                continue
            rss = inst.ram_rss_mb
            if not self._running and inst.process:
                rss = monitor.measure_process_ram_mb(inst.process.pid)
                inst.ram_rss_mb = rss
            ram_display = inst.ram_delta_mb or inst.ram_estimated_mb or rss
            models.append({
                "model_id": inst.model_id,
                "vram_delta_mb": round(inst.vram_delta_mb, 1),
                "ram_delta_mb": round(inst.ram_delta_mb, 1),
                "ram_estimated_mb": round(inst.ram_estimated_mb, 1),
                "ram_rss_mb": round(rss, 1),
                "ram_display_mb": round(ram_display, 1),
                "load_order": inst.load_order,
                "idle_seconds": round(now - inst.last_inference_ts, 0) if inst.last_inference_ts > 0 else -1,
                "protected": inst.protected,
                "thermal_stopped": inst.thermal_stopped,
            })

        return {
            "running": self._running,
            "ram": ram,
            "vram": {
                "total_mb": round(vram_total, 1),
                "used_mb": round(vram_used, 1),
                "available_mb": round(vram_total - vram_used, 1),
                "percent": round(vram_pct, 1),
            },
            "pressure": {
                "ram": ram.get("percent", 0) >= self.ram_evict_pct,
                "swap": ram.get("swap_percent", 0) >= self.swap_flush_pct,
            },
            "models": models,
            "thresholds": {
                "ram_warn_percent": self.ram_warn_pct,
                "ram_evict_percent": self.ram_evict_pct,
                "ram_emergency_percent": self.ram_emergency_pct,
                "swap_flush_percent": self.swap_flush_pct,
                "swap_hold_seconds": self.swap_hold_seconds,
            },
            "events_count": len(self._events),
        }

    def get_events(self, last: int = 50) -> list[dict]:
        return list(self._events)[-last:]
