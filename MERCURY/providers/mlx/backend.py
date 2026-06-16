"""
Backend MLX : POST {base_url}/v1/chat/completions
Déjà OpenAI-compatible ; on proxifie le body et le stream tels quels.
"""
import json
import logging

import httpx

from providers.base import BackendBase, BackendResult, BackendRequestFailed
from utils.debug import debug_json

logger = logging.getLogger(__name__)


class MLXBackend(BackendBase):
    def __init__(self, base_url: str, timeout: float = 300.0):
        super().__init__(base_url, timeout)
        self.chat_url = f"{self.base_url}/v1/chat/completions"

    def _prepare_body(self, body: dict) -> dict:
        """MLX accepte le format OpenAI ; on peut retirer le préfixe mlx/ du modèle."""
        model = body.get("model", "")
        if model.startswith("mlx/"):
            body = {**body, "model": model[4:]}
        return body

    async def chat(self, body: dict, stream: bool):
        from routing.router import get_config
        body = self._prepare_body(body)
        if get_config().get("debug"):
            js = json.dumps(body, ensure_ascii=False)
            logger.info("DEBUG [mlx] envoyé: %s", (js[:4000] + "...") if len(js) > 4000 else js)

        if not stream:
            body_no_stream = {**body, "stream": False}
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(self.chat_url, json=body_no_stream)
                if resp.status_code >= 400:
                    # Upstream 4xx/5xx → lever pour permettre le fallback cloud
                    # (cf. contrat BackendRequestFailed, miroir de ollama/backend.py).
                    err = (resp.text or str(resp.status_code))[:500]
                    logger.warning("MLX /v1/chat/completions erreur %s: %s", resp.status_code, err)
                    if get_config().get("debug"):
                        try:
                            err_data = resp.json()
                        except Exception:
                            err_data = resp.text or ""
                        logger.info("DEBUG [mlx] reçu (non-stream, erreur): %s", debug_json(err_data if isinstance(err_data, dict) else {"_raw": str(err_data)[:2000]}))
                    raise BackendRequestFailed(resp.status_code, err)
                try:
                    data = resp.json()
                except Exception:
                    data = {"error": resp.text}
                if get_config().get("debug"):
                    logger.info("DEBUG [mlx] reçu (non-stream): %s", debug_json(data))
                return BackendResult(resp.status_code, data)

        # Stream: proxifier le flux SSE
        async def stream_generator():
            sse_acc = "" if get_config().get("debug") else None
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    async with client.stream("POST", self.chat_url, json=body) as resp:
                        if resp.status_code >= 400:
                            # Upstream 4xx/5xx → lever pour permettre le fallback cloud
                            # (cf. contrat BackendRequestFailed, miroir de ollama/backend.py).
                            # La route (routes_chat_completions) récupère l'exception du
                            # response_future et émet un event d'erreur SSE structuré + [DONE].
                            err_body = (await resp.aread()).decode("utf-8", errors="replace")
                            err = err_body[:500]
                            logger.warning("MLX /v1/chat/completions erreur %s (stream): %s", resp.status_code, err)
                            if get_config().get("debug"):
                                try:
                                    err_data = json.loads(err_body)
                                except json.JSONDecodeError:
                                    err_data = {"_raw": err_body[:2000]}
                                logger.info("DEBUG [mlx] reçu (stream, erreur): %s", debug_json(err_data))
                            raise BackendRequestFailed(resp.status_code, err)
                        async for chunk in resp.aiter_text():
                            if sse_acc is not None:
                                sse_acc += chunk
                            yield chunk
            finally:
                if sse_acc is not None:
                    logger.info(
                        "DEBUG [mlx] reçu (stream, %d chars): %s",
                        len(sse_acc),
                        debug_json({"_sse": sse_acc}),
                    )

        return stream_generator()
