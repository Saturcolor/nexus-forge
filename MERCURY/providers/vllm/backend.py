"""
Backend vllm : proxy transparent vers le brain-daemon (qui sert vLLM via toolbox).

Comme `LlamacppBackend`, on tape sur le brain-daemon (port 4321 par défaut) ; le
daemon route vers l'instance vLLM interne (port 11430+N) via lookup `model_id`.

Différences clés vs LlamacppBackend :
- Pas d'injection `thinking_budget_tokens` / `chat_template_kwargs.enable_thinking`
  (vLLM ne consomme pas ces flags — c'est un truc PEG+Jinja propre à llama-server).
- Pas de `merge_consecutive_messages` (idem, défense template llama.cpp).
- `usage` est déjà au format OpenAI standard chez vLLM (prompt_tokens / completion_tokens),
  pas de `timings.predicted_per_second` à parser.
- On consume silencieusement `reasoning_effort` et `reasoning` du body client (Mastermind
  les envoie à tous les backends) plutôt que de les forwarder à vLLM qui les rejetterait.

V1 délibérément minimaliste : pas de DB template par-modèle (à ajouter quand le besoin
émergera d'un cas concret — ex. sampler defaults par model).
"""
import json
import logging
import time
from typing import Any

import httpx

from providers.base import BackendBase, BackendResult, StreamWithUsage, BackendRequestFailed
from providers.llamacpp.last_metrics import update_metrics, inflight_enter, inflight_exit
from utils.debug import debug_json

logger = logging.getLogger(__name__)


