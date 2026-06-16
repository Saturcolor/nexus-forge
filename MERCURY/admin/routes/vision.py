"""Route admin : description d'image via un modèle vision OpenRouter."""
import logging
import time
import uuid

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from routing.router import get_config
from app_queue.request_queue import log_api_request

logger = logging.getLogger(__name__)
router = APIRouter()

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"


class VisionDescribeRequest(BaseModel):
    image_url: str
    """data:image/...;base64,... ou URL publique."""
    prompt: str = "Décris cette image en détail et précisément."
    """Prompt envoyé avec l'image. Le caller peut le surcharger."""
    model: str | None = None
    """Override du modèle. Si absent, utilise openrouter_vision_model dans la config."""


@router.post("/vision/describe")
async def vision_describe(body: VisionDescribeRequest):
    """
    Décrit une image en utilisant un modèle vision OpenRouter.
    Utilisé par Mastermind comme fallback pour les modèles texte-only.
    """
    config = get_config()

    api_key = (config.get("openrouter_api_key") or "").strip()
    if not api_key:
        return JSONResponse(
            status_code=400,
            content={"detail": "Clé API OpenRouter manquante (openrouter_api_key)."},
        )

    vision_model = (body.model or config.get("openrouter_vision_model") or "").strip()
    if not vision_model:
        return JSONResponse(
            status_code=400,
            content={"detail": "Aucun modèle vision configuré (openrouter_vision_model dans la config Mercury)."},
        )

    headers: dict[str, str] = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if config.get("openrouter_http_referer"):
        headers["HTTP-Referer"] = config["openrouter_http_referer"]
    if config.get("openrouter_title"):
        headers["X-Title"] = config["openrouter_title"]

    payload = {
        "model": vision_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": body.prompt},
                    {"type": "image_url", "image_url": {"url": body.image_url}},
                ],
            }
        ],
        "max_tokens": 1024,
        "stream": False,
    }

    request_id = str(uuid.uuid4())[:8]
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(OPENROUTER_CHAT_URL, json=payload, headers=headers)

        duration_ms = (time.perf_counter() - t0) * 1000
        if resp.status_code != 200:
            text = (resp.text or "")[:500]
            logger.warning("OpenRouter vision/describe: %s %s", resp.status_code, text)
            log_api_request(request_id, "admin", vision_model, "openrouter", "error", duration_ms, error_detail=f"vision: {resp.status_code}")
            return JSONResponse(
                status_code=resp.status_code,
                content={"detail": f"OpenRouter API error {resp.status_code}: {text}"},
            )

        data = resp.json()
        usage = data.get("usage")
        description = (
            data.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        log_api_request(request_id, "admin", vision_model, "openrouter", "ok", duration_ms, usage=usage)
        if not description:
            return JSONResponse(
                status_code=500,
                content={"detail": "Réponse vide du modèle vision."},
            )

        logger.info("Vision describe: model=%s chars=%d %.0fms", vision_model, len(description), duration_ms)
        return JSONResponse(content={"description": description, "model": vision_model})

    except Exception as e:
        duration_ms = (time.perf_counter() - t0) * 1000
        log_api_request(request_id, "admin", vision_model, "openrouter", "error", duration_ms, error_detail=str(e)[:500])
        logger.exception("Vision describe error: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e)})
