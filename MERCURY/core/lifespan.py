"""
Lifespan FastAPI : chargement DB, refresh cache, démarrage/arrêt du worker.
"""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from data import db as db_module
from data import benchmark_db
from routing.router import apply_db_overrides, get_config
from routing.models_cache import refresh_shared as refresh_models_cache_shared
from app_queue.request_queue import _run_worker, init_queue
from providers.http_client import close_all as close_http_clients
from utils.log_cleanup import cleanup_old_logs

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db_module.load_db()
    benchmark_db.load_benchmark_db()
    apply_db_overrides()
    config = get_config()

    async def _startup_refresh():
        try:
            # Single-flight : si une requête /api/tags arrive pendant le refresh de démarrage,
            # elle partage cette tâche au lieu de lancer un second poll complet des backends.
            await refresh_models_cache_shared(config)
        except Exception as e:
            logger.warning("Refresh cache modèles (démarrage): %s", e)

    startup_refresh_task = asyncio.create_task(_startup_refresh())

    # Nettoyage des vieux logs au démarrage
    retention = int(config.get("log_retention_days", 0))
    if retention > 0:
        try:
            removed = cleanup_old_logs(retention)
            if removed:
                logger.info("Log cleanup: %d fichier(s) supprimé(s) (rétention %d jours)", removed, retention)
        except Exception as e:
            logger.warning("Log cleanup: %s", e)

    # Push brain settings au brain-daemon — au boot + toutes les 60s
    async def _brain_sync_loop():
        from admin.routes.llamacpp import push_brain_settings_on_startup, llamacpp_base
        import httpx

        await asyncio.sleep(5)  # laisser le brain-daemon démarrer
        last_push_ok = False

        while True:
            try:
                base = llamacpp_base()
                if base:
                    # Check si le brain est up
                    async with httpx.AsyncClient(timeout=3.0) as client:
                        r = await client.get(f"{base}/health")
                    if r.status_code == 200:
                        health = r.json()
                        # Re-push si on n'a pas encore réussi, ou si le brain vient de redémarrer
                        # (thermal not running alors qu'il devrait l'être)
                        settings = db_module.get_brain_settings()
                        thermal_should_run = settings.get("thermal_auto_start", False)
                        thermal_running = health.get("thermal", {}).get("running", False)
                        need_push = not last_push_ok or (thermal_should_run and not thermal_running)

                        if need_push:
                            await push_brain_settings_on_startup()
                            last_push_ok = True
                            logger.info("Brain settings synced")
                    else:
                        last_push_ok = False
            except Exception:
                last_push_ok = False
            await asyncio.sleep(60)

    brain_sync_task = asyncio.create_task(_brain_sync_loop())

    # Model scheduler loop (cron-based load/unload with exclusive slots)
    from scheduler.loop import run_loop as scheduler_run_loop
    scheduler_task = asyncio.create_task(scheduler_run_loop())

    # Initialisation idempotente de la condition queue avant le worker
    # (évite un crash si _run_worker() accède à _condition avant le premier enqueue)
    init_queue()
    worker_task = asyncio.create_task(_run_worker())
    logger.info("Worker de la file d'attente démarré")
    yield
    startup_refresh_task.cancel()
    brain_sync_task.cancel()
    scheduler_task.cancel()
    worker_task.cancel()
    try:
        await startup_refresh_task
    except asyncio.CancelledError:
        pass
    try:
        await brain_sync_task
    except asyncio.CancelledError:
        pass
    try:
        await scheduler_task
    except asyncio.CancelledError:
        pass
    try:
        await worker_task
    except asyncio.CancelledError:
        pass
    await close_http_clients()
    logger.info("Worker arrêté")
