"""
Main scheduler loop — evaluates cron schedules every 30s, activates/deactivates slots.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from croniter import croniter

from scheduler.models import ActiveSlot, RunStatus, ScheduleRun, Schedule
from scheduler import state as slot_state
from scheduler.executor import execute_actions, wait_for_idle

logger = logging.getLogger("mercury.scheduler")

TICK_SECONDS = 30
_run_history: list[dict] = []
_MAX_HISTORY = 100

# Mutex async sérialisant TOUTES les transitions de slot (activate/deactivate).
# Le threading.Lock de state.py ne protège QUE les accès atomiques mono-champ ; il
# ne couvre PAS la séquence multi-await de _activate_slot/_deactivate_slot (wait_for_idle
# + execute_actions font des appels httpx internes qui suspendent la coroutine jusqu'à
# ~120s AVANT que set_active_slot soit appelé). Sans ce verrou, deux activations
# concurrentes (double-clic sur /schedules/{id}/trigger, ou trigger manuel qui croise
# le tick cron) passent toutes deux le guard "raw is None", double-chargent les modèles,
# et la 2e set_active_slot écrase le snapshot de la 1re (actions_end ne restaurera jamais
# le bon état). On tient ce verrou sur tout le check-then-act de tick()/trigger_schedule()
# et sur _deactivate_slot() (appelé aussi en direct par l'endpoint /schedules/deactivate).
# asyncio.Lock n'est PAS réentrant : les helpers *_locked supposent le verrou déjà tenu
# par l'appelant et ne le ré-acquièrent jamais.
_op_lock = asyncio.Lock()

# Heartbeat consulté par /healthz pour détecter un scheduler qui a crashé.
# Mis à jour à chaque fin de tick() dans run_loop(). Si _last_tick_ts est plus
# ancien que ~3 × TICK_SECONDS, /healthz peut conclure que la loop est morte.
_last_tick_ts: float = 0.0


def get_last_tick_ts() -> float:
    return _last_tick_ts


def get_run_history() -> list[dict]:
    return list(_run_history)


def _add_run(run: ScheduleRun) -> None:
    _run_history.insert(0, run.model_dump())
    while len(_run_history) > _MAX_HISTORY:
        _run_history.pop()


def _compute_next_start(schedule: Schedule) -> str | None:
    """Compute next fire time for a schedule's cron_start in its timezone."""
    try:
        import zoneinfo
        tz = zoneinfo.ZoneInfo(schedule.timezone)
    except Exception:
        tz = timezone.utc
    now = datetime.now(tz)
    cron = croniter(schedule.cron_start, now)
    next_dt = cron.get_next(datetime)
    return next_dt.astimezone(timezone.utc).isoformat()


def compute_next_start(schedule: Schedule) -> str | None:
    return _compute_next_start(schedule)


async def _activate_slot(schedule: Schedule) -> None:
    """Execute start actions and activate the exclusive slot.

    PRÉCONDITION : _op_lock doit être tenu par l'appelant (tick/trigger_schedule) —
    cette fonction ne le ré-acquiert pas (asyncio.Lock non réentrant)."""
    # Re-check sous verrou : si un slot a été posé entre-temps (autre transition qui
    # a gagné la course pour le verrou), on refuse d'écraser son snapshot. Garde-fou
    # défensif — avec _op_lock tenu sur tout le check-then-act des appelants ce cas ne
    # devrait pas survenir, mais il évite tout double-load/overwrite silencieux résiduel.
    existing = slot_state._get_raw_active_slot()
    if existing is not None and not slot_state.is_slot_expired(existing):
        logger.warning(
            "_activate_slot: slot '%s' déjà actif, activation de '%s' ignorée (anti-overwrite)",
            existing.schedule_name, schedule.name,
        )
        return

    logger.info("Activating schedule '%s' (%s)", schedule.name, schedule.id)

    run = ScheduleRun(
        schedule_id=schedule.id,
        schedule_name=schedule.name,
        phase="start",
        status=RunStatus.started,
        started_at=datetime.now(timezone.utc).isoformat(),
    )

    try:
        if schedule.guard.wait_idle:
            idle = await wait_for_idle(schedule.guard.max_wait_seconds)
            if not idle:
                run.actions_log.append("WARN: queue not idle, proceeding anyway")

        logs, snapshot = await execute_actions(schedule.actions_start)
        run.actions_log = logs

        try:
            import zoneinfo
            tz = zoneinfo.ZoneInfo(schedule.timezone)
        except Exception:
            tz = timezone.utc
        now = datetime.now(tz)
        ends_at = now + timedelta(minutes=schedule.duration_minutes)

        slot = ActiveSlot(
            schedule_id=schedule.id,
            schedule_name=schedule.name,
            started_at=now.astimezone(timezone.utc).isoformat(),
            ends_at=ends_at.astimezone(timezone.utc).isoformat(),
            exclusive=schedule.exclusive,
            allowed_consumers=schedule.allowed_consumers,
            snapshot=snapshot,
        )
        slot_state.set_active_slot(slot)

        from data import db as db_module
        db_module.set_active_slot(slot.model_dump())

        run.status = RunStatus.completed
        run.finished_at = datetime.now(timezone.utc).isoformat()
    except Exception as e:
        run.status = RunStatus.failed
        run.error = str(e)
        run.finished_at = datetime.now(timezone.utc).isoformat()
        logger.exception("Failed to activate schedule '%s'", schedule.name)

    _add_run(run)


