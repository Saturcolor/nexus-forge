"""Routes downloader (HuggingFace model manager)."""
from typing import Optional

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ._common import llamacpp_base

router = APIRouter()


async def _downloader_proxy(
    method: str,
    path: str,
    *,
    params: Optional[dict] = None,
    json_body: Optional[dict] = None,
    timeout: float = 30.0,
) -> JSONResponse:
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"error": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.request(method, f"{base}{path}", params=params, json=json_body)
        try:
            content = r.json()
        except Exception:
            content = {"error": r.text[:500]}
        return JSONResponse(status_code=r.status_code, content=content)
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"error": "Brain daemon inaccessible."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/llamacpp/downloader/search")
async def downloader_search(
    q: str = "",
    limit: int = 50,
    gguf_only: bool = True,
    author: str = "",
    sort: str = "downloads",
):
    """Proxy vers GET /downloader/search du brain-daemon."""
    return await _downloader_proxy(
        "GET", "/downloader/search",
        params={
            "q": q,
            "limit": limit,
            "gguf_only": str(gguf_only).lower(),
            "author": author,
            "sort": sort,
        },
        timeout=30.0,
    )


@router.get("/llamacpp/downloader/repo/{repo_id:path}/files")
async def downloader_repo_files(repo_id: str):
    """Proxy vers GET /downloader/repo/{repo_id}/files du brain-daemon."""
    return await _downloader_proxy("GET", f"/downloader/repo/{repo_id}/files", timeout=30.0)


@router.post("/llamacpp/downloader/download")
async def downloader_start_download(body: dict):
    """Proxy vers POST /downloader/download du brain-daemon."""
    return await _downloader_proxy("POST", "/downloader/download", json_body=body, timeout=30.0)


@router.get("/llamacpp/downloader/jobs")
async def downloader_list_jobs():
    """Proxy vers GET /downloader/jobs du brain-daemon."""
    return await _downloader_proxy("GET", "/downloader/jobs", timeout=10.0)


@router.delete("/llamacpp/downloader/jobs/{job_id}")
async def downloader_cancel_job(job_id: str):
    """Proxy vers DELETE /downloader/jobs/{job_id} du brain-daemon."""
    return await _downloader_proxy("DELETE", f"/downloader/jobs/{job_id}", timeout=10.0)


@router.get("/llamacpp/downloader/token")
async def downloader_get_token():
    """Proxy vers GET /downloader/token du brain-daemon."""
    return await _downloader_proxy("GET", "/downloader/token", timeout=5.0)


@router.put("/llamacpp/downloader/token")
async def downloader_put_token(body: dict):
    """Proxy vers PUT /downloader/token du brain-daemon."""
    return await _downloader_proxy("PUT", "/downloader/token", json_body=body, timeout=5.0)


@router.get("/llamacpp/downloader/disk")
async def downloader_disk():
    """Proxy vers GET /downloader/disk du brain-daemon."""
    return await _downloader_proxy("GET", "/downloader/disk", timeout=30.0)


@router.delete("/llamacpp/downloader/models/{model_id:path}")
async def downloader_delete_local(model_id: str):
    """Proxy vers DELETE /downloader/models/{model_id} du brain-daemon."""
    return await _downloader_proxy("DELETE", f"/downloader/models/{model_id}", timeout=30.0)
