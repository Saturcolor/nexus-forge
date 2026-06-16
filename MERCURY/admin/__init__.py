"""Routes /admin (dashboard). Montage modulaire des sous-routers."""
from fastapi import APIRouter, Depends

from admin.common import check_admin_token
from admin.routes import config as routes_config
from admin.routes import queue_routes as routes_queue
from admin.routes import credits as routes_credits
from admin.routes import users as routes_users
from admin.routes import backends as routes_backends
from admin.routes import cache as routes_cache
from admin.routes import openrouter as routes_openrouter
from admin.routes import lm_studio as routes_lm_studio
from admin.routes import ollama as routes_ollama
from admin.routes import llamacpp as routes_llamacpp
from admin.routes import vision as routes_vision
from admin.routes import reasoning as routes_reasoning
from admin.routes import anthropic_routes as routes_anthropic
from admin.routes import amrevolt as routes_amrevolt
from admin.routes import benchmark as routes_benchmark
from admin.routes import ext_bench as routes_ext_bench
from admin.routes import audio_discovery as routes_audio_discovery
from admin.routes import memory_proxy as routes_memory_proxy
from admin.routes import schedules as routes_schedules

router = APIRouter(dependencies=[Depends(check_admin_token)])

router.include_router(routes_config.router, tags=["admin-config"])
router.include_router(routes_queue.router, tags=["admin-queue"])
router.include_router(routes_credits.router, tags=["admin-credits"])
router.include_router(routes_users.router, tags=["admin-users"])
router.include_router(routes_backends.router, tags=["admin-backends"])
router.include_router(routes_cache.router, tags=["admin-cache"])
router.include_router(routes_openrouter.router, tags=["admin-openrouter"])
router.include_router(routes_lm_studio.router, tags=["admin-lm-studio"])
router.include_router(routes_ollama.router, tags=["admin-ollama"])
router.include_router(routes_llamacpp.router, tags=["admin-llamacpp"])
router.include_router(routes_vision.router, tags=["admin-vision"])
router.include_router(routes_reasoning.router, tags=["admin-reasoning"])
router.include_router(routes_anthropic.router, tags=["admin-anthropic"])
router.include_router(routes_amrevolt.router, tags=["admin-amrevolt"])
router.include_router(routes_benchmark.router, tags=["admin-benchmark"])
router.include_router(routes_ext_bench.router, tags=["admin-ext-bench"])
router.include_router(routes_audio_discovery.router, tags=["admin-audio"])
router.include_router(routes_memory_proxy.router, tags=["admin-memory"])
router.include_router(routes_schedules.router, tags=["admin-schedules"])

__all__ = ["router"]