async def _deactivate_slot() -> None:
    """Wrapper public verrouillant la désactivation.

    Point d'entrée tenu par l'endpoint /schedules/deactivate (admin/routes/schedules.py),
    qui appelle directement sans détenir _op_lock. Acquiert le verrou puis délègue au core
    _deactivate_slot_locked(). Les appelants internes (tick/trigger_schedule) détiennent DÉJÀ
    _op_lock et doivent appeler _deactivate_slot_locked() directement (asyncio.Lock non
    réentrant — passer par ce wrapper provoquerait un deadlock)."""
    async with _op_lock:
        await _deactivate_slot_locked()


async def _deactivate_slot_locked() -> None:
    """Execute end actions and clear the active slot.

    PRÉCONDITION : _op_lock tenu par l'appelant.

    Transition sequence:
    1. Block ALL consumers (including the slot owner) — prevents re-triggering loads
    2. Wait for in-flight requests to drain
    3. Execute end actions (unload + restore)
    4. Clear slot — everyone can request again
    """
    # Use raw accessor: get_active_slot() masque les slots expirés et ferait return ici,
    # alors que l'expiration est précisément le cas qu'on doit cleanup.
    slot = slot_state._get_raw_active_slot()
    if slot is None:
        return

    from data import db as db_module
    schedules = db_module.get_schedules()
    schedule_data = schedules.get(slot.schedule_id)
    if not schedule_data:
        logger.warning("No schedule found for active slot %s, clearing", slot.schedule_id)
        slot_state.clear_active_slot()
        db_module.clear_active_slot()
        return

    schedule = Schedule(**schedule_data)
    logger.info("Deactivating schedule '%s' (%s) — entering transition", schedule.name, schedule.id)

    # Step 1: block everyone
    slot_state.enter_transition()

    run = ScheduleRun(
        schedule_id=schedule.id,
        schedule_name=schedule.name,
        phase="end",
        status=RunStatus.started,
        started_at=datetime.now(timezone.utc).isoformat(),
    )

    try:
        # Step 2: wait for in-flight requests to finish
        if schedule.guard.wait_idle:
            idle = await wait_for_idle(schedule.guard.max_wait_seconds)
            if not idle:
                run.actions_log.append("WARN: queue not idle after transition wait, proceeding anyway")

        # Step 3: swap models
        logs, _ = await execute_actions(schedule.actions_end, snapshot=slot.snapshot)
        run.actions_log.extend(logs)
        run.status = RunStatus.completed
        run.finished_at = datetime.now(timezone.utc).isoformat()
    except Exception as e:
        run.status = RunStatus.failed
        run.error = str(e)
        run.finished_at = datetime.now(timezone.utc).isoformat()
        logger.exception("Failed to deactivate schedule '%s'", schedule.name)
    finally:
        # Step 4: clear — everyone can request again
        slot_state.clear_active_slot()
        db_module.clear_active_slot()

    _add_run(run)


def _is_due(schedule: Schedule) -> bool:
    """Check if a schedule's cron is due (within the last TICK window)."""
    if not schedule.enabled:
        return False
    try:
        import zoneinfo
        tz = zoneinfo.ZoneInfo(schedule.timezone)
    except Exception:
        tz = timezone.utc
    now = datetime.now(tz)
    cron = croniter(schedule.cron_start, now - timedelta(seconds=TICK_SECONDS))
    next_dt = cron.get_next(datetime)
    return next_dt <= now


