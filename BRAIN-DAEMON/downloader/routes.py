"""Routes /downloader/* — telechargement et gestion des modeles GGUF depuis HuggingFace."""
from __future__ import annotations

import logging
import shutil
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from . import hf_client
from .jobs import JobManager

logger = logging.getLogger("brain-daemon")
router = APIRouter()

_manager: Any = None           # ModelManager du daemon (pour scan_models + _find_gguf_path)
_jobs: Optional[JobManager] = None
_models_path: Optional[Path] = None


def init_downloader(config: dict, manager: Any) -> None:
    """A appeler dans @app.on_event('startup')."""
    global _manager, _jobs, _models_path
    _manager = manager
    _models_path = Path(config["models_path"]).expanduser()
    dconf = config.get("downloader") or {}
    history_keep = int(dconf.get("history_keep", 50))

    # Token HF : le daemon tourne en root mais le token doit vivre dans le home
    # de run_as_user pour etre coherent avec huggingface-cli cote user.
    hf_client.configure_token_path(config.get("run_as_user", ""))

    def _rescan() -> None:
        # scan_models est stateless (walks le FS) — l'appeler sert surtout au log
        try:
            models = manager.scan_models()
            logger.info("downloader: rescan -> %d models on disk", len(models))
        except Exception as e:
            logger.warning("downloader: rescan failed: %s", e)

    _jobs = JobManager(_models_path, history_keep=history_keep, rescan_hook=_rescan)
    _jobs.start()


def _require_jobs() -> JobManager:
    if _jobs is None:
        raise HTTPException(status_code=503, detail="downloader not initialized")
    return _jobs


def _require_models_path() -> Path:
    if _models_path is None:
        raise HTTPException(status_code=503, detail="downloader not initialized")
    return _models_path


# ── Search / browse ───────────────────────────────────────────────────────────

@router.get("/search")
async def search(
    q: str = "",
    limit: int = 50,
    gguf_only: bool = True,
    author: str = "",
    sort: str = "downloads",
):
    # Au moins un critere (query ou author) requis, sinon on refuse (evite de lister tout HF)
    if not (q and q.strip()) and not (author and author.strip()):
        return JSONResponse(content=[])
    try:
        results = hf_client.search_models(
            query=q.strip() if q else "",
            limit=min(max(limit, 1), 100),
            gguf_only=gguf_only,
            author=author.strip() if author else None,
            sort=sort,
        )
        return JSONResponse(content=[asdict(r) for r in results])
    except Exception as e:
        logger.warning("downloader: search failed: %s", e)
        raise HTTPException(status_code=502, detail=f"HF search failed: {e}")


@router.get("/repo/{repo_id:path}/files")
async def repo_files(repo_id: str):
    try:
        files = hf_client.list_repo_gguf_files(repo_id)
        return JSONResponse(content={
            "repo_id": repo_id,
            "files": [asdict(f) for f in files],
        })
    except hf_client.GatedRepoError as e:
        raise HTTPException(status_code=403, detail=f"Gated repo: accept the license on HuggingFace first ({e})")
    except hf_client.RepositoryNotFoundError as e:
        raise HTTPException(status_code=404, detail=f"Repo not found: {e}")
    except Exception as e:
        logger.warning("downloader: list files failed repo=%s: %s", repo_id, e)
        raise HTTPException(status_code=502, detail=str(e))


# ── Jobs ──────────────────────────────────────────────────────────────────────

@router.post("/download")
async def start_download(body: dict):
    repo_id = body.get("repo_id")
    filename = body.get("filename")
    revision = body.get("revision") or None
    if not repo_id or not filename:
        raise HTTPException(status_code=400, detail="repo_id and filename required")

    # Disk check + size recovery pour initialiser bytes_total dans le job
    expected_size = 0
    try:
        files = hf_client.list_repo_gguf_files(repo_id)
        match = next((f for f in files if f.path == filename), None)
        if match and match.size > 0:
            expected_size = match.size
            mp = _require_models_path()
            du = shutil.disk_usage(mp)
            if match.size * 1.1 > du.free:
                raise HTTPException(
                    status_code=507,
                    detail=f"Insufficient disk space: need {match.size*1.1/1e9:.1f} GB, have {du.free/1e9:.1f} GB free",
                )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("downloader: pre-flight check failed (non-fatal): %s", e)

    jobs = _require_jobs()
    job = jobs.enqueue(
        repo_id=repo_id,
        filename=filename,
        revision=revision,
        expected_size=expected_size,
    )
    return JSONResponse(content={"job_id": job.id, "status": job.state})


