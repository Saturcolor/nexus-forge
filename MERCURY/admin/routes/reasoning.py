"""Route admin : raisonnement étendu via OpenRouter ou Anthropic OAuth."""
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
ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"


class ReasoningAskRequest(BaseModel):
    prompt: str
    """Question précise envoyée au modèle de raisonnement."""
    model: str | None = None
    """Override du modèle. Si absent, utilise openrouter_reasoning_model ou anthropic_reasoning_model dans la config."""
    provider: str | None = None
    """Override du provider ('openrouter' | 'anthropic'). Auto-détecté si absent."""


def _is_anthropic_model(model_id: str) -> bool:
    """Heuristique : un id qui commence par 'claude-' est un modèle Anthropic."""
    return (model_id or "").lower().startswith("claude-")


@router.post("/reasoning/ask")
async def reasoning_ask(body: ReasoningAskRequest):
    """
    Envoie une question à un modèle de raisonnement lourd via OpenRouter ou Anthropic OAuth.
    Utilisé par Mastermind via l'outil extended_reasoning pour les raisonnements complexes.
    Provider auto-détecté depuis le modèle (claude-* → Anthropic, sinon OpenRouter).
    """
    config = get_config()

    # Résoudre le modèle : override > anthropic_reasoning_model > openrouter_reasoning_model
    provider_override = (body.provider or "").strip().lower()
    model_override = (body.model or "").strip()

    anthropic_reasoning = (config.get("anthropic_reasoning_model") or "").strip()
    openrouter_reasoning = (config.get("openrouter_reasoning_model") or "").strip()

    # Choix du modèle et du provider
    if model_override:
        reasoning_model = model_override
        if provider_override:
            provider = provider_override
        else:
            provider = "anthropic" if _is_anthropic_model(reasoning_model) else "openrouter"
    elif anthropic_reasoning and config.get("anthropic_enabled"):
        # Si un modèle Anthropic est configuré et le provider est actif, l'utiliser en priorité
        # sauf si openrouter_reasoning_model est configuré ET anthropic n'est pas first dans fallback_providers_order
        order = config.get("fallback_providers_order") or ["openrouter", "anthropic"]
        if openrouter_reasoning and order and order[0] == "openrouter":
            reasoning_model = openrouter_reasoning
            provider = "openrouter"
        else:
            reasoning_model = anthropic_reasoning
            provider = "anthropic"
    elif openrouter_reasoning:
        reasoning_model = openrouter_reasoning
        provider = "openrouter"
    else:
        return JSONResponse(
            status_code=400,
            content={"detail": "Aucun modèle de raisonnement configuré (openrouter_reasoning_model ou anthropic_reasoning_model dans la config Mercury)."},
        )

    if not reasoning_model:
        return JSONResponse(
            status_code=400,
            content={"detail": "Modèle de raisonnement vide."},
        )

    # ── Provider OpenRouter ──────────────────────────────────────────────
    if provider == "openrouter":
        api_key = (config.get("openrouter_api_key") or "").strip()
        if not api_key:
            return JSONResponse(
                status_code=400,
                content={"detail": "Clé API OpenRouter manquante (openrouter_api_key)."},
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
            "model": reasoning_model,
            "messages": [{"role": "user", "content": body.prompt}],
            "stream": False,
        }
        request_id = str(uuid.uuid4())[:8]
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(OPENROUTER_CHAT_URL, json=payload, headers=headers)
            duration_ms = (time.perf_counter() - t0) * 1000
            if resp.status_code != 200:
                text = (resp.text or "")[:500]
                logger.warning("OpenRouter reasoning/ask: %s %s", resp.status_code, text)
                log_api_request(request_id, "admin", reasoning_model, "openrouter", "error", duration_ms, error_detail=f"reasoning: {resp.status_code}")
                return JSONResponse(
                    status_code=resp.status_code,
                    content={"detail": f"OpenRouter API error {resp.status_code}: {text}"},
                )
            data = resp.json()
            usage = data.get("usage")
            answer = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            log_api_request(request_id, "admin", reasoning_model, "openrouter", "ok", duration_ms, usage=usage)
            if not answer:
                return JSONResponse(status_code=500, content={"detail": "Réponse vide du modèle de raisonnement."})
            logger.info("Reasoning ask (openrouter): model=%s chars=%d %.0fms", reasoning_model, len(answer), duration_ms)
            return JSONResponse(content={"answer": answer, "model": reasoning_model, "provider": "openrouter"})
        except Exception as e:
            duration_ms = (time.perf_counter() - t0) * 1000
            log_api_request(request_id, "admin", reasoning_model, "openrouter", "error", duration_ms, error_detail=str(e)[:500])
            logger.exception("Reasoning ask (openrouter) error: %s", e)
            return JSONResponse(status_code=500, content={"detail": str(e)})

    # ── Provider Anthropic OAuth ─────────────────────────────────────────
    if provider == "anthropic":
        if not config.get("anthropic_enabled"):
            return JSONResponse(
                status_code=400,
                content={"detail": "Anthropic est désactivé (anthropic_enabled: false)."},
            )
        try:
            from providers.anthropic.backend import OAuthTokenManager
            cred_file = (config.get("anthropic_credentials_file") or "").strip() or None
            token_mgr = OAuthTokenManager(cred_file)
            token = await token_mgr.get_token_async()
        except Exception as e:
            return JSONResponse(
                status_code=400,
                content={"detail": f"Erreur credentials Anthropic OAuth : {e}"},
            )

        from providers.anthropic.backend import _detect_claude_code_version, _CLAUDE_CODE_SYSTEM_PREFIX
        cc_version = _detect_claude_code_version()
        all_betas = [
            "claude-code-20250219",
            "oauth-2025-04-20",
        ]
        headers_a: dict[str, str] = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-beta": ",".join(all_betas),
            "user-agent": f"claude-cli/{cc_version} (external, cli)",
            "x-app": "cli",
        }
        payload_a = {
            "model": reasoning_model,
            "max_tokens": 4096,
            "system": [{"type": "text", "text": _CLAUDE_CODE_SYSTEM_PREFIX}],
            "messages": [{"role": "user", "content": body.prompt}],
        }
        request_id = str(uuid.uuid4())[:8]
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(ANTHROPIC_MESSAGES_URL, json=payload_a, headers=headers_a)
            duration_ms = (time.perf_counter() - t0) * 1000
            if resp.status_code != 200:
                text = (resp.text or "")[:500]
                logger.warning("Anthropic reasoning/ask: %s %s", resp.status_code, text)
                log_api_request(request_id, "admin", reasoning_model, "anthropic", "error", duration_ms, error_detail=f"reasoning: {resp.status_code}")
                return JSONResponse(
                    status_code=resp.status_code,
                    content={"detail": f"Anthropic API error {resp.status_code}: {text}"},
                )
            data = resp.json()
            usage = data.get("usage")
            answer = ""
            for block in data.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "text":
                    answer += block.get("text", "")
            log_api_request(request_id, "admin", reasoning_model, "anthropic", "ok", duration_ms, usage=usage)
            if not answer:
                return JSONResponse(status_code=500, content={"detail": "Réponse vide du modèle de raisonnement."})
            logger.info("Reasoning ask (anthropic): model=%s chars=%d %.0fms", reasoning_model, len(answer), duration_ms)
            return JSONResponse(content={"answer": answer, "model": reasoning_model, "provider": "anthropic"})
        except Exception as e:
            duration_ms = (time.perf_counter() - t0) * 1000
            log_api_request(request_id, "admin", reasoning_model, "anthropic", "error", duration_ms, error_detail=str(e)[:500])
            logger.exception("Reasoning ask (anthropic) error: %s", e)
            return JSONResponse(status_code=500, content={"detail": str(e)})

    return JSONResponse(status_code=400, content={"detail": f"Provider inconnu : {provider}"})
