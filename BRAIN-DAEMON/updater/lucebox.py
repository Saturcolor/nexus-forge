"""Routes /updater/lucebox/* — Lucebox-specific updater (git pull + cmake build).

Lucebox doesn't fit the shared `build-native.sh` pipeline used by the other
`extra_native_backends` entries (different repo, cmake build with HIP-specific
flags figured out at install time). This module is a parallel updater that:

  - GET  /updater/lucebox/status  → local SHA, remote SHA, behind count, build state
  - POST /updater/lucebox/update  → git pull + submodule sync + cmake build
  - POST /updater/lucebox/build   → cmake build only (no git ops; for re-building after edits)
  - GET  /updater/lucebox/log     → live log tail (poll while in_progress)

Auto-reload of loaded `backend_type=lucebox` instances is intentionally NOT done
here — Mercury orchestrates unload+load before/after as part of its UX flow.
"""
import asyncio
import logging
import os
from collections import deque
from pathlib import Path

from fastapi import APIRouter, HTTPException

logger = logging.getLogger("brain-daemon")
router = APIRouter(prefix="/updater/lucebox", tags=["updater-lucebox"])

# Hardcoded layout — matches the install we did at /opt/lucebox.
# If we ever want multi-slot lucebox builds (PR branches, etc.), promote these
# to per-backend config.yaml fields like the other extra_native_backends do.
LUCEBOX_DIR = Path("/opt/lucebox")
DFLASH_DIR  = LUCEBOX_DIR / "dflash"
BUILD_DIR   = DFLASH_DIR / "build"
TEST_BIN    = BUILD_DIR / "test_dflash"
SUBMODULE   = "dflash/deps/llama.cpp"

# Cap the log so a runaway build doesn't blow memory over time.
_LOG_MAXLEN = 2000

_run_as_user: str = ""
_in_progress: bool = False
_phase: str = ""              # "git-pull" | "submodule" | "cmake" | ""
_log: deque = deque(maxlen=_LOG_MAXLEN)


def init_lucebox_updater(config: dict) -> None:
    global _run_as_user
    _run_as_user = config.get("run_as_user", "")
    logger.info("lucebox updater: ready (dir=%s, run_as=%s)", LUCEBOX_DIR, _run_as_user or "<self>")


def _user_cmd(cmd: list[str]) -> list[str]:
    if _run_as_user:
        return ["sudo", "-u", _run_as_user, "--"] + cmd
    return cmd


async def _run_capture(cmd: list[str], timeout: int = 30) -> tuple[int, str]:
    """One-shot run, no streaming. Returns (rc, combined_output)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return (proc.returncode or 0), out.decode(errors="replace")
    except asyncio.TimeoutError:
        return -1, "timeout"
    except Exception as e:
        return -1, str(e)


async def _run_streamed(cmd: list[str], cwd: Path | None = None, timeout: int = 1800) -> int:
    """Run with line-buffered streaming into the global _log deque + daemon logger.
    Used by /update + /build (cmake build can take ~3min, git pull seconds)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(cwd) if cwd else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        async def pump() -> None:
            assert proc.stdout is not None
            async for raw in proc.stdout:
                line = raw.decode(errors="replace").rstrip()
                if line:
                    _log.append(line)
                    logger.info("[lucebox-updater] %s", line)

        try:
            await asyncio.wait_for(pump(), timeout=timeout)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            _log.append(f"[ERROR] command timed out after {timeout}s")
            return -1
        await proc.wait()
        return proc.returncode or 0
    except Exception as e:
        _log.append(f"[ERROR] failed to run {cmd[0]}: {e}")
        return -1


async def _git_local_sha() -> str:
    rc, out = await _run_capture(_user_cmd(["git", "-C", str(LUCEBOX_DIR), "rev-parse", "--short", "HEAD"]))
    return out.strip() if rc == 0 else ""


