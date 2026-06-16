"""Admin routes for model schedules: CRUD, manual trigger, history, active slot status."""
import logging

from croniter import croniter
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from data import db as db_module
from scheduler.models import Schedule
from scheduler.loop import compute_next_start, get_run_history, trigger_schedule
from scheduler import state as slot_state

logger = logging.getLogger("mercury.scheduler")
router = APIRouter()


@router.get("/schedules")
async def list_schedules():
    schedules = db_module.get_schedules()
    result = []
    for sid, data in schedules.items():
        result.append({**data, "id": sid})
    active = slot_state.get_active_slot()
    return JSONResponse(content={
        "schedules": result,
        "active_slot": active.model_dump() if active else None,
    })


@router.get("/schedules/{schedule_id}")
async def get_schedule(schedule_id: str):
    data = db_module.get_schedule(schedule_id)
    if not data:
        return JSONResponse(status_code=404, content={"detail": "Schedule not found"})
    return JSONResponse(content={**data, "id": schedule_id})


@router.post("/schedules")
async def create_schedule(body: dict):
    try:
        schedule = Schedule(**body)
    except Exception as e:
        return JSONResponse(status_code=400, content={"detail": f"Invalid schedule: {e}"})

    if not croniter.is_valid(schedule.cron_start):
        return JSONResponse(status_code=400, content={"detail": f"Invalid cron expression: {schedule.cron_start}"})

    schedule.next_start_at = compute_next_start(schedule)
    data = schedule.model_dump()
    sid = data.pop("id")
    db_module.set_schedule(sid, data)
    logger.info("Schedule created: %s (%s)", schedule.name, sid)
    return JSONResponse(status_code=201, content={**data, "id": sid})


@router.put("/schedules/{schedule_id}")
async def update_schedule(schedule_id: str, body: dict):
    existing = db_module.get_schedule(schedule_id)
    if not existing:
        return JSONResponse(status_code=404, content={"detail": "Schedule not found"})

    if "cron_start" in body:
        if not croniter.is_valid(body["cron_start"]):
            return JSONResponse(status_code=400, content={"detail": f"Invalid cron: {body['cron_start']}"})

    merged = {**existing, **body}
    try:
        schedule = Schedule(**{**merged, "id": schedule_id})
    except Exception as e:
        return JSONResponse(status_code=400, content={"detail": f"Invalid schedule: {e}"})

    schedule.next_start_at = compute_next_start(schedule)
    data = schedule.model_dump()
    data.pop("id", None)
    db_module.set_schedule(schedule_id, data)
    logger.info("Schedule updated: %s (%s)", schedule.name, schedule_id)
    return JSONResponse(content={**data, "id": schedule_id})


@router.delete("/schedules/{schedule_id}")
async def delete_schedule(schedule_id: str):
    active = slot_state.get_active_slot()
    if active and active.schedule_id == schedule_id:
        return JSONResponse(status_code=409, content={
            "detail": "Cannot delete schedule while its slot is active"
        })
    deleted = db_module.delete_schedule(schedule_id)
    if not deleted:
        return JSONResponse(status_code=404, content={"detail": "Schedule not found"})
    logger.info("Schedule deleted: %s", schedule_id)
    return JSONResponse(content={"ok": True})


@router.post("/schedules/{schedule_id}/trigger")
async def trigger_schedule_endpoint(schedule_id: str):
    result = await trigger_schedule(schedule_id)
    status = 200 if result.get("ok") else 409
    return JSONResponse(status_code=status, content=result)


@router.post("/schedules/deactivate")
async def deactivate_slot():
    """Force-deactivate the current slot (runs end actions).
    Utilise _get_raw_active_slot pour pouvoir cleanup un slot expiré-pas-encore-nettoyé
    (sinon l'opérateur tombe sur un 404 alors que _active_slot bloque toujours dans
    is_consumer_allowed — fenêtre de 30s entre expiration et prochain tick)."""
    active = slot_state._get_raw_active_slot()
    if active is None:
        return JSONResponse(status_code=404, content={"detail": "No active slot"})
    from scheduler.loop import _deactivate_slot
    await _deactivate_slot()
    return JSONResponse(content={"ok": True})


@router.get("/schedules-history")
async def get_history():
    return JSONResponse(content={"runs": get_run_history()})


@router.get("/schedules/active")
async def get_active_slot_status():
    return JSONResponse(content=slot_state.get_slot_status())
