"""Routes session / session-stream / slots + helpers."""
import asyncio
import json
import logging
import time
from typing import Any

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from ._common import llamacpp_base

logger = logging.getLogger(__name__)
router = APIRouter()


def _extract_prompt_pct(status_response: Any, model_id: str) -> int:
    """Extract prompt_pct for model_id from a /mgmt/status response (or exception)."""
    if isinstance(status_response, Exception) or status_response.status_code != 200:
        return 0
    for inst in status_response.json():
        if inst.get("model_id") == model_id:
            return int(inst.get("prompt_pct") or 0)
    return 0


def _session_payload(model_id: str, slots: Any, status_code: int | None, slot_error: str | None, prompt_pct: int = 0) -> dict:
    from providers.llamacpp.last_metrics import get_last_metrics

    metrics = get_last_metrics()
    by_model = metrics.get("by_model") or {}
    proxy = by_model.get(model_id)
    n_ctx_max = 0
    if isinstance(slots, list):
        for s in slots:
            if isinstance(s, dict) and s.get("n_ctx") is not None:
                try:
                    n_ctx_max = max(n_ctx_max, int(s["n_ctx"]))
                except (TypeError, ValueError):
                    pass
    return {
        "model_id": model_id,
        "ts": time.time(),
        "slots": slots,
        "proxy_metrics": proxy,
        "n_ctx_max": n_ctx_max or None,
        "slot_http_status": status_code,
        "slot_error": slot_error,
        "prompt_pct": prompt_pct,
    }


@router.get("/llamacpp/slots/{model_id:path}")
async def get_llamacpp_slots(model_id: str):
    """Proxy vers /mgmt/slots/{model_id} du daemon — état KV cache (tokens_cached, state idle/processing)."""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "llamacpp désactivé"})
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/mgmt/slots/{model_id}")
        if r.status_code == 404:
            return JSONResponse(status_code=404, content={"detail": f"Modèle non chargé: {model_id}"})
        if r.status_code != 200:
            return JSONResponse(status_code=r.status_code, content={"detail": r.text[:200]})
        return JSONResponse(content=r.json())
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"detail": "Daemon inaccessible."})
    except Exception as e:
        logger.warning("GET /admin/llamacpp/slots/%s: %s", model_id, e)
        return JSONResponse(status_code=500, content={"detail": str(e)})


