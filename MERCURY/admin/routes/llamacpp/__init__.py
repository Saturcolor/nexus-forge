"""Routes admin llamacpp-daemon : modèles, templates, load/unload, status, logs, probe, thermal, perf, updater."""
from fastapi import APIRouter

from . import (
    brain,
    downloader,
    kv_cache,
    lifecycle,
    logs,
    models,
    session,
    templates,
    thermal_perf,
    updater,
)

router = APIRouter()
router.include_router(models.router)
router.include_router(templates.router)
router.include_router(lifecycle.router)
router.include_router(kv_cache.router)
router.include_router(logs.router)
router.include_router(session.router)
router.include_router(thermal_perf.router)
router.include_router(brain.router)
router.include_router(updater.router)
router.include_router(downloader.router)

from .brain import push_brain_settings_on_startup
from ._common import llamacpp_base

__all__ = ["router", "push_brain_settings_on_startup", "llamacpp_base"]