class VllmBackend(BackendBase):
    def __init__(self, base_url: str, timeout: float = 300.0):
        super().__init__(base_url, timeout)
        self.chat_url = f"{self.base_url}/v1/chat/completions"

    def _prepare_body(self, body: dict) -> dict:
        """Strip 'vllm/' prefix du model + drop les champs llama-server-specific."""
        body = dict(body)
        model = (body.get("model") or "").strip()
        if model.startswith("vllm/"):
            model = model[5:]
            body["model"] = model

        # vLLM ne comprend pas ces flags — Mastermind les envoie uniformément
        # à tous les backends, on les drop silencieusement pour ne pas faire
        # planter le serveur sur un champ inconnu.
        body.pop("reasoning_effort", None)
        body.pop("reasoning", None)
        body.pop("thinking_budget_tokens", None)
        body.pop("chat_template_kwargs", None)

        return body

    def _normalize_usage(self, data: dict) -> None:
        """vLLM retourne déjà du usage OpenAI standard. On harmonise input_tokens / output_tokens
        pour l'affichage frontend (qui lit les deux conventions)."""
        raw = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        if not raw:
            return
        usage = dict(raw)
        inp = usage.get("prompt_tokens") or usage.get("input_tokens")
        out = usage.get("completion_tokens") or usage.get("output_tokens")
        if inp is not None:
            usage["input_tokens"] = int(inp)
            usage["prompt_tokens"] = int(inp)
        if out is not None:
            usage["output_tokens"] = int(out)
            usage["completion_tokens"] = int(out)
        if usage.get("total_tokens") is None and inp is not None and out is not None:
            usage["total_tokens"] = int(inp) + int(out)
        data["usage"] = usage

    async def chat(self, body: dict, stream: bool) -> Any:
        from routing.router import get_config
        body = self._prepare_body(body)
        if get_config().get("debug"):
            keys = list(body.keys())
            tools = body.get("tools")
            tools_summary = (
                f"tools=[{len(tools)} fns: {','.join(t.get('function', {}).get('name', '?') for t in tools[:5])}{'…' if len(tools) > 5 else ''}]"
                if isinstance(tools, list) and tools else "tools=<absent>"
            )
            msgs = body.get("messages") or []
            roles = "+".join(m.get("role", "?") for m in msgs[:10]) + ("…" if len(msgs) > 10 else "")
            logger.info("DEBUG [vllm] envoyé summary: keys=%s, %d msgs (%s), %s", keys, len(msgs), roles, tools_summary)
            js = json.dumps(body, ensure_ascii=False)
            MAX_LOG_BODY = 200_000
            logger.info(
                "DEBUG [vllm] envoyé: %s",
                (js[:MAX_LOG_BODY] + f"…[truncated, total={len(js)} chars]") if len(js) > MAX_LOG_BODY else js,
            )

        model_for_metrics = body.get("model")

        if not stream:
            inflight_enter(model_for_metrics)
            try:
                t0 = time.monotonic()
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    resp = await client.post(self.chat_url, json=body)
                elapsed = time.monotonic() - t0
                try:
                    data = resp.json()
                except Exception:
                    data = {"error": resp.text}
                if get_config().get("debug"):
                    logger.info("DEBUG [vllm] reçu (non-stream): %s", debug_json(data))
                if resp.status_code >= 400:
                    # 4xx/5xx après upstream : lever pour permettre le fallback cloud
                    # (contrat BackendRequestFailed, cf. providers/base.py + ollama).
                    err = (resp.text or str(resp.status_code))[:500]
                    logger.warning(
                        "vLLM /v1/chat/completions erreur %s: %s",
                        resp.status_code,
                        err,
                    )
                    raise BackendRequestFailed(resp.status_code, err)
                if resp.status_code == 200:
                    self._normalize_usage(data)
                    update_metrics(data.get("usage"), elapsed, body.get("model"))
                return BackendResult(resp.status_code, data)
            finally:
                inflight_exit(model_for_metrics)

        # Streaming : forcer include_usage pour récupérer l'usage dans le dernier chunk SSE
        body.setdefault("stream_options", {})["include_usage"] = True
        usage_out: dict = {}

        async def stream_gen():
            client = httpx.AsyncClient(timeout=httpx.Timeout(timeout=None, connect=10.0))
            t0 = time.monotonic()
            _usage: dict | None = None
            sse_acc = "" if get_config().get("debug") else None
            stream_ok = False
            inflight_enter(model_for_metrics)
            try:
                async with client.stream("POST", self.chat_url, json=body) as resp:
                    if resp.status_code >= 400:
                        err = await resp.aread()
                        err_text = err.decode("utf-8", errors="replace")
                        if get_config().get("debug"):
                            try:
                                err_data = json.loads(err_text)
                            except json.JSONDecodeError:
                                err_data = {"_raw": err_text[:2000]}
                            logger.info("DEBUG [vllm] reçu (stream, erreur): %s", debug_json(err_data))
                        detail = err_text[:500]
                        logger.warning(
                            "vLLM /v1/chat/completions erreur %s (stream): %s",
                            resp.status_code,
                            detail,
                        )
                        # Lever pour permettre le fallback cloud (contrat
                        # BackendRequestFailed, cf. providers/base.py + ollama).
                        # Le worker/queue émet la frame SSE d'erreur (routes_chat_completions).
                        raise BackendRequestFailed(resp.status_code, detail)
                    async for chunk in resp.aiter_bytes():
                        decoded = chunk.decode("utf-8", errors="replace")
                        if sse_acc is not None:
                            sse_acc += decoded
                        try:
                            for raw in decoded.split("\n"):
                                raw = raw.strip()
                                if raw.startswith("data:") and not raw.endswith("[DONE]"):
                                    d = json.loads(raw[5:].strip())
                                    if d.get("usage"):
                                        _usage = d["usage"]
                                        fake = {"usage": dict(_usage)}
                                        self._normalize_usage(fake)
                                        usage_out["usage"] = fake.get("usage")
                        except Exception:
                            pass
                        yield chunk
                    stream_ok = True
            finally:
                if sse_acc is not None and stream_ok:
                    logger.info(
                        "DEBUG [vllm] reçu (stream, %d chars): %s",
                        len(sse_acc),
                        debug_json({"_sse": sse_acc}),
                    )
                update_metrics(
                    _usage,
                    time.monotonic() - t0 if _usage else None,
                    body.get("model"),
                )
                inflight_exit(model_for_metrics)
                await client.aclose()

        return StreamWithUsage(stream_gen(), usage_out)
