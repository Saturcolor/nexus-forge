"""
Backend proxy Ollama : forward body et réponse tels quels vers l'API OpenAI-compatible d'Ollama.
Pas de traduction (body OpenAI → POST {base_url}/v1/chat/completions, réponse stream ou JSON inchangée).
Auto-pull : si le modèle n'est pas disponible, le pull automatiquement avant de forward.
"""
import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator

import httpx

from providers.base import BackendBase, BackendResult
from providers.ollama.backend import coerce_ollama_options
from utils.debug import debug_json
from providers.ollama.last_metrics import set_last_metrics_from_openai_usage
from providers.ollama.pull_cache import should_skip_check, mark_check_done, is_model_available

logger = logging.getLogger(__name__)

# Dédup des auto-pulls concurrents : N callers pour le même modèle = 1 pull réel.
# Clé = (base_url, model_id). Lock créé lazily la première fois. Évite de bloquer
# le user 600s × N quand plusieurs requêtes arrivent en rafale sur un modèle pas
# encore pullé (race observée dans l'audit).
_pull_locks: dict[tuple[str, str], asyncio.Lock] = {}
_pull_locks_mutex = asyncio.Lock()

# Taille max du dict _pull_locks. En production longue durée avec beaucoup de
# modèles différents, le dict croît sans borne (1 entrée par (url, model_id)
# unique, jamais retirée). On borne à 256 et on élague les locks non-tenus à
# l'insertion pour éviter la fuite mémoire lente.
_PULL_LOCKS_MAX = 256


async def _get_pull_lock(base_url: str, model_id: str) -> asyncio.Lock:
    key = (base_url, model_id)
    async with _pull_locks_mutex:
        lock = _pull_locks.get(key)
        if lock is None:
            # Élagage lazily si on approche de la limite : retire les entrées
            # dont le lock n'est pas actuellement tenu (locked() == False).
            # On ne retire jamais un lock actif (risque de deadlock entre waiters).
            if len(_pull_locks) >= _PULL_LOCKS_MAX:
                to_remove = [k for k, l in _pull_locks.items() if not l.locked()]
                for k in to_remove:
                    del _pull_locks[k]
                logger.debug(
                    "Ollama proxy: _pull_locks élagué — %d entrées retirées, %d restantes",
                    len(to_remove), len(_pull_locks),
                )
            lock = asyncio.Lock()
            _pull_locks[key] = lock
        return lock


