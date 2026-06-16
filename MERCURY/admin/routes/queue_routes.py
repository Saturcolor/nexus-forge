"""Routes admin : queue, logs, stats, dates."""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app_queue.request_queue import (
    get_queue_stats,
    get_recent_logs,
    get_logs_for_date,
    get_stats_for_date,
    get_stats_range,
    get_available_dates,
    cancel_current_request,
)
from admin.common import json_safe

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/queue")
def get_queue():
    try:
        stats = get_queue_stats()
        return JSONResponse(content=json_safe(stats))
    except Exception as e:
        logger.exception("GET /admin/queue: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.post("/queue/cancel")
async def post_cancel_queue():
    try:
        result = await cancel_current_request()
        return JSONResponse(content=result)
    except Exception as e:
        logger.exception("POST /admin/queue/cancel: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.get("/logs")
def get_logs(date: str | None = Query(None, description="YYYY-MM-DD")):
    try:
        if date:
            logs = get_logs_for_date(date)
        else:
            logs = get_recent_logs()
        return JSONResponse(content=json_safe(logs))
    except Exception as e:
        logger.exception("GET /admin/logs: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.get("/stats")
def get_stats(date: str | None = Query(None, description="YYYY-MM-DD")):
    try:
        date_str = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        stats = get_stats_for_date(date_str)
        return JSONResponse(content=json_safe(stats))
    except Exception as e:
        logger.exception("GET /admin/stats: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.get("/stats-range")
def get_stats_range_route(
    days: int = Query(7, ge=1, le=366, description="Fenêtre en jours"),
    bucket: str = Query("day", pattern="^(day|hour)$"),
):
    try:
        data = get_stats_range(days, bucket)
        return JSONResponse(content=json_safe(data))
    except Exception as e:
        logger.exception("GET /admin/stats-range: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.get("/dates")
def get_dates():
    try:
        dates = get_available_dates()
        return JSONResponse(content=dates)
    except Exception as e:
        logger.exception("GET /admin/dates: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})