@router.get("/llamacpp/session/{model_id:path}")
async def get_llamacpp_session(model_id: str):
    """Slots llama-server + métriques proxy pour ce model_id (snapshot).

    Pendant qu'un proxy chat est en cours pour ce model_id, on skip le hit
    `/mgmt/slots` : llama-server est connu pour ne pas répondre rapidement à
    l'admin pendant la génération (HTTP loop bloqué côté C++ sur certaines
    configs, ou timeout upstream proxy). On renvoie 200 avec les dernières
    métriques connues + flag `inferencing: true`.

    Hors inférence, comportement inchangé : si le daemon ne répond pas, on
    laisse remonter le vrai status (404, 500, 503) — c'est un signal légitime.
    """
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "llamacpp désactivé"})

    from providers.llamacpp.last_metrics import is_inferencing
    inferencing = is_inferencing(model_id)

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # vLLM n'a pas la notion `slots` de llama-server → skip le fetch
            # `/mgmt/slots/<id>` qui retournerait 404 et casserait le polling
            # frontend (502 récurrent toutes les 6s côté Mastermind).
            sr_check = await client.get(f"{base}/mgmt/status")
            _is_vllm = False
            try:
                _instances = sr_check.json() if sr_check.status_code == 200 else []
                _inst = next((i for i in _instances if i.get("model_id") == model_id), None)
                _is_vllm = bool(_inst and _inst.get("backend_type") == "vllm-toolbox")
            except Exception:
                pass

            if _is_vllm:
                prompt_pct = _extract_prompt_pct(sr_check, model_id)
                payload = _session_payload(model_id, slots=None, status_code=None,
                                           slot_error=None, prompt_pct=prompt_pct)
                if inferencing:
                    payload["inferencing"] = True
                return JSONResponse(content=payload)

            if inferencing:
                # Skip /mgmt/slots only — it's the one that blocks during inference.
                # Keep /mgmt/status to surface prompt_pct on the UI gauge.
                prompt_pct = _extract_prompt_pct(sr_check, model_id)
                payload = _session_payload(model_id, slots=None, status_code=None,
                                           slot_error=None, prompt_pct=prompt_pct)
                payload["inferencing"] = True
                return JSONResponse(content=payload)

            r, sr = await asyncio.gather(
                client.get(f"{base}/mgmt/slots/{model_id}"),
                # Re-fetch /mgmt/status pour rester en concurrence avec /slots
                # (la version sr_check ci-dessus est déjà consommée pour le check vLLM).
                client.get(f"{base}/mgmt/status"),
                return_exceptions=True,
            )
        if isinstance(r, Exception):
            raise r
        if r.status_code == 404:
            return JSONResponse(status_code=404, content={"detail": f"Modèle non chargé: {model_id}"})
        if r.status_code != 200:
            return JSONResponse(status_code=r.status_code, content={"detail": r.text[:200]})
        slots = r.json()
        prompt_pct = _extract_prompt_pct(sr, model_id)
    except httpx.ConnectError:
        return JSONResponse(status_code=503, content={"detail": "Daemon inaccessible."})
    except Exception as e:
        logger.warning("GET /admin/llamacpp/session/%s: %s", model_id, e)
        return JSONResponse(status_code=500, content={"detail": str(e)})
    payload = _session_payload(model_id, slots, r.status_code, None, prompt_pct)
    return JSONResponse(content=payload)


@router.get("/llamacpp/session-stream/{model_id:path}")
async def get_llamacpp_session_stream(model_id: str):
    """SSE : snapshot session (slots + proxy_metrics) ~1/s jusqu'à déconnexion client."""
    base = llamacpp_base()
    if not base:

        async def err_gen():
            yield 'data: {"error": "llamacpp désactivé"}\n\n'

        return StreamingResponse(err_gen(), media_type="text/event-stream")

    from providers.llamacpp.last_metrics import is_inferencing

    async def generate():
        async with httpx.AsyncClient(timeout=5.0) as client:
            while True:
                status_code: int | None = None
                slots: Any = None
                slot_error: str | None = None
                prompt_pct: int = 0
                inferencing = is_inferencing(model_id)

                # `/mgmt/slots/{model_id}` is the call that times out during chat inference
                # (llama-server HTTP loop blocked on the active generation). Skip it when
                # we know the model is busy. `/mgmt/status` is independent and stays cheap
                # — it gives us `prompt_pct` (prefill progress %) which we need to display
                # the prompt-processing indicator on the frontend during the early phase
                # of the inference, BEFORE the first generated token comes out.
                try:
                    if inferencing:
                        sr = await client.get(f"{base}/mgmt/status")
                    else:
                        slots_task = client.get(f"{base}/mgmt/slots/{model_id}")
                        status_task = client.get(f"{base}/mgmt/status")
                        r, sr = await asyncio.gather(slots_task, status_task, return_exceptions=True)
                        if isinstance(r, Exception):
                            slot_error = str(r)[:200]
                        else:
                            status_code = r.status_code
                            if r.status_code == 200:
                                slots = r.json()
                            else:
                                slot_error = (r.text or "")[:200]
                    prompt_pct = _extract_prompt_pct(sr, model_id)
                except Exception as e:
                    slot_error = str(e)[:200]
                payload = _session_payload(model_id, slots, status_code, slot_error, prompt_pct)
                if inferencing:
                    payload["inferencing"] = True
                yield f"data: {json.dumps(payload, default=str)}\n\n"
                await asyncio.sleep(1.0)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
