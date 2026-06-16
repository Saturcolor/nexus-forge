"""
Backend proxy LM Studio : forward body et réponse tels quels vers l'API OpenAI de LM Studio.
Pas de traduction (body OpenAI → POST {base_url}/chat/completions, réponse stream ou JSON inchangée).
Logging : le worker appelle _log après chat() ; on renvoie BackendResult avec body (usage si présent) pour que le worker puisse logger l'usage.
"""
import json
import logging
import time
from typing import Any, AsyncIterator

import httpx

from providers.base import BackendBase, BackendResult
from providers.lm_studio.load_cache import should_skip_load, mark_load_done, is_model_loaded_in_response
from utils.debug import debug_json
from providers.lm_studio.last_metrics import update_metrics

logger = logging.getLogger(__name__)


class LMStudioProxyBackend(BackendBase):
    """
    Proxy transparent vers LM Studio en mode API OpenAI (/v1/chat/completions).
    base_url doit inclure /v1 (ex. http://127.0.0.1:1234/v1).
    """

    def __init__(self, base_url: str, timeout: float = 300.0):
        super().__init__(base_url.rstrip("/"), timeout)
        self.chat_url = f"{self.base_url}/chat/completions"
        # API native LM Studio pour chargement automatique du modèle
        native_base = self.base_url[:-2].rstrip("/") if self.base_url.lower().endswith("/v1") else self.base_url
        self.load_url = f"{native_base}/api/v1/models/load"

    async def _ensure_model_loaded(self, client: httpx.AsyncClient, model_id: str) -> None:
        """Charge le modèle dans LM Studio si besoin (GET d'abord pour éviter 500 si déjà chargé)."""
        native_base = self.base_url[:-2].rstrip("/") if self.base_url.lower().endswith("/v1") else self.base_url
        need_load = True
        try:
            r = await client.get(f"{native_base}/api/v1/models", timeout=10.0)
            if r.status_code == 200:
                data = r.json()
                if is_model_loaded_in_response(data, model_id):
                    need_load = False
                    mark_load_done(native_base, model_id)
        except Exception as e:
            logger.debug("LM Studio proxy: vérification modèle chargé: %s", e)
        if need_load and not should_skip_load(native_base, model_id):
            try:
                r = await client.post(self.load_url, json={"model": model_id}, timeout=60.0)
                if r.status_code < 400:
                    # Cache UNIQUEMENT sur succès : sinon should_skip_load renvoie True
                    # pendant le TTL et verrouille le modèle en "non chargé" alors qu'un
                    # retry pourrait réussir (cache empoisonné, cf. fix ollama auto-pull).
                    mark_load_done(native_base, model_id)
                else:
                    logger.warning(
                        "LM Studio proxy: chargement modèle %s échoué (HTTP %s): %s — pas de cache (retry au prochain appel)",
                        model_id, r.status_code, (r.text or "")[:500],
                    )
            except Exception as e:
                # NE PAS mark_load_done sur erreur : laisse le prochain appel retenter.
                logger.warning(
                    "LM Studio proxy: échec chargement modèle %s: %s — pas de cache (retry au prochain appel)",
                    model_id, e,
                )

    async def chat(self, body: dict, stream: bool) -> Any:
        """
        Forward le body tel quel vers POST {base_url}/chat/completions.
        - stream=False : retourne BackendResult(status_code, body_dict).
        - stream=True : async generator qui yield les chunks SSE (str/bytes) tels quels.
        """
        if stream:
            return self._chat_stream(body)
        return await self._chat_sync(body)

    def _get_client(self) -> httpx.AsyncClient:
        from providers.http_client import get_client
        return get_client("lm_studio_proxy", timeout=self.timeout)

    def _parse_sse_events_for_usage(self, sse_buffer: str, stream_start: float | None = None) -> str:
        """Parse les événements SSE complets (data: ...\\n\\n), extrait usage, retourne le buffer restant."""
        duration_seconds = (time.monotonic() - stream_start) if stream_start is not None and stream_start > 0 else None
        while "\n\n" in sse_buffer:
            event, sse_buffer = sse_buffer.split("\n\n", 1)
            event = event.strip()
            if event.startswith("data: ") and event != "data: [DONE]":
                try:
                    payload = json.loads(event[6:].strip())
                    if isinstance(payload, dict) and payload.get("usage"):
                        update_metrics(payload["usage"], duration_seconds=duration_seconds)
                except (json.JSONDecodeError, TypeError):
                    pass
        return sse_buffer

    async def _chat_sync(self, body: dict) -> BackendResult:
        model_id = (body.get("model") or "").strip()
        client = self._get_client()
        await self._ensure_model_loaded(client, model_id)
        t0 = time.monotonic()
        resp = await client.post(self.chat_url, json=body)
        try:
            data = resp.json()
        except Exception:
            data = {"error": (resp.text or str(resp.status_code))[:1000]}
        from routing.router import get_config
        if get_config().get("debug"):
            logger.info("DEBUG [lm_studio_proxy] reçu (non-stream): %s", debug_json(data))
        if resp.status_code == 200 and data.get("usage"):
            duration = time.monotonic() - t0
            update_metrics(data.get("usage"), duration)
        return BackendResult(resp.status_code, data)

    async def _chat_stream(self, body: dict) -> AsyncIterator[str]:
        from routing.router import get_config
        cfg = get_config()
        model_id = (body.get("model") or "").strip()
        client = self._get_client()
        await self._ensure_model_loaded(client, model_id)
        # Copie du body + stream_options.include_usage pour récupérer l'usage en stream
        # (l'API OpenAI ne renvoie usage en stream que si include_usage=true). On ne
        # mute pas le body de l'appelant.
        payload = dict(body)
        payload.setdefault("stream_options", {})
        if isinstance(payload["stream_options"], dict):
            payload["stream_options"] = {**payload["stream_options"], "include_usage": True}
        sse_acc = "" if cfg.get("debug") else None
        stream_ok = False
        try:
            async with client.stream("POST", self.chat_url, json=payload) as resp:
                if resp.status_code != 200:
                    err_body = await resp.aread()
                    err_text = err_body.decode("utf-8", errors="replace")
                    if cfg.get("debug"):
                        try:
                            err_data = json.loads(err_text)
                        except json.JSONDecodeError:
                            err_data = {"_raw": err_text[:2000]}
                        logger.info("DEBUG [lm_studio_proxy] reçu (stream, erreur): %s", debug_json(err_data))
                    err_msg = err_text[:500]
                    err_chunk = {"error": {"message": err_msg}}
                    yield f"data: {json.dumps(err_chunk, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                sse_buffer = ""
                stream_start = time.monotonic()
                async for chunk in resp.aiter_text():
                    if chunk:
                        if sse_acc is not None:
                            sse_acc += chunk
                        sse_buffer += chunk
                        sse_buffer = self._parse_sse_events_for_usage(sse_buffer, stream_start=stream_start)
                        yield chunk
                if sse_buffer.strip():
                    self._parse_sse_events_for_usage(sse_buffer + "\n\n", stream_start=stream_start)
                stream_ok = True
                yield "data: [DONE]\n\n"
        finally:
            if sse_acc is not None and stream_ok:
                logger.info(
                    "DEBUG [lm_studio_proxy] reçu (stream, %d chars): %s",
                    len(sse_acc),
                    debug_json({"_sse": sse_acc}),
                )
