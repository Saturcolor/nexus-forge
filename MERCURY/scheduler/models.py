"""Pydantic models for the scheduler: schedules, actions, slots, run history."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class ActionType(str, Enum):
    snapshot_state = "snapshot_state"
    restore_state = "restore_state"
    unload_all = "unload_all"
    load = "load"
    unload = "unload"


class ScheduleAction(BaseModel):
    type: ActionType
    backend: Optional[str] = None
    model: Optional[str] = None


class ScheduleGuard(BaseModel):
    wait_idle: bool = True
    max_wait_seconds: int = 120


class Schedule(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    name: str
    cron_start: str
    duration_minutes: int
    exclusive: bool = True
    allowed_consumers: list[str] = Field(default_factory=list)
    actions_start: list[ScheduleAction] = Field(default_factory=list)
    actions_end: list[ScheduleAction] = Field(default_factory=list)
    guard: ScheduleGuard = Field(default_factory=ScheduleGuard)
    enabled: bool = True
    timezone: str = "Europe/Paris"
    next_start_at: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class LoadedModelEntry(BaseModel):
    backend: str
    model_id: str


class SlotSnapshot(BaseModel):
    loaded_models: list[LoadedModelEntry] = Field(default_factory=list)


class ActiveSlot(BaseModel):
    schedule_id: str
    schedule_name: str
    started_at: str
    ends_at: str
    exclusive: bool = True
    allowed_consumers: list[str] = Field(default_factory=list)
    snapshot: Optional[SlotSnapshot] = None


class RunStatus(str, Enum):
    started = "started"
    completed = "completed"
    failed = "failed"


class ScheduleRun(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    schedule_id: str
    schedule_name: str
    phase: str  # "start" | "end"
    status: RunStatus
    started_at: str
    finished_at: Optional[str] = None
    error: Optional[str] = None
    actions_log: list[str] = Field(default_factory=list)
