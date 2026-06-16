"""DownloadJob + JobManager : queue FIFO single-worker pour les downloads HF."""
from __future__ import annotations

import asyncio
import logging
import multiprocessing
import time
import uuid
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

from . import hf_client
from .progress import DownloadCancelled

logger = logging.getLogger("brain-daemon")

_PROGRESS_POLL_INTERVAL = 1.0
_CANCEL_CHECK_INTERVAL = 0.3   # freq de verification du flag cancel dans le worker
_JOIN_TIMEOUT = 5.0            # timeout d'arret gracieux avant SIGKILL


@dataclass
class DownloadJob:
    id: str
    repo_id: str
    filename: str
    revision: Optional[str]
    state: str                       # queued | running | done | error | cancelled
    bytes_done: int = 0
    bytes_total: int = 0
    speed_bps: float = 0.0
    error: Optional[str] = None
    local_path: Optional[str] = None
    cancel_requested: bool = False
    queued_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None

    def to_public_dict(self) -> dict:
        d = asdict(self)
        d["pct"] = (self.bytes_done / self.bytes_total * 100.0) if self.bytes_total else 0.0
        return d


class JobManager:
    def __init__(self, models_path: Path, history_keep: int = 50, rescan_hook=None):
        self.models_path = models_path
        self.history_keep = history_keep
        self.rescan_hook = rescan_hook  # callable() appele apres chaque job done
        self._jobs: OrderedDict[str, DownloadJob] = OrderedDict()
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker_task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._worker_task and not self._worker_task.done():
            return
        self._worker_task = asyncio.create_task(self._worker())
        logger.info("downloader: worker started")

    async def stop(self) -> None:
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass
            self._worker_task = None

    def list_jobs(self) -> list[DownloadJob]:
        return list(self._jobs.values())

    def get_job(self, job_id: str) -> Optional[DownloadJob]:
        return self._jobs.get(job_id)

    def enqueue(
        self,
        repo_id: str,
        filename: str,
        revision: Optional[str] = None,
        expected_size: int = 0,
    ) -> DownloadJob:
        jid = uuid.uuid4().hex[:12]
        job = DownloadJob(id=jid, repo_id=repo_id, filename=filename, revision=revision, state="queued")
        if expected_size > 0:
            job.bytes_total = expected_size
        self._jobs[jid] = job
        self._prune_history()
        self._queue.put_nowait(jid)
        logger.info("downloader: queued job=%s repo=%s file=%s size=%s",
                    jid, repo_id, filename, expected_size or "?")
        return job

    def cancel(self, job_id: str) -> Optional[DownloadJob]:
        job = self._jobs.get(job_id)
        if not job:
            return None
        if job.state == "queued":
            job.state = "cancelled"
            job.cancel_requested = True
            job.finished_at = time.time()
            logger.info("downloader: cancelled queued job=%s", job_id)
        elif job.state == "running":
            job.cancel_requested = True
            logger.info("downloader: cancel requested for running job=%s", job_id)
        return job

    def _prune_history(self) -> None:
        # Retire les jobs terminaux les plus vieux au-dela de history_keep.
        terminal = [jid for jid, j in self._jobs.items() if j.state in ("done", "error", "cancelled")]
        while len(terminal) > self.history_keep:
            oldest = terminal.pop(0)
            self._jobs.pop(oldest, None)

    async def _worker(self) -> None:
        while True:
            try:
                jid = await self._queue.get()
            except asyncio.CancelledError:
                return
            job = self._jobs.get(jid)
            if not job:
                continue
            if job.state == "cancelled":
                continue  # deja annule en etat queued
            await self._run_job(job)

    async def _poll_progress(self, job: DownloadJob, target_dir: Path, final_name: str) -> None:
        """Poll la taille du fichier sur disque.

        huggingface_hub >=0.23 avec local_dir ecrit dans
        <target_dir>/.cache/huggingface/download/<base64_url>.<sha256>.incomplete
        puis rename vers <target_dir>/<final_name> a la fin.
        On check les deux emplacements — le cache (DL en cours) et le final.
        """
        cache_dir = target_dir / ".cache" / "huggingface" / "download"
        final_path = target_dir / final_name
        last_n = 0
        last_ts = time.time()
        while job.state == "running":
            await asyncio.sleep(_PROGRESS_POLL_INTERVAL)
            size = 0
            try:
                if final_path.exists():
                    size = final_path.stat().st_size
                elif cache_dir.exists():
                    # Prendre le plus gros .incomplete du cache (notre DL en cours)
                    biggest = 0
                    for p in cache_dir.glob("*.incomplete"):
                        try:
                            s = p.stat().st_size
                            if s > biggest:
                                biggest = s
                        except OSError:
                            continue
                    size = biggest
            except OSError:
                continue
            if size <= 0:
                continue
            now = time.time()
            dt = now - last_ts
            if dt > 0:
                job.speed_bps = max(0.0, (size - last_n) / dt)
            job.bytes_done = size
            last_n = size
            last_ts = now

    async def _run_job(self, job: DownloadJob) -> None:
        """Execute le DL dans un sous-process pour permettre un cancel instantane."""
        job.state = "running"
        job.started_at = time.time()
        logger.info("downloader: starting job=%s repo=%s file=%s",
                    job.id, job.repo_id, job.filename)
        target_dir = self.models_path / job.repo_id
        target_dir.mkdir(parents=True, exist_ok=True)
        poll_task = asyncio.create_task(
            self._poll_progress(job, target_dir, job.filename)
        )

        # On utilise le context 'spawn' : process propre, pas de fork qui duplique
        # le file descriptor / heap du daemon. Fiable meme sous uvicorn/uvloop.
        mp_ctx = multiprocessing.get_context("spawn")
        result_queue: multiprocessing.Queue = mp_ctx.Queue()
        proc = mp_ctx.Process(
            target=hf_client._download_subprocess_target,
            args=(
                job.repo_id,
                job.filename,
                str(target_dir),
                job.revision,
                hf_client.read_token(),
                result_queue,
            ),
            daemon=True,
        )
        proc.start()
        logger.info("downloader: job=%s subprocess pid=%s", job.id, proc.pid)

        try:
            # Boucle d'attente : check cancel + exit du subprocess
            while True:
                if job.cancel_requested:
                    logger.info("downloader: job=%s cancel requested, terminating subprocess pid=%s",
                                job.id, proc.pid)
                    proc.terminate()
                    await asyncio.to_thread(proc.join, _JOIN_TIMEOUT)
                    if proc.is_alive():
                        logger.warning("downloader: job=%s subprocess still alive after SIGTERM, SIGKILL",
                                       job.id)
                        proc.kill()
                        await asyncio.to_thread(proc.join, 2.0)
                    job.state = "cancelled"
                    logger.info("downloader: job=%s cancelled", job.id)
                    return
                if not proc.is_alive():
                    break
                await asyncio.sleep(_CANCEL_CHECK_INTERVAL)

            # Subprocess a termine — recuperer le resultat
            try:
                status, payload = result_queue.get(timeout=5.0)
            except Exception:
                job.state = "error"
                job.error = "Subprocess exited without reporting a result"
                logger.error("downloader: job=%s subprocess exited without result", job.id)
                return

            if status == "ok":
                job.local_path = payload
                try:
                    final_size = Path(payload).stat().st_size
                    job.bytes_done = final_size
                    if final_size > job.bytes_total:
                        job.bytes_total = final_size
                except OSError:
                    pass
                job.state = "done"
                logger.info("downloader: job=%s done path=%s", job.id, payload)
                if callable(self.rescan_hook):
                    try:
                        self.rescan_hook()
                    except Exception as e:
                        logger.warning("downloader: rescan hook failed: %s", e)
            else:
                # Error-handling : reconnaitre les exceptions connues par nom dans payload
                job.state = "error"
                if "GatedRepoError" in payload:
                    job.error = f"Gated repo: accept the license on HuggingFace first — {payload}"
                elif "RepositoryNotFoundError" in payload:
                    job.error = f"Repository not found — {payload}"
                else:
                    job.error = payload
                logger.warning("downloader: job=%s error: %s", job.id, payload)
        finally:
            # Cleanup : kill subprocess au cas ou, stop le poller
            if proc.is_alive():
                proc.kill()
                try:
                    await asyncio.to_thread(proc.join, 2.0)
                except Exception:
                    pass
            poll_task.cancel()
            try:
                await poll_task
            except (asyncio.CancelledError, Exception):
                pass
            job.finished_at = time.time()
            self._prune_history()
