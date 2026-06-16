"""
FastAPI app : création, middleware, enregistrement des routes (v1/chat, v1/responses, api/*).
"""
import logging
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from routing.router import get_config

from config.version import __version__ as _MERCURY_VERSION
from core.lifespan import lifespan
from core.routes_chat_completions import register as register_chat_completions
from core.routes_responses import register as register_responses
from core.routes_api import register as register_api
from core.routes_audio import register as register_audio
from core.routes_embeddings import register as register_embeddings
from core.routes_realtime import register as register_realtime
from core.routes_atlas import register as register_atlas
from core.routes_quant import register as register_quant

logger = logging.getLogger("mercury")


def create_app(static_dir: Path = None) -> FastAPI:
    app = FastAPI(title="Mercury", version=_MERCURY_VERSION, lifespan=lifespan)

    app.add_middleware(GZipMiddleware, minimum_size=1000)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        if get_config().get("debug"):
            logger.exception("Erreur non gérée: %s %s -> %s", request.method, request.url.path, exc)
            return JSONResponse(
                status_code=500,
                content={"detail": str(exc), "type": type(exc).__name__},
            )
        else:
            logger.error("Erreur non gérée: %s %s -> %s", request.method, request.url.path, exc)
            return JSONResponse(
                status_code=500,
                content={"detail": "Internal server error"},
            )

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        try:
            response = await call_next(request)
        except RuntimeError as exc:
            # Starlette BaseHTTPMiddleware lève RuntimeError("No response returned") quand le
            # client se déconnecte avant que la réponse (souvent streamée) soit produite —
            # typiquement un abort Mastermind pendant un long prompt-processing. C'est un abort
            # client, pas une erreur serveur : ne pas le remonter en 500 non géré (qui laisse
            # aussi une future asyncio non récupérée). Cf. stack trace mercury 2026-06-03 13:56.
            if "No response returned" in str(exc):
                logger.info("client déconnecté: %s %s", request.method, request.url.path)
                return Response(status_code=499)
            raise
        if request.url.path.startswith("/assets/") or request.url.path == "/":
            return response
        path = request.url.path.rstrip("/") or request.url.path
        if response.status_code >= 500:
            logger.error("%s %s -> %s", request.method, request.url.path, response.status_code)
        elif response.status_code >= 400:
            logger.info("%s %s -> %s", request.method, request.url.path, response.status_code)
        else:
            logger.debug("%s %s -> %s", request.method, request.url.path, response.status_code)
        return response

    register_chat_completions(app)
    register_responses(app)
    register_api(app)
    register_audio(app)
    register_embeddings(app)
    register_realtime(app)
    register_atlas(app)
    register_quant(app)

    @app.get("/v1/slots/active")
    async def get_slot_status():
        from scheduler import state as slot_state
        from fastapi.responses import JSONResponse
        return JSONResponse(content=slot_state.get_slot_status())

    @app.get("/healthz")
    async def healthz():
        """Liveness endpoint pour nexusctl auto-rollback.
        Si Mercury sait répondre ici, le bind a réussi et le lifespan s'est exécuté.
        On vérifie aussi le heartbeat du scheduler : sans ça, /healthz mentait quand
        run_loop crashait silencieusement (tâche en exception non rattrapée) — le
        process restait alive mais aucun slot ne s'expirait plus."""
        import time as _time
        from scheduler.loop import TICK_SECONDS, get_last_tick_ts
        last = get_last_tick_ts()
        now = _time.monotonic()
        # Fenêtre tolérante : 3× TICK_SECONDS au boot (~90s) pour laisser le premier
        # tick() arriver. Après ça, un gap > 3× TICK signale un scheduler mort.
        scheduler_stale = last > 0 and (now - last) > (3 * TICK_SECONDS)
        body = {
            "status": "ok" if not scheduler_stale else "degraded",
            "version": _MERCURY_VERSION,
            "scheduler_last_tick_age_s": round(now - last, 1) if last > 0 else None,
        }
        if scheduler_stale:
            return JSONResponse(content=body, status_code=503)
        return JSONResponse(content=body)

    return app


def mount_admin_routes(app: FastAPI):
    """Appelé depuis main.py après import de admin."""
    from admin import router as admin_router
    app.include_router(admin_router, prefix="/admin", tags=["admin"])



def mount_static(app: FastAPI, static_dir: Path):
    if static_dir and static_dir.is_dir():
        app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
