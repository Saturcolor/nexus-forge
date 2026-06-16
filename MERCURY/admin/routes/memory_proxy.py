"""Proxy admin routes for brain daemon memory controller.
The frontend cannot reach the daemon directly (network separation), so Mercury proxies.
All routes forward to daemon:4321/memory/*."""
import logging

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from routing.router import get_config

logger = logging.getLogger("mercury")
router = APIRouter()

_TIMEOUT = 10.0


def _daemon_url() -> str:
    config = get_config()
    return str(config.get("llamacpp_url", "http://localhost:4321")).rstrip("/")


async def _proxy_get(path: str) -> JSONResponse:
    url = f"{_daemon_url()}{path}"
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(url, timeout=_TIMEOUT)
            return JSONResponse(content=r.json(), status_code=r.status_code)
    except Exception as e:
        logger.warning("Memory proxy GET %s failed: %s", path, e)
        return JSONResponse(status_code=502, content={"detail": str(e)})


async def _proxy_post(path: str, body: dict | None = None) -> JSONResponse:
    url = f"{_daemon_url()}{path}"
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(url, json=body or {}, timeout=_TIMEOUT)
            return JSONResponse(content=r.json(), status_code=r.status_code)
    except Exception as e:
        logger.warning("Memory proxy POST %s failed: %s", path, e)
        return JSONResponse(status_code=502, content={"detail": str(e)})


async def _proxy_patch(path: str, body: dict | None = None) -> JSONResponse:
    url = f"{_daemon_url()}{path}"
    try:
        async with httpx.AsyncClient() as client:
            r = await client.patch(url, json=body or {}, timeout=_TIMEOUT)
            return JSONResponse(content=r.json(), status_code=r.status_code)
    except Exception as e:
        logger.warning("Memory proxy PATCH %s failed: %s", path, e)
        return JSONResponse(status_code=502, content={"detail": str(e)})


# ── Status & events ──────────────────────────────────────────────────────────

@router.get("/brain/memory/status")
async def memory_status():
    return await _proxy_get("/memory/status")


@router.get("/brain/memory/events")
async def memory_events():
    return await _proxy_get("/memory/events")


# ── Lifecycle ────────────────────────────────────────────────────────────────

@router.post("/brain/memory/start")
async def memory_start():
    return await _proxy_post("/memory/start")


@router.post("/brain/memory/stop")
async def memory_stop():
    return await _proxy_post("/memory/stop")


# ── Config ───────────────────────────────────────────────────────────────────

@router.patch("/brain/memory/config")
async def memory_config(body: dict):
    return await _proxy_patch("/memory/config", body)


# ── Protect / Unprotect ──────────────────────────────────────────────────────

@router.post("/brain/memory/protect/{model_id:path}")
async def memory_protect(model_id: str):
    return await _proxy_post(f"/memory/protect/{model_id}")


@router.post("/brain/memory/unprotect/{model_id:path}")
async def memory_unprotect(model_id: str):
    return await _proxy_post(f"/memory/unprotect/{model_id}")


# ── Eviction ─────────────────────────────────────────────────────────────────

@router.post("/brain/memory/evict/{model_id:path}")
async def memory_evict(model_id: str):
    return await _proxy_post(f"/memory/evict/{model_id}")


@router.post("/brain/memory/swap-clear")
async def swap_clear():
    return await _proxy_post("/memory/swap-clear")