async def tick() -> None:
    """Single scheduler tick: check for slot expiry and due schedules."""
    # _op_lock tenu sur tout le check-then-act : on lit l'état du slot ET on
    # active/désactive sans qu'un trigger_schedule concurrent (même event loop) puisse
    # s'intercaler sur un await intermédiaire de _activate_slot/_deactivate_slot_locked.
    # On appelle les variantes *_locked (verrou déjà tenu — asyncio.Lock non réentrant).
    #
    # SKIP si une transition est déjà en cours : trigger_schedule()/endpoint deactivate peuvent
    # tenir _op_lock jusqu'à ~120s (wait_for_idle + httpx). Sans ce skip, tick() bloquerait sur
    # le verrou → run_loop coincé dans `await tick()` → _last_tick_ts gèle → /healthz déclare le
    # scheduler mort (>90s) → rollback nexusctl. Pas de TOCTOU : aucun await entre locked() et le
    # `async with` sur le même event loop, donc le verrou ne peut pas être volé entre les deux.
    if _op_lock.locked():
        logger.debug("tick: transition de slot en cours, skip de ce cycle")
        return
    async with _op_lock:
        # Raw accessor : get_active_slot() masque les slots expirés. Avant ce fix, l'expiration
        # ne déclenchait PAS _deactivate_slot (current devenait None instantanément) → snapshot
        # perdu, actions_end jamais exécutées, _active_slot lingering bloquait is_consumer_allowed
        # jusqu'à l'overwrite par le slot suivant.
        current = slot_state._get_raw_active_slot()
        if current is not None:
            expired = False
            try:
                ends = datetime.fromisoformat(current.ends_at)
                expired = datetime.now(timezone.utc) >= ends
            except Exception:
                pass
            if expired:
                await _deactivate_slot_locked()
                return  # Pas de nouvelle activation dans le même tick — évite la "double-fire"
            # Slot encore actif (pas expiré) : ne pas évaluer les schedules suivants
            return

        # Check due schedules
        from data import db as db_module
        schedules = db_module.get_schedules()
        for sid, data in schedules.items():
            try:
                schedule = Schedule(**{**data, "id": sid})
            except Exception as e:
                logger.warning("Invalid schedule %s: %s", sid, e)
                continue
            if _is_due(schedule):
                await _activate_slot(schedule)
                # Update next_start_at
                next_start = _compute_next_start(schedule)
                db_module.update_schedule(sid, {"next_start_at": next_start})
                break  # One activation per tick


async def run_loop() -> None:
    """Main scheduler loop — runs forever, ticking every TICK_SECONDS."""
    logger.info("Scheduler loop started (tick=%ds)", TICK_SECONDS)

    # Restore active slot from DB on startup (crash recovery)
    from data import db as db_module
    persisted_slot = db_module.get_active_slot()
    if persisted_slot:
        try:
            slot = ActiveSlot(**persisted_slot)
            ends = datetime.fromisoformat(slot.ends_at)
            if datetime.now(timezone.utc) < ends:
                slot_state.set_active_slot(slot)
                logger.info("Restored active slot from DB: %s (until %s)",
                            slot.schedule_name, slot.ends_at)
            else:
                logger.info("Persisted slot expired, clearing")
                db_module.clear_active_slot()
        except Exception as e:
            logger.warning("Failed to restore active slot: %s", e)
            db_module.clear_active_slot()

    global _last_tick_ts
    import time as _time
    while True:
        # Heartbeat en TÊTE de cycle : prouve que run_loop tourne toujours, même quand tick()
        # skip immédiatement parce qu'une transition de slot tient _op_lock. Évite que /healthz
        # voie le scheduler "mort" pendant une activation admin longue (cf. guard dans tick()).
        _last_tick_ts = _time.monotonic()
        try:
            await tick()
        except Exception as e:
            logger.exception("Scheduler tick error: %s", e)
        await asyncio.sleep(TICK_SECONDS)


async def trigger_schedule(schedule_id: str) -> dict:
    """Manually trigger a schedule (bypass cron check)."""
    from data import db as db_module
    schedules = db_module.get_schedules()
    data = schedules.get(schedule_id)
    if not data:
        return {"ok": False, "error": "Schedule not found"}

    # _op_lock tenu sur tout le check-then-act (lecture raw → deactivate forcée → activate),
    # sinon deux triggers quasi-simultanés (double-clic UI) passent tous deux le guard
    # "raw is None" avant que set_active_slot soit appelé, double-chargent les modèles et
    # la 2e activation écrase le snapshot de la 1re. On appelle les variantes *_locked
    # (verrou déjà tenu — asyncio.Lock non réentrant).
    async with _op_lock:
        # Raw accessor : get_active_slot() masque les slots expirés. Sans ça, un trigger
        # manuel entre l'expiration et le prochain tick() écraserait _active_slot via
        # _activate_slot sans exécuter actions_end + snapshot du slot précédent — exactement
        # le bug refermé dans tick() (commit 0b6f1729), répliqué ici. On force le cleanup
        # avant d'activer le nouveau slot.
        raw = slot_state._get_raw_active_slot()
        if raw is not None:
            try:
                from datetime import datetime as _dt, timezone as _tz
                ends = _dt.fromisoformat(raw.ends_at)
                if _dt.now(_tz.utc) >= ends:
                    logger.info("trigger_schedule: slot précédent expiré non-cleanup, deactivation forcée avant activation")
                    await _deactivate_slot_locked()
                else:
                    return {"ok": False, "error": "Another slot is already active"}
            except Exception:
                return {"ok": False, "error": "Another slot is already active"}

        schedule = Schedule(**{**data, "id": schedule_id})
        await _activate_slot(schedule)
        return {"ok": True, "schedule": schedule.name}
