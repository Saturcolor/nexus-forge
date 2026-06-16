"""
Backend lucebox : proxy transparent vers le brain-daemon (qui sert Lucebox via
`extra_native_backends.native-lucebox`).

Comme `VllmBackend`, on tape sur le brain-daemon (port 4321 par défaut) ; le
daemon route vers l'instance Lucebox interne (port 11430+N) via lookup `model_id`.

Spécificités Lucebox :
- Le `server.py` Lucebox hardcode `model: "luce-dflash"` dans les réponses
  /v1/chat/completions. On rewrite `model` côté Mercury vers la valeur envoyée
  par le client (sans préfixe `lucebox/`), pour rester cohérent avec ce que le
  caller demande.
- Lucebox supporte aussi `/v1/messages` (Anthropic Messages) et `/v1/responses`
  (OpenAI Responses) côté daemon — pas exposé ici, ajouter quand un usecase
  client concret pousse à le faire.
- `chat_template_kwargs` est CONSERVÉ et mergé avec les defaults du template DB
  (clé `enable_thinking` notamment). Lucebox/server.py rend le Jinja Qwen3 avec
  ces kwargs ; sans, pas de bloc <think> rendu.
- Drop des champs purement llama-server (thinking_budget_tokens) ou Mastermind
  (reasoning_effort) que server.py Lucebox ne consomme pas. `reasoning: bool`
  client est traduit en `chat_template_kwargs.enable_thinking` puisque c'est
  l'équivalent sémantique côté Qwen3 thinking.
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


class LuceboxBackend(BackendBase):
    def __init__(self, base_url: str, timeout: float = 300.0):
        super().__init__(base_url, timeout)
        self.chat_url = f"{self.base_url}/v1/chat/completions"

    def _prepare_body(self, body: dict) -> tuple[dict, str]:
        """Strip `lucebox/` du model + merge defaults.chat_template_kwargs depuis DB.
        Retourne (body_modifié, original_model_id) — l'original sert au rewrite réponse."""
        body = dict(body)
        original = (body.get("model") or "").strip()
        model = original
        if model.startswith("lucebox/"):
            model = model[len("lucebox/"):]
            body["model"] = model

        # Champs purement Mastermind/llama-server non consommés par server.py Lucebox.
        # `reasoning_effort` est un mapping budget côté llama-server, n'a pas d'analogue
        # ici (le budget est géré côté Lucebox via --budget au load, pas par requête).
        # `thinking_budget_tokens` = flag llama-server, idem.
        body.pop("reasoning_effort", None)
        body.pop("thinking_budget_tokens", None)

        # `reasoning: bool` (Mastermind) → traduit en chat_template_kwargs.enable_thinking.
        # Conservé avant le merge defaults : si le client est explicite, sa valeur gagne
        # contre le template ; sinon le template décide.
        client_reasoning = body.pop("reasoning", None)
        client_enable_thinking: bool | None = None
        if client_reasoning is not None:
            client_enable_thinking = client_reasoning not in (False, "off", "false", None, 0, "0")

        # Merge defaults.chat_template_kwargs depuis le template DB (clé `enable_thinking`
        # principalement, mais accepte aussi `reasoning_effort` pour modèles GPT-OSS/Qwen3
        # récents qui le supportent côté Jinja).
        try:
            from data import db as db_module
            template = db_module.get_llamacpp_template(model) or {}
            defaults = template.get("defaults") or {}

            # Migration legacy : defaults.reasoning (bool) → chat_template_kwargs.enable_thinking
            if "reasoning" in defaults and isinstance(defaults.get("reasoning"), bool):
                legacy_val = defaults.pop("reasoning")
                existing_ctk = defaults.get("chat_template_kwargs")
                if not isinstance(existing_ctk, dict):
                    existing_ctk = {}
                existing_ctk.setdefault("enable_thinking", legacy_val)
                defaults["chat_template_kwargs"] = existing_ctk

            tmpl_ctk = defaults.get("chat_template_kwargs")
            if isinstance(tmpl_ctk, dict) and tmpl_ctk:
                existing = body.get("chat_template_kwargs")
                if not isinstance(existing, dict):
                    existing = {}
                # Template fournit la base ; le body client peut overrider (raison du
                # spread template-puis-body).
                body["chat_template_kwargs"] = {**tmpl_ctk, **existing}

            # Sampler defaults : injecte dans le body si absent (temperature, top_p, etc).
            for key, val in defaults.items():
                if key == "chat_template_kwargs":
                    continue
                if key not in body or body[key] is None:
                    body[key] = val
        except Exception as e:
            logger.debug("lucebox: impossible de charger le template pour %s: %s", model, e)

        # Application du `reasoning` client (overrides template + Mastermind toggle).
        if client_enable_thinking is not None:
            existing = body.get("chat_template_kwargs")
            if not isinstance(existing, dict):
                existing = {}
            existing["enable_thinking"] = client_enable_thinking
            body["chat_template_kwargs"] = existing

        return body, original

    def _rewrite_model(self, data: Any, original_model: str) -> None:
        """Réécrit `data["model"]` vers original_model. Lucebox renvoie "luce-dflash"
        hardcoded ; le client s'attend à recevoir ce qu'il a envoyé."""
        if not original_model or not isinstance(data, dict):
            return
        data["model"] = original_model

    def _normalize_usage(self, data: dict) -> None:
        """Lucebox suit le format OpenAI (prompt_tokens / completion_tokens).
        Harmonise input_tokens / output_tokens pour l'affichage frontend."""
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
        body, original_model = self._prepare_body(body)
        if get_config().get("debug"):
            keys = list(body.keys())
            tools = body.get("tools")
            tools_summary = (
                f"tools=[{len(tools)} fns: {','.join(t.get('function', {}).get('name', '?') for t in tools[:5])}{'…' if len(tools) > 5 else ''}]"
                if isinstance(tools, list) and tools else "tools=<absent>"
            )
            msgs = body.get("messages") or []
            roles = "+".join(m.get("role", "?") for m in msgs[:10]) + ("…" if len(msgs) > 10 else "")
            logger.info("DEBUG [lucebox] envoyé summary: keys=%s, %d msgs (%s), %s", keys, len(msgs), roles, tools_summary)
            js = json.dumps(body, ensure_ascii=False)
            MAX_LOG_BODY = 200_000
            logger.info(
                "DEBUG [lucebox] envoyé: %s",
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
                    logger.info("DEBUG [lucebox] reçu (non-stream): %s", debug_json(data))
                if resp.status_code >= 400:
                    # Upstream 4xx/5xx → lever pour permettre le fallback cloud (cf. contrat BackendRequestFailed)
                    err = (resp.text or str(resp.status_code))[:500]
                    logger.warning(
                        "lucebox /v1/chat/completions erreur %s: %s",
                        resp.status_code,
                        err,
                    )
                    raise BackendRequestFailed(resp.status_code, err)
                self._normalize_usage(data)
                self._rewrite_model(data, original_model)
                update_metrics(data.get("usage"), elapsed, original_model or body.get("model"))
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
                        # Upstream 4xx/5xx → lever pour permettre le fallback cloud (cf. contrat
                        # BackendRequestFailed). Le worker (request_queue) capte l'exception et la
                        # pose sur response_future ; la route émet alors un event SSE d'erreur
                        # canonique (avec status_code) au client. Mirroir du backend ollama.
                        err = await resp.aread()
                        err_text = err.decode("utf-8", errors="replace")
                        logger.warning(
                            "lucebox /v1/chat/completions erreur %s (stream): %s",
                            resp.status_code,
                            err_text[:500],
                        )
                        if get_config().get("debug"):
                            try:
                                err_data = json.loads(err_text)
                            except json.JSONDecodeError:
                                err_data = {"_raw": err_text[:2000]}
                            logger.info("DEBUG [lucebox] reçu (stream, erreur): %s", debug_json(err_data))
                        raise BackendRequestFailed(resp.status_code, err_text[:500])
                    # Rewrite `"model":"luce-dflash"` → `"model":"<original>"` SUR DES
                    # ÉVÉNEMENTS SSE COMPLETS, pas chunk par chunk : httpx ne garantit
                    # pas que le pattern tienne dans un seul chunk (peut être split sur
                    # frontière réseau → replace raté → le client voit "luce-dflash").
                    # On accumule les bytes jusqu'à un séparateur d'event SSE (\n\n ou
                    # \r\n\r\n), on rewrite l'event complet, on yield.
                    needle = b'"luce-dflash"'
                    # `json.dumps` produit le littéral JSON échappé (guillemets inclus),
                    # ex. luce-dflash → "luce-dflash" ; indispensable si `original_model`
                    # contient un guillemet/backslash/newline (sinon JSON cassé / injection
                    # dans le stream). needle == json.dumps("luce-dflash") par construction.
                    replacement = json.dumps(original_model).encode("utf-8") if original_model else needle
                    pending = b""

                    def _flush_events(buf: bytes) -> tuple[list[bytes], bytes]:
                        """Découpe `buf` en events SSE complets + résidu non-terminé.
                        Séparateur canonique \n\n, tolère \r\n\r\n."""
                        events: list[bytes] = []
                        while True:
                            idx_lf = buf.find(b"\n\n")
                            idx_crlf = buf.find(b"\r\n\r\n")
                            if idx_lf == -1 and idx_crlf == -1:
                                break
                            if idx_crlf != -1 and (idx_lf == -1 or idx_crlf < idx_lf):
                                cut = idx_crlf + 4
                            else:
                                cut = idx_lf + 2
                            events.append(buf[:cut])
                            buf = buf[cut:]
                        return events, buf

                    async for chunk in resp.aiter_bytes():
                        pending += chunk
                        events, pending = _flush_events(pending)
                        for event in events:
                            if original_model and needle in event:
                                event = event.replace(needle, replacement)
                            decoded = event.decode("utf-8", errors="replace")
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
                            yield event
                    # Flush le buffer résiduel (event partiel en fin de stream — rare,
                    # le serveur SSE termine normalement avec \n\n final).
                    if pending:
                        if original_model and needle in pending:
                            pending = pending.replace(needle, replacement)
                        if sse_acc is not None:
                            sse_acc += pending.decode("utf-8", errors="replace")
                        yield pending
                    stream_ok = True
            finally:
                if sse_acc is not None and stream_ok:
                    logger.info(
                        "DEBUG [lucebox] reçu (stream, %d chars): %s",
                        len(sse_acc),
                        debug_json({"_sse": sse_acc}),
                    )
                update_metrics(
                    _usage,
                    time.monotonic() - t0 if _usage else None,
                    original_model or body.get("model"),
                )
                inflight_exit(model_for_metrics)
                await client.aclose()

        return StreamWithUsage(stream_gen(), usage_out)