@router.get("/jobs")
async def list_jobs():
    jobs = _require_jobs()
    return JSONResponse(content=[j.to_public_dict() for j in jobs.list_jobs()])


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    jobs = _require_jobs()
    j = jobs.get_job(job_id)
    if not j:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
    return JSONResponse(content=j.to_public_dict())


@router.delete("/jobs/{job_id}")
async def cancel_job(job_id: str):
    jobs = _require_jobs()
    j = jobs.cancel(job_id)
    if not j:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
    return JSONResponse(content=j.to_public_dict())


# ── Token ─────────────────────────────────────────────────────────────────────

@router.get("/token")
async def get_token():
    tok = hf_client.read_token()
    return JSONResponse(content={"configured": bool(tok), "masked": hf_client.mask_token(tok)})


@router.put("/token")
async def put_token(body: dict):
    token = body.get("token") if isinstance(body, dict) else None
    if token is not None and not isinstance(token, str):
        raise HTTPException(status_code=400, detail="token must be a string or null")
    configured = hf_client.write_token(token)
    logger.info("downloader: HF token %s", "configured" if configured else "cleared")
    return JSONResponse(content={"configured": configured})


# ── Disk / local models ───────────────────────────────────────────────────────

@router.get("/disk")
async def disk_usage():
    mp = _require_models_path()
    du = shutil.disk_usage(mp)
    # used_gb = espace utilise PAR models_path (sum sizes) — plus utile que du.used (disque entier)
    models_used = 0
    try:
        for p in mp.rglob("*"):
            try:
                if p.is_file():
                    models_used += p.stat().st_size
            except OSError:
                continue
    except Exception:
        pass
    return JSONResponse(content={
        "models_path": str(mp),
        "models_used_gb": round(models_used / 1e9, 2),
        "disk_used_gb": round(du.used / 1e9, 2),
        "free_gb": round(du.free / 1e9, 2),
        "total_gb": round(du.total / 1e9, 2),
    })


@router.delete("/models/{model_id:path}")
async def delete_local_model(model_id: str):
    if _manager is None:
        raise HTTPException(status_code=503, detail="manager not ready")
    mp = _require_models_path()

    # Refuse si running
    inst = _manager.instances.get(model_id)
    if inst and inst.is_running:
        raise HTTPException(status_code=409, detail=f"Model is running, unload it first: {model_id}")

    gguf_path_str = _manager._find_gguf_path(model_id)
    if not gguf_path_str:
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")

    gguf_path = Path(gguf_path_str).resolve()
    mp_resolved = mp.resolve()
    try:
        gguf_path.relative_to(mp_resolved)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path escapes models_path; refusing to delete.")

    deleted: list[str] = []
    import re
    shard_match = re.search(r"-00001-of-(\d{5})\.gguf$", gguf_path.name, re.IGNORECASE)
    if shard_match:
        total = int(shard_match.group(1))
        base = re.sub(r"-00001-of-\d{5}\.gguf$", "", str(gguf_path))
        for i in range(1, total + 1):
            p = Path(f"{base}-{i:05d}-of-{total:05d}.gguf")
            if p.exists():
                try:
                    p.unlink()
                    deleted.append(str(p))
                except OSError as e:
                    logger.warning("downloader: cannot delete %s: %s", p, e)
    else:
        try:
            gguf_path.unlink()
            deleted.append(str(gguf_path))
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Delete failed: {e}")

    # mmproj compagnon potentiel dans le meme dossier
    parent = gguf_path.parent
    for companion in parent.glob("*mmproj*.gguf"):
        try:
            companion.unlink()
            deleted.append(str(companion))
        except OSError:
            pass

    logger.info("downloader: deleted model=%s files=%d", model_id, len(deleted))
    return JSONResponse(content={"deleted": deleted, "model_id": model_id})