async def _git_remote_sha() -> str:
    """Fetch from remote (no-op if up to date) then return upstream short SHA.
    `git fetch` is the only network op outside /update — kept here so /status
    can show 'behind by N commits' without forcing a full pull."""
    await _run_capture(_user_cmd(["git", "-C", str(LUCEBOX_DIR), "fetch", "--quiet"]), timeout=60)
    rc, out = await _run_capture(_user_cmd(["git", "-C", str(LUCEBOX_DIR), "rev-parse", "--short", "@{u}"]))
    return out.strip() if rc == 0 else ""


async def _git_behind_count(local: str, remote: str) -> int:
    if not local or not remote or local == remote:
        return 0
    rc, out = await _run_capture(_user_cmd(
        ["git", "-C", str(LUCEBOX_DIR), "rev-list", "--count", f"{local}..{remote}"]
    ))
    try:
        return int(out.strip()) if rc == 0 else 0
    except ValueError:
        return 0


@router.get("/status")
async def status() -> dict:
    local = await _git_local_sha()
    remote = await _git_remote_sha()
    behind = await _git_behind_count(local, remote)
    return {
        "local_sha":   local,
        "remote_sha":  remote,
        "behind":      behind,                  # 0 = up to date
        "build_exists": TEST_BIN.exists(),
        "in_progress": _in_progress,
        "phase":       _phase,
        "log_tail":    list(_log)[-50:],
    }


@router.post("/update")
async def update() -> dict:
    """git pull → submodule sync → cmake build. Mercury triggers this from the UI."""
    global _in_progress, _phase
    if _in_progress:
        raise HTTPException(status_code=409, detail="lucebox update already in progress")
    if not (DFLASH_DIR / "CMakeLists.txt").exists():
        raise HTTPException(status_code=500, detail=f"lucebox CMakeLists not found at {DFLASH_DIR}")
    if not BUILD_DIR.exists():
        raise HTTPException(
            status_code=500,
            detail=f"build dir missing: {BUILD_DIR} — run initial cmake configure first",
        )

    _in_progress = True
    _log.clear()
    try:
        _phase = "git-pull"
        rc = await _run_streamed(
            _user_cmd(["git", "-C", str(LUCEBOX_DIR), "pull", "--ff-only"]),
            timeout=120,
        )
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"git pull failed (rc={rc})")

        _phase = "submodule"
        rc = await _run_streamed(
            _user_cmd(["git", "-C", str(LUCEBOX_DIR), "submodule", "update",
                       "--init", SUBMODULE]),
            timeout=600,
        )
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"submodule update failed (rc={rc})")

        _phase = "cmake"
        rc = await _run_streamed(
            _user_cmd(["cmake", "--build", str(BUILD_DIR), "-j", str(os.cpu_count() or 4)]),
            timeout=1800,
        )
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"cmake build failed (rc={rc})")

        new_sha = await _git_local_sha()
        return {
            "ok":         True,
            "local_sha":  new_sha,
            "log_tail":   list(_log)[-30:],
        }
    finally:
        _in_progress = False
        _phase = ""


@router.post("/build")
async def build() -> dict:
    """cmake --build only, skip git ops. For rebuilding after a manual code edit
    (e.g. testing a CMakeLists tweak without bumping the SHA)."""
    global _in_progress, _phase
    if _in_progress:
        raise HTTPException(status_code=409, detail="lucebox update already in progress")
    if not BUILD_DIR.exists():
        raise HTTPException(status_code=500, detail=f"build dir missing: {BUILD_DIR}")

    _in_progress = True
    _log.clear()
    _phase = "cmake"
    try:
        rc = await _run_streamed(
            _user_cmd(["cmake", "--build", str(BUILD_DIR), "-j", str(os.cpu_count() or 4)]),
            timeout=1800,
        )
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"cmake build failed (rc={rc})")
        return {"ok": True, "log_tail": list(_log)[-30:]}
    finally:
        _in_progress = False
        _phase = ""


@router.get("/log")
async def get_log() -> dict:
    """Full log buffer (capped at _LOG_MAXLEN lines). Mercury polls this while
    in_progress=True to stream the build output live."""
    return {
        "log":         list(_log),
        "in_progress": _in_progress,
        "phase":       _phase,
    }
