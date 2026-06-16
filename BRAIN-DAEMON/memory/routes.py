"""Memory management API routes — mounted at /memory."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, HTTPException

if TYPE_CHECKING:
    from memory.controller import MemoryController

logger = logging.getLogger("brain-daemon.memory")
router = APIRouter(tags=["memory"])

_mc: Optional["MemoryController"] = None


def set_memory_controller(mc: "MemoryController"):
    global _mc
    _mc = mc


def _get_mc() -> "MemoryController":
    if _mc is None:
        raise HTTPException(status_code=503, detail="Memory controller not initialized")
    return _mc


# ── Status ───────────────────────────────────────────────────────────────────

@router.get("/status")
async def memory_status():
    return _get_mc().get_status()


@router.get("/events")
async def memory_events(last: int = 50):
    return {"events": _get_mc().get_events(last)}


# ── Lifecycle ────────────────────────────────────────────────────────────────

@router.post("/start")
async def memory_start():
    mc = _get_mc()
    mc.start()
    return {"status": "started"}


@router.post("/stop")
async def memory_stop():
    mc = _get_mc()
    mc.stop()
    return {"status": "stopped"}


# ── Config ───────────────────────────────────────────────────────────────────

@router.patch("/config")
async def memory_config(body: dict):
    mc = _get_mc()
    mc.update_config(body)
    return {"status": "updated", "thresholds": mc.get_status()["thresholds"]}


# ── Protect / Unprotect ──────────────────────────────────────────────────────

@router.post("/protect/{model_id:path}")
async def memory_protect(model_id: str):
    mc = _get_mc()
    mc.set_protected(model_id, True)
    return {"status": "protected", "model_id": model_id}


@router.post("/unprotect/{model_id:path}")
async def memory_unprotect(model_id: str):
    mc = _get_mc()
    mc.set_protected(model_id, False)
    return {"status": "unprotected", "model_id": model_id}


# ── Manual eviction ──────────────────────────────────────────────────────────

@router.post("/evict/{model_id:path}")
async def memory_evict(model_id: str):
    mc = _get_mc()
    inst = mc.manager.instances.get(model_id)
    if not inst:
        raise HTTPException(status_code=404, detail=f"Model not loaded: {model_id}")
    if not inst.is_running:
        raise HTTPException(status_code=400, detail=f"Model not running: {model_id}")
    ok = await mc._evict_model(model_id, reason="manual eviction", save_kv=True)
    if not ok:
        raise HTTPException(status_code=500, detail="Eviction failed")
    return {"status": "evicted", "model_id": model_id}


# ── Swap clear ───────────────────────────────────────────────────────────────

@router.post("/swap-clear")
async def swap_clear():
    """Run swapoff -a && swapon -a to flush swap back to RAM."""
    import asyncio as _aio
    logger.info("Clearing swap (swapoff -a && swapon -a)...")
    try:
        proc = await _aio.create_subprocess_exec(
            "bash", "-c", "swapoff -a && swapon -a",
            stdout=_aio.subprocess.PIPE,
            stderr=_aio.subprocess.PIPE,
        )
        stdout, stderr = await _aio.wait_for(proc.communicate(), timeout=120)
        if proc.returncode != 0:
            err = (stderr or stdout or b"").decode().strip()
            logger.warning("Swap clear failed (rc=%d): %s", proc.returncode, err)
            return {"status": "error", "detail": err, "returncode": proc.returncode}
        logger.info("Swap cleared successfully")
        return {"status": "ok"}
    except Exception as e:
        logger.error("Swap clear exception: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