class OllamaProxyBackend(BackendBase):
    """
    Proxy transparent vers Ollama en mode API OpenAI (/v1/chat/completions).
    Auto-pull si le modèle n'est pas encore téléchargé.
    """

    def __init__(self, base_url: str, timeout: float = 300.0):
        super().__init__(base_url.rstrip("/"), timeout)
        self.chat_url = f"{self.base_url}/v1/chat/completions"
        self.tags_url = f"{self.base_url}/api/tags"
        self.pull_url = f"{self.base_url}/api/pull"

    async def _ensure_model_available(self, client: httpx.AsyncClient, model_id: str) -> None:
        """Vérifie que le modèle est pullé dans Ollama, sinon auto-pull.
        Dédup : si un pull est déjà en cours pour ce modèle, on attend qu'il finisse
        au lieu de lancer un pull concurrent (économise réseau + lock GPU côté Ollama)."""
        if should_skip_check(self.base_url, model_id):
            return

        # 1. Vérifier via GET /api/tags
        try:
            r = await client.get(self.tags_url, timeout=10.0)
            if r.status_code == 200 and is_model_available(r.json(), model_id):
                mark_check_done(self.base_url, model_id)
                return
        except Exception as e:
            logger.debug("Ollama proxy: vérification modèle disponible: %s", e)

        # 2. Auto-pull si activé
        from routing.router import get_config
        config = get_config()
        if not config.get("ollama_auto_pull", True):
            mark_check_done(self.base_url, model_id)
            return

        # 3. Pull dédup : acquérir le lock par (base_url, model_id). Si N callers
        # arrivent en rafale, un seul fait le pull réel, les autres attendent puis
        # sortent via should_skip_check au re-check (mark_check_done a été émis).
        lock = await _get_pull_lock(self.base_url, model_id)
        async with lock:
            # Re-check après acquisition : un autre caller a peut-être pullé pendant
            # qu'on attendait → on sort sans refaire le boulot.
            if should_skip_check(self.base_url, model_id):
                logger.info("Ollama proxy: pull %s déjà fait par un autre caller", model_id)
                return

            logger.info("Ollama proxy: auto-pull %s (lock acquis)", model_id)
            try:
                async with client.stream(
                    "POST", self.pull_url,
                    json={"model": model_id, "stream": True},
                    timeout=600.0,
                ) as resp:
                    if resp.status_code != 200:
                        err = await resp.aread()
                        logger.warning(
                            "Ollama proxy: auto-pull %s échoué (HTTP %s): %s — pas de cache (retry au prochain appel)",
                            model_id, resp.status_code, err.decode()[:500],
                        )
                        # NE PAS mark_check_done sur échec : sinon should_skip_check
                        # renvoie True pendant 300s et verrouille le modèle en 404
                        # alors qu'un retry pourrait réussir (cache empoisonné).
                        return
                    async for line in resp.aiter_lines():
                        # Log la progression périodiquement
                        if line.strip():
                            try:
                                obj = json.loads(line)
                                status = obj.get("status", "")
                                if "pulling" in status or "downloading" in status:
                                    total = obj.get("total", 0)
                                    completed = obj.get("completed", 0)
                                    if total > 0:
                                        pct = round(completed / total * 100)
                                        if pct % 25 == 0:
                                            logger.info("Ollama auto-pull %s: %s%% (%s)", model_id, pct, status)
                            except (json.JSONDecodeError, Exception):
                                pass
                logger.info("Ollama proxy: auto-pull %s terminé", model_id)
                # Cache UNIQUEMENT sur succès : le modèle est désormais pullé,
                # on peut skip les checks pendant 300s.
                mark_check_done(self.base_url, model_id)
            except Exception as e:
                # NE PAS mark_check_done sur erreur : laisse le prochain appel
                # re-checker /api/tags et retenter le pull (évite le verrou 404 5 min).
                logger.warning(
                    "Ollama proxy: auto-pull %s erreur: %s — pas de cache (retry au prochain appel)",
                    model_id, e,
                )

    async def chat(self, body: dict, stream: bool) -> Any:
        """
        Forward le body tel quel vers POST {base_url}/v1/chat/completions.
        - stream=False : retourne BackendResult(status_code, body_dict).
        - stream=True : async generator qui yield les chunks SSE tels quels.
        """
        if stream:
            return self._chat_stream(body)
        return await self._chat_sync(body)

    def _get_client(self) -> httpx.AsyncClient:
        from providers.http_client import get_client
        return get_client("ollama_proxy", timeout=self.timeout)

    def _body_with_coerced_options(self, body: dict, stream: bool = False) -> dict:
        """Copie le body en typant options (top_k int, etc.) et stream_options pour usage en stream."""
        out = dict(body)
        if body.get("options"):
            out["options"] = coerce_ollama_options(body["options"])
        if stream:
            out.setdefault("stream_options", {})["include_usage"] = True
        return out

    async def _chat_sync(self, body: dict) -> BackendResult:
        model_id = (body.get("model") or "").strip()
        client = self._get_client()
        await self._ensure_model_available(client, model_id)
        payload = self._body_with_coerced_options(body, stream=False)
        resp = await client.post(self.chat_url, json=payload)
        try:
            data = resp.json()
        except Exception:
            data = {"error": (resp.text or str(resp.status_code))[:1000]}
        from routing.router import get_config
        if get_config().get("debug"):
            logger.info("DEBUG [ollama_proxy] reçu (non-stream): %s", debug_json(data))
        if resp.status_code == 200 and isinstance(data, dict):
            usage = data.get("usage")
            if usage:
                set_last_metrics_from_openai_usage(usage)
            else:
                set_last_metrics_from_openai_usage(None)  # met à jour last_activity_ts
        return BackendResult(resp.status_code, data)

    def _parse_sse_events_for_usage(self, sse_buffer: str, stream_start: float | None = None) -> str:
        """Parse les événements SSE complets (data: ...\\n\\n), extrait usage, retourne le buffer restant."""
        duration_seconds = (time.time() - stream_start) if stream_start is not None and stream_start > 0 else None
        while "\n\n" in sse_buffer:
            event, sse_buffer = sse_buffer.split("\n\n", 1)
            event = event.strip()
            if event.startswith("data: ") and event != "data: [DONE]":
                try:
                    payload = json.loads(event[6:].strip())
                    if isinstance(payload, dict) and payload.get("usage"):
                        set_last_metrics_from_openai_usage(payload["usage"], duration_seconds=duration_seconds)
                except (json.JSONDecodeError, TypeError):
                    pass
        return sse_buffer

    async def _chat_stream(self, body: dict) -> AsyncIterator[str]:
        from routing.router import get_config
        cfg = get_config()
        model_id = (body.get("model") or "").strip()
        client = self._get_client()
        await self._ensure_model_available(client, model_id)
        payload = self._body_with_coerced_options(body, stream=True)
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
                        logger.info("DEBUG [ollama_proxy] reçu (stream, erreur): %s", debug_json(err_data))
                    err_msg = err_text[:500]
                    err_chunk = {"error": {"message": err_msg}}
                    yield f"data: {json.dumps(err_chunk, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                sse_buffer = ""
                stream_start = time.time()
                async for chunk in resp.aiter_text():
                    if chunk:
                        if sse_acc is not None:
                            sse_acc += chunk
                        sse_buffer += chunk
                        sse_buffer = self._parse_sse_events_for_usage(sse_buffer, stream_start=stream_start)
                        yield chunk
                if sse_buffer.strip():
                    self._parse_sse_events_for_usage(sse_buffer + "\n\n", stream_start=stream_start)
                set_last_metrics_from_openai_usage(None)  # last_activity_ts au moins
                stream_ok = True
                yield "data: [DONE]\n\n"
        finally:
            if sse_acc is not None and stream_ok:
                logger.info(
                    "DEBUG [ollama_proxy] reçu (stream, %d chars): %s",
                    len(sse_acc),
                    debug_json({"_sse": sse_acc}),
                )
