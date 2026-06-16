"""QuantManager — orchestrateur des jobs de quantization côté brain-daemon.

Single-worker asyncio queue : un seul quant à la fois (GPU partagé avec
llama-server). Persistence sur disque (~/mercury/quant-jobs.json) pour
survivre aux restarts du daemon — les subprocess survivent en orphelin,
on les détecte au boot.

Stream NDJSON : chaque job a un asyncio.Queue d'events ; les clients
GET /quant/jobs/{id}/stream consomment depuis là (multi-consumer via
broadcast-fanout maison).

Types de jobs :
    quantize           : payload {source_path, calibration_path|imatrix_path, presets, toolbox}
    imatrix_build      : payload {source_path, calibration_path, chunks, ctx, batch, ngl, toolbox}
    analyze_gguf       : payload {output_path}
    calibration_build  : payload {source_dir, output_name, ...}  (Phase 7, placeholder)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

from .lib import config as quant_config
from .lib import imatrix as lib_imatrix
from .lib import presets as lib_presets
from .lib import quantize as lib_quantize
from .lib import scan as lib_scan
from .lib import toolbox as lib_toolbox
from .lib.paths import QuantPaths

log = logging.getLogger("brain.quant.manager")


# ────────────────────────────────────────────────────────────────────────────
# Data classes
# ────────────────────────────────────────────────────────────────────────────

JobStatus = str  # "pending" | "queued" | "running" | "done" | "failed" | "cancelled"


@dataclass
class JobOutput:
    name: str
    path: str
    size_bytes: int
    preset_name: str
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Job:
    id: str
    type: str
    status: JobStatus
    payload: dict[str, Any]
    created_at: float
    started_at: float | None = None
    finished_at: float | None = None
    progress_pct: float = 0.0
    progress_message: str | None = None
    outputs: list[JobOutput] = field(default_factory=list)
    error_message: str | None = None
    pid: int | None = None        # PID du subprocess en cours (pour cleanup orphelin)
    log_path: str | None = None   # fichier log per-run

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "status": self.status,
            "payload": self.payload,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "progress_pct": self.progress_pct,
            "progress_message": self.progress_message,
            "outputs": [o.to_dict() for o in self.outputs],
            "error_message": self.error_message,
            "pid": self.pid,
            "log_path": self.log_path,
        }


# ────────────────────────────────────────────────────────────────────────────
# Manager
# ────────────────────────────────────────────────────────────────────────────

class QuantManager:
    """Single-worker queue manager. Thread-safe via asyncio."""

    def __init__(self, cfg: dict, paths: QuantPaths, persist_path: Path | None = None):
        self.cfg = cfg
        self.paths = paths
        # ~/mercury/ existe via imatrix_dir.parent normalement
        self.persist_path = persist_path or (paths.imatrix_dir.parent / "quant-jobs.json")
        # Logs per-run
        self.log_dir = Path.home() / ".cache" / "brain-quant"
        self.log_dir.mkdir(parents=True, exist_ok=True)

        self._jobs: dict[str, Job] = {}
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        # Cancellation events per running job
        self._cancel_events: dict[str, asyncio.Event] = {}
        # NDJSON event queues per job (multi-consumer fan-out)
        self._streams: dict[str, list[asyncio.Queue[dict]]] = {}
        # Heartbeat task
        self._heartbeat_task: asyncio.Task | None = None
        self._worker_task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        # Référence event loop pour les callbacks invoqués depuis to_thread()
        # worker threads (progress_cb, pid_cb). Sans ça, asyncio.Queue.put_nowait
        # et dict mutations depuis un thread non-event-loop sont unsafe
        # (audit R3-M5/M6).
        self._loop: asyncio.AbstractEventLoop | None = None

    # ─── Lifecycle ───

    async def start(self) -> None:
        """Démarre le worker. Au boot : load persistence + marque les jobs
        running comme orphelins (failed)."""
        self._loop = asyncio.get_running_loop()
        self._load_state()
        self._recover_orphans()
        self._worker_task = asyncio.create_task(self._worker(), name="quant-worker")
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(), name="quant-heartbeat")
        log.info("QuantManager started")

    async def stop(self) -> None:
        self._stop_event.set()
        # Audit R3-L10 : tuer les subprocess actifs AVANT de cancel l'asyncio
        # task. asyncio.to_thread() n'est pas interruptible — sans ce kill,
        # daemon.stop() hang jusqu'à la fin naturelle d'un quant en cours
        # (potentiellement 30+ min).
        for j in list(self._jobs.values()):
            if j.status == "running" and j.pid:
                try:
                    os.killpg(j.pid, signal.SIGKILL)
                    log.warning(f"killed PID group {j.pid} for job {j.id} on shutdown")
                except ProcessLookupError:
                    pass
                except OSError as e:
                    log.warning(f"failed to kill PID {j.pid} on shutdown: {e}")
        # Signal cancel aux runners (qui sortiront proprement au prochain check)
        for ev in self._cancel_events.values():
            ev.set()
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
        self._save_state()
        log.info("QuantManager stopped")

    # ─── Persistence ───

    def _save_state(self) -> None:
        try:
            self.persist_path.parent.mkdir(parents=True, exist_ok=True)
            # Snapshot la liste AVANT iter pour éviter RuntimeError "dict changed
            # size" si appelé depuis un thread worker pendant qu'un nouveau job
            # est ajouté côté event loop (audit R3-M6). Les dataclass reads
            # sur Job sont safe (juste des attribute reads atomiques).
            snapshot = list(self._jobs.values())
            with open(self.persist_path, "w", encoding="utf-8") as f:
                json.dump(
                    {"jobs": [j.to_dict() for j in snapshot]},
                    f, indent=2,
                )
        except Exception:
            log.exception("save_state failed")

    def _save_state_threadsafe(self) -> None:
        """Variante callable depuis un worker thread (to_thread).

        Schedule l'I/O et la prise du snapshot sur l'event loop pour rester
        cohérent avec les mutations qui se font côté event loop (audit R3-M6).
        Si pas de loop (ex: stop déjà appelé), fallback inline.
        """
        if self._loop is not None and self._loop.is_running():
            try:
                self._loop.call_soon_threadsafe(self._save_state)
                return
            except RuntimeError:
                pass
        self._save_state()

    def _load_state(self) -> None:
        if not self.persist_path.exists():
            return
        try:
            with open(self.persist_path, encoding="utf-8") as f:
                data = json.load(f)
            for jd in data.get("jobs", []):
                outputs = [JobOutput(**o) for o in jd.get("outputs", [])]
                jd["outputs"] = outputs
                self._jobs[jd["id"]] = Job(**jd)
            log.info(f"loaded {len(self._jobs)} jobs from {self.persist_path}")
        except Exception:
            log.exception("load_state failed")

    def _recover_orphans(self) -> None:
        """Au boot : tout job qui était 'running' au moment du crash est orphelin.

        Le subprocess llama-* peut survivre dans son group de session (le manager
        spawn avec `start_new_session=True`, cf toolbox._popen_kwargs). On essaie
        de le tuer via son PID persisté, puis on marque le job failed.

        Les jobs 'queued' n'ont pas démarré → on les remet en 'pending' pour que
        le worker les reprenne au prochain tick.
        """
        import os
        import signal
        recovered_failed = 0
        recovered_requeued = 0
        for j in self._jobs.values():
            if j.status == "running":
                if j.pid:
                    try:
                        # SIGKILL au group entier (start_new_session → pid == pgid)
                        os.killpg(j.pid, signal.SIGKILL)
                        log.warning(f"killed orphan PID group {j.pid} for job {j.id}")
                    except ProcessLookupError:
                        pass  # déjà mort
                    except OSError as e:
                        log.warning(f"failed to kill orphan PID {j.pid}: {e}")
                j.status = "failed"
                j.error_message = (j.error_message or "") + " / daemon restart (orphan)"
                j.finished_at = time.time()
                j.pid = None
                recovered_failed += 1
            elif j.status in ("queued", "pending"):
                # Pas encore démarré → re-queue pour reprise propre.
                j.status = "queued"
                self._queue.put_nowait(j.id)
                self._streams.setdefault(j.id, [])
                self._cancel_events.setdefault(j.id, asyncio.Event())
                recovered_requeued += 1
        if recovered_failed or recovered_requeued:
            log.warning(
                f"recovery: {recovered_failed} orphan(s) killed+failed, "
                f"{recovered_requeued} requeued"
            )
            self._save_state()

    # ─── Public API ───

    async def submit_job(self, type_: str, payload: dict[str, Any]) -> Job:
        if type_ not in ("quantize", "imatrix_build", "analyze_gguf", "calibration_build"):
            raise ValueError(f"unknown job type: {type_}")
        job = Job(
            id=f"q-{uuid.uuid4().hex[:8]}",
            type=type_,
            status="queued",
            payload=payload,
            created_at=time.time(),
        )
        self._jobs[job.id] = job
        self._streams[job.id] = []
        self._cancel_events[job.id] = asyncio.Event()
        await self._queue.put(job.id)
        self._publish(job.id, {"event": "queued", "job_id": job.id})
        self._save_state()
        log.info(f"submitted job {job.id} type={type_}")
        return job

    def list_jobs(self, limit: int = 100) -> list[Job]:
        return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)[:limit]

    def get_job(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def current_job(self) -> Job | None:
        for j in self._jobs.values():
            if j.status == "running":
                return j
        return None

    def queue_len(self) -> int:
        return sum(1 for j in self._jobs.values() if j.status == "queued")

    async def cancel_job(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job:
            return False
        if job.status not in ("queued", "running", "pending"):
            return False
        ev = self._cancel_events.get(job_id)
        if ev is not None:
            ev.set()
        if job.status == "queued":
            # Pas encore démarré → on le marque cancelled directement.
            job.status = "cancelled"
            job.finished_at = time.time()
            self._publish(job_id, {"event": "cancelled"})
            self._save_state()
        return True

    def delete_job(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job:
            return False
        if job.status in ("running", "queued"):
            return False
        self._jobs.pop(job_id, None)
        self._streams.pop(job_id, None)
        self._cancel_events.pop(job_id, None)
        self._save_state()
        return True

    # ─── NDJSON streaming ───

    async def stream(self, job_id: str) -> "asyncio.Queue[dict]":
        """Crée un Queue pour les events. Le caller consomme et close."""
        if job_id not in self._jobs:
            raise KeyError(f"unknown job: {job_id}")
        q: asyncio.Queue[dict] = asyncio.Queue(maxsize=1000)
        self._streams.setdefault(job_id, []).append(q)
        # Replay snapshot initial pour que le client ait l'état courant
        job = self._jobs[job_id]
        await q.put({
            "event": "snapshot",
            "job": job.to_dict(),
        })
        return q

    def remove_stream(self, job_id: str, q: "asyncio.Queue[dict]") -> None:
        lst = self._streams.get(job_id)
        if lst and q in lst:
            lst.remove(q)

    # Events terminaux : leur perte casse l'état côté consumer AtlasMind (job reste
    # running indéfiniment → marqué stale au prochain restart). On les pousse en
    # bloquant pour garantir delivery même si le consumer est lent (H1 audit).
    _TERMINAL_EVENTS = ("done", "cancelled", "error")

    def _publish(self, job_id: str, event: dict[str, Any]) -> None:
        """Schedule la diffusion d'un event sur l'event loop, depuis n'importe
        quel thread.

        Les progress_cb des runners tournent dans `to_thread()` worker threads.
        `asyncio.Queue.put_nowait` et `asyncio.create_task` ne sont pas
        thread-safe (audit R3-M5). On hop systématiquement sur l'event loop via
        `call_soon_threadsafe` qui est lui safe.
        """
        event = dict(event)
        event.setdefault("ts", time.time())
        if self._loop is not None and self._loop.is_running():
            try:
                self._loop.call_soon_threadsafe(self._do_publish, job_id, event)
                return
            except RuntimeError:
                pass
        # Fallback : pas de loop dispo, exec inline (au shutdown notamment).
        self._do_publish(job_id, event)

    def _do_publish(self, job_id: str, event: dict[str, Any]) -> None:
        """Implémentation event-loop-safe de _publish."""
        is_terminal = event.get("event") in self._TERMINAL_EVENTS
        # snapshot la liste : remove_stream peut muter pendant l'iter
        consumers = list(self._streams.get(job_id, []))
        for q in consumers:
            if is_terminal:
                # Pour les events terminaux on schedule un put bloquant qui
                # survit même si la queue est temporairement pleine.
                asyncio.create_task(self._safe_put(q, event))
            else:
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    pass  # progress events : drop si client lent OK

    @staticmethod
    async def _safe_put(q: "asyncio.Queue[dict]", event: dict) -> None:
        try:
            await q.put(event)
        except Exception:
            log.exception("safe_put failed")

    def tail_log(self, job_id: str, lines: int = 200) -> list[str]:
        job = self._jobs.get(job_id)
        if not job or not job.log_path or not Path(job.log_path).exists():
            return []
        try:
            with open(job.log_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.readlines()
            return content[-lines:]
        except Exception:
            return []

    # ─── Worker ───

    async def _worker(self) -> None:
        while not self._stop_event.is_set():
            try:
                job_id = await asyncio.wait_for(self._queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            job = self._jobs.get(job_id)
            if not job or job.status == "cancelled":
                continue
            try:
                await self._run_job(job)
            except Exception as e:
                log.exception(f"job {job_id} failed")
                job.status = "failed"
                job.error_message = f"{e!s}\n{traceback.format_exc()}"
                job.finished_at = time.time()
                self._publish(job_id, {"event": "error", "message": str(e)})
            finally:
                self._save_state()

    async def _heartbeat_loop(self) -> None:
        """Émet un event heartbeat toutes les 20s pour les jobs en cours,
        pour éviter le timeout idle de Caddy sur les streams NDJSON."""
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=20.0)
            except asyncio.TimeoutError:
                pass
            for j in self._jobs.values():
                if j.status == "running":
                    self._publish(j.id, {"event": "heartbeat"})

    # ─── Job execution ───

    async def _run_job(self, job: Job) -> None:
        job.status = "running"
        job.started_at = time.time()
        log_path = self.log_dir / f"job-{job.id}-{job.type}.log"
        job.log_path = str(log_path)
        self._publish(job.id, {"event": "started", "type": job.type})
        log.info(f"running job {job.id} type={job.type}")

        with open(log_path, "w", encoding="utf-8") as logf:
            if job.type == "imatrix_build":
                await self._run_imatrix_build(job, logf)
            elif job.type == "quantize":
                await self._run_quantize(job, logf)
            elif job.type == "analyze_gguf":
                await self._run_analyze_gguf(job)
            elif job.type == "calibration_build":
                # Phase 7 placeholder
                raise RuntimeError("calibration_build not yet implemented")
            else:
                raise RuntimeError(f"unknown job type: {job.type}")

        if job.status != "cancelled":
            job.status = "done"
            job.progress_pct = 100.0
            job.finished_at = time.time()
            self._publish(job.id, {"event": "done", "outputs": [o.to_dict() for o in job.outputs]})

    async def _run_imatrix_build(self, job: Job, logf) -> None:
        p = job.payload
        source = Path(p["source_path"])
        calib = Path(p["calibration_path"])
        chunks = int(p.get("chunks", self.cfg.get("imatrix", {}).get("chunks", 200)))
        ctx = int(p.get("ctx", self.cfg.get("imatrix", {}).get("ctx", 4096)))
        batch = int(p.get("batch", self.cfg.get("imatrix", {}).get("batch", 512)))
        ngl = int(p.get("ngl", self.cfg.get("imatrix", {}).get("ngl", 999)))
        toolbox = p.get("toolbox", self.cfg.get("toolbox", "llama-vulkan-radv"))

        # Pré-flight : llama-imatrix exige tokens >= 2*ctx, sinon exit code 1
        # 5s après spawn avec "you need at least N tokens for a context of M".
        # On bloque tôt avec un message clair plutôt que de gaspiller le load
        # complet du modèle puis crash silencieux.
        err = lib_imatrix.check_calibration_size(calib, ctx)
        if err:
            raise RuntimeError(err)

        # Si le backend est un toolbox container (pas native), ses mounts ne
        # couvrent que $HOME — un calib dans /opt/brain-quant/calibration/ est
        # invisible. Le TUI legacy (brain-quant.py) wrappait avec
        # ensure_toolbox_accessible ; le port daemon avait oublié → llama-imatrix
        # crashait "failed to load f" (bug-hunt finding #3).
        if not lib_toolbox.is_native(toolbox):
            calib = lib_toolbox.ensure_accessible(
                calib, self.log_dir.parent / "toolbox-cache",
            )

        out_name = lib_imatrix.imatrix_name_for(source, calib)
        out_path = self.paths.imatrix_dir / out_name
        existing = lib_imatrix.find_existing_imatrix(self.paths.imatrix_dir, source, calib)
        if existing and not p.get("force_rebuild"):
            self._publish(job.id, {"event": "imatrix_skipped", "path": str(existing)})
            job.outputs.append(JobOutput(
                name=existing.name, path=str(existing),
                size_bytes=existing.stat().st_size,
                preset_name="(imatrix)", warnings=[],
            ))
            return

        cancel_ev = self._cancel_events.get(job.id)

        def progress_cb(p: lib_imatrix.ImatrixProgress) -> None:
            if p.chunk_total > 0:
                pct = (p.chunk_current / p.chunk_total) * 100
                job.progress_pct = pct
                job.progress_message = f"imatrix: chunk {p.chunk_current}/{p.chunk_total}"
                self._publish(job.id, {
                    "event": "imatrix_progress",
                    "chunk": p.chunk_current,
                    "total": p.chunk_total,
                    "elapsed": p.elapsed_sec,
                })

        def _pid_cb(pid: int, _job=job) -> None:
            _job.pid = pid
            self._save_state_threadsafe()

        result = await asyncio.to_thread(
            lib_imatrix.run_imatrix,
            toolbox, source, calib, out_path,
            chunks, ctx, batch, ngl,
            progress_cb=progress_cb,
            cancel_event=cancel_ev,
            log_stream=logf,
            pid_cb=_pid_cb,
        )
        job.pid = None  # subprocess terminé, plus à recover

        if result.cancelled:
            job.status = "cancelled"
            job.finished_at = time.time()
            self._publish(job.id, {"event": "cancelled"})
            return

        self._publish(job.id, {"event": "imatrix_done", "elapsed": result.elapsed_sec, "path": str(out_path)})
        if out_path.exists():
            job.outputs.append(JobOutput(
                name=out_path.name, path=str(out_path),
                size_bytes=out_path.stat().st_size,
                preset_name="(imatrix)", warnings=[],
            ))

    async def _run_quantize(self, job: Job, logf) -> None:
        p = job.payload
        source = Path(p["source_path"])
        presets_list = p.get("presets", [])
        if not presets_list:
            raise RuntimeError("no presets provided")
        toolbox = p.get("toolbox", self.cfg.get("toolbox", "llama-vulkan-radv"))

        # 1) Imatrix : 3 modes
        #    - imatrix_path fourni → réutilisé
        #    - calibration_path fourni → on build (ou réutilise cache si même hash)
        #    - ni l'un ni l'autre → quantize raw (sans --imatrix, K-quants restent valides)
        imatrix_path: Path | None = None
        skip_imatrix = bool(p.get("skip_imatrix"))
        if p.get("imatrix_path") and not skip_imatrix:
            imatrix_path = Path(p["imatrix_path"])
            if not imatrix_path.exists():
                raise RuntimeError(f"imatrix introuvable : {imatrix_path}")
        elif p.get("calibration_path") and not skip_imatrix:
            calib = Path(p["calibration_path"])
            existing = lib_imatrix.find_existing_imatrix(self.paths.imatrix_dir, source, calib)
            if existing:
                imatrix_path = existing
                self._publish(job.id, {"event": "imatrix_skipped", "path": str(existing)})
            else:
                # On construit l'imatrix dans le même job
                imatrix_path = self.paths.imatrix_dir / lib_imatrix.imatrix_name_for(source, calib)
                cfg_im = self.cfg.get("imatrix", {})
                # Même pré-flight que _run_imatrix_build : refuse net si calib < 2*ctx.
                err = lib_imatrix.check_calibration_size(
                    calib, int(cfg_im.get("ctx", 4096)),
                )
                if err:
                    raise RuntimeError(err)
                # Wrap calib pour toolbox containers (cf _run_imatrix_build, finding #3).
                if not lib_toolbox.is_native(toolbox):
                    calib = lib_toolbox.ensure_accessible(
                        calib, self.log_dir.parent / "toolbox-cache",
                    )
                cancel_ev = self._cancel_events.get(job.id)

                def progress_cb(pe: lib_imatrix.ImatrixProgress) -> None:
                    if pe.chunk_total > 0:
                        # imatrix occupe la première moitié de la barre (0-50%)
                        pct = (pe.chunk_current / pe.chunk_total) * 50.0
                        job.progress_pct = pct
                        job.progress_message = f"imatrix: chunk {pe.chunk_current}/{pe.chunk_total}"
                        self._publish(job.id, {
                            "event": "imatrix_progress",
                            "chunk": pe.chunk_current,
                            "total": pe.chunk_total,
                        })

                def _im_pid_cb(pid: int, _job=job) -> None:
                    _job.pid = pid
                    self._save_state_threadsafe()

                result = await asyncio.to_thread(
                    lib_imatrix.run_imatrix,
                    toolbox, source, calib, imatrix_path,
                    int(cfg_im.get("chunks", 200)),
                    int(cfg_im.get("ctx", 4096)),
                    int(cfg_im.get("batch", 512)),
                    int(cfg_im.get("ngl", 999)),
                    progress_cb=progress_cb,
                    cancel_event=cancel_ev,
                    log_stream=logf,
                    pid_cb=_im_pid_cb,
                )
                if result.cancelled:
                    job.status = "cancelled"
                    job.finished_at = time.time()
                    self._publish(job.id, {"event": "cancelled"})
                    return
                self._publish(job.id, {"event": "imatrix_done", "elapsed": result.elapsed_sec})
        else:
            # Quantize raw — pas d'imatrix. Les K-quants restent valides ;
            # l'utilisateur perd juste le bonus d'optimisation par importance.
            self._publish(job.id, {"event": "imatrix_skipped", "reason": "no calibration/imatrix provided (raw quant)"})
            job.progress_pct = 50.0
            job.progress_message = "imatrix skipped (raw quant)"

        # 2) Quantize : un par preset
        source_top_type = "Q8_0" if "q8" in source.name.lower() else "F16"
        models_entries = lib_scan.scan_source_models(self.paths.models_path)
        base_name = source.name
        for m in models_entries:
            if str(m.first_shard) == str(source):
                base_name = m.base_name
                source_top_type = m.top_type
                break

        n_presets = len(presets_list)
        for i, raw in enumerate(presets_list):
            preset = lib_presets.normalize_preset(raw, source_top_type)
            preset_name = preset["name"]
            out_path = self.paths.output_dir / f"{base_name}-brain-{preset_name}.gguf"
            out_path = lib_scan.next_versioned_gguf(out_path)
            self._publish(job.id, {
                "event": "quantize_started",
                "preset": preset_name,
                "i": i, "total": n_presets,
            })
            cancel_ev = self._cancel_events.get(job.id)

            def progress_cb(qp: lib_quantize.QuantizeProgress, _idx=i) -> None:
                # quantize : ~50-100% (split en n_presets sous-segments si plusieurs)
                base_pct = 50.0 + (_idx / n_presets) * 50.0
                step_pct = (qp.pct / 100.0) * (50.0 / n_presets)
                job.progress_pct = base_pct + step_pct
                job.progress_message = f"quantize {qp.preset_name}: {qp.pct:.0f}%"
                self._publish(job.id, {
                    "event": "quantize_progress",
                    "preset": qp.preset_name,
                    "pct": qp.pct,
                })

            def _q_pid_cb(pid: int, _job=job) -> None:
                _job.pid = pid
                self._save_state_threadsafe()

            result = await asyncio.to_thread(
                lib_quantize.run_quantize,
                toolbox, source, imatrix_path, out_path, preset,
                progress_cb=progress_cb,
                cancel_event=cancel_ev,
                log_stream=logf,
                pid_cb=_q_pid_cb,
            )
            job.pid = None  # subprocess terminé
            if result.cancelled:
                job.status = "cancelled"
                job.finished_at = time.time()
                self._publish(job.id, {"event": "cancelled"})
                return

            # Validate post-quant
            warnings: list[str] = []
            try:
                warnings = lib_quantize.validate_output_gguf(source, out_path)
            except Exception as e:
                warnings = [f"validate failed: {e!s}"]
            output = JobOutput(
                name=out_path.name, path=str(out_path),
                size_bytes=out_path.stat().st_size if out_path.exists() else 0,
                preset_name=preset_name, warnings=warnings,
            )
            job.outputs.append(output)
            self._publish(job.id, {
                "event": "quantize_done",
                "preset": preset_name,
                "output_path": str(out_path),
                "size_bytes": output.size_bytes,
                "warnings": warnings,
                "elapsed": result.elapsed_sec,
            })

    async def _run_analyze_gguf(self, job: Job) -> None:
        p = job.payload
        output_path = Path(p["output_path"])
        # Heuristique source : retire "-brain-<preset>" pour deviner la source .gguf
        import re
        guessed = Path(re.sub(r"-brain-[^/]+\.gguf$", ".gguf", str(output_path)))
        source_path = Path(p.get("source_path") or guessed)
        warnings = lib_quantize.validate_output_gguf(source_path, output_path)
        job.outputs.append(JobOutput(
            name=output_path.name, path=str(output_path),
            size_bytes=output_path.stat().st_size if output_path.exists() else 0,
            preset_name="(analyze)", warnings=warnings,
        ))
        self._publish(job.id, {"event": "validated", "warnings": warnings})


# ────────────────────────────────────────────────────────────────────────────
# Singleton accessor (utilisé par routes.py)
# ────────────────────────────────────────────────────────────────────────────

_instance: QuantManager | None = None


def get_manager() -> QuantManager | None:
    return _instance


def set_manager(m: QuantManager | None) -> None:
    global _instance
    _instance = m
