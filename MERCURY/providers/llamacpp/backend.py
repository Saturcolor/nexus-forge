"""
Backend llamacpp : proxy transparent vers le llamacpp-daemon (déjà OpenAI-compatible).
Injecte les defaults du template si absent du body client.
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


class LlamacppBackend(BackendBase):
    def __init__(self, base_url: str, timeout: float = 300.0):
        super().__init__(base_url, timeout)
        self.chat_url = f"{self.base_url}/v1/chat/completions"

    def _prepare_body(self, body: dict) -> dict:
        """Retire le préfixe 'llamacpp/' du model et injecte les defaults du template."""
        body = dict(body)
        model = (body.get("model") or "").strip()
        if model.startswith("llamacpp/"):
            model = model[9:]
            body["model"] = model

        # ── Thinking / reasoning budget ─────────────────────────────────────
        # Mastermind sends: reasoning_effort: "low"|"medium"|"high" + reasoning: bool
        # llama-server does NOT understand reasoning_effort — it uses:
        #   - chat_template_kwargs.enable_thinking  (Jinja toggle)
        #   - thinking_budget_tokens                (PEG + Jinja budget)
        #
        # Template semantics for enable_thinking:
        #   false → admin kill switch, force thinking OFF regardless of client
        #   true  → model supports thinking, client (Mastermind) controls per-request

        try:
            from routing.router import get_config as _get_cfg
            _cfg = _get_cfg()
        except Exception:
            _cfg = {}
        _EFFORT_TO_BUDGET = {
            "off": 0, "none": 0,
            "low": int(_cfg.get("thinking_budget_low", 1024)),
            "medium": int(_cfg.get("thinking_budget_medium", 4096)),
            "high": int(_cfg.get("thinking_budget_high", -1)),
            "unlimited": -1,
        }

        client_effort = body.pop("reasoning_effort", None)
        client_wants_thinking = None

        if "reasoning" in body:
            reasoning_val = body.pop("reasoning")
            client_wants_thinking = reasoning_val not in (False, "off", "false", None, 0, "0")

        # Injection des defaults du template
        template_enable_thinking = None
        try:
            from data import db as db_module
            template = db_module.get_llamacpp_template(model) or {}
            defaults = template.get("defaults") or {}

            if "reasoning" in defaults and isinstance(defaults.get("reasoning"), bool):
                legacy_val = defaults.pop("reasoning")
                existing_ctk = defaults.get("chat_template_kwargs")
                if not isinstance(existing_ctk, dict):
                    existing_ctk = {}
                if "enable_thinking" not in existing_ctk:
                    existing_ctk["enable_thinking"] = legacy_val
                defaults["chat_template_kwargs"] = existing_ctk
                try:
                    migrated_template = {**template, "defaults": defaults}
                    db_module.set_llamacpp_template(model, migrated_template)
                    logger.debug("llamacpp: migrated legacy 'reasoning' → chat_template_kwargs for %s", model)
                except Exception as mig_err:
                    logger.debug("llamacpp: migration DB failed for %s: %s", model, mig_err)

            tmpl_ctk = defaults.get("chat_template_kwargs")
            if isinstance(tmpl_ctk, dict) and "enable_thinking" in tmpl_ctk:
                template_enable_thinking = tmpl_ctk["enable_thinking"]

            for lvl in ("low", "medium", "high"):
                k = f"thinking_budget_{lvl}"
                if k in defaults:
                    raw = defaults.pop(k)
                    try:
                        _EFFORT_TO_BUDGET[lvl] = int(raw)
                    except (TypeError, ValueError):
                        pass

            for key, val in defaults.items():
                if key == "chat_template_kwargs" and isinstance(val, dict):
                    existing = body.get("chat_template_kwargs")
                    if not isinstance(existing, dict):
                        existing = {}
                    body["chat_template_kwargs"] = {**existing, **val}
                elif key not in body or body[key] is None:
                    body[key] = val
        except Exception as e:
            logger.debug("llamacpp: impossible de charger le template pour %s: %s", model, e)

        # Final resolution → thinking_budget_tokens only.
        # Do NOT touch chat_template_kwargs.enable_thinking here — it was already
        # set by the template merge above and must stay constant across requests
        # to preserve KV cache prefix stability (SWA full reprocess on toggle).
        #
        # Priority: client reasoning_effort mapped through per-model or global budgets
        #         > enable_thinking flag (on/off fallback)
        if template_enable_thinking is False:
            budget = 0
        elif template_enable_thinking is True:
            if client_wants_thinking is False:
                budget = 0
            elif client_effort:
                budget = _EFFORT_TO_BUDGET.get(client_effort, -1)
            else:
                budget = -1
        elif client_effort:
            budget = _EFFORT_TO_BUDGET.get(client_effort, -1)
        elif client_wants_thinking is not None:
            budget = -1 if client_wants_thinking else 0
        else:
            budget = None

        if budget is not None:
            body["thinking_budget_tokens"] = budget

        # ── Merge consecutive same-role messages (per-model toggle) ────────────
        # Defense for templates that strictly enforce role alternation (Mistral
        # PEG-native, some Llama variants). Defaults OFF — opt-in per template.
        # Fusion only: same-role + adjacent + both content are strings + neither has
        # tool_calls. We concat with `\n\n` separator to preserve readability and
        # never drop any content. No synthetic bridge messages inserted.
        try:
            from data import db as _db_merge
            _tmpl_merge = _db_merge.get_llamacpp_template(model) or {}
            if _tmpl_merge.get("merge_consecutive_messages", False) and isinstance(body.get("messages"), list):
                msgs_list = body["messages"]
                merged: list = []
                merge_count = 0
                for msg in msgs_list:
                    if not isinstance(msg, dict):
                        merged.append(msg)
                        continue
                    role = (msg.get("role") or "").strip().lower()
                    if (
                        merged
                        and isinstance(merged[-1], dict)
                        and (merged[-1].get("role") or "").strip().lower() == role
                        and role in ("user", "assistant")
                        and "tool_calls" not in msg
                        and "tool_calls" not in merged[-1]
                    ):
                        prev_content = merged[-1].get("content")
                        cur_content = msg.get("content")
                        if isinstance(prev_content, str) and isinstance(cur_content, str):
                            merged[-1] = {**merged[-1], "content": f"{prev_content}\n\n{cur_content}"}
                            merge_count += 1
                            continue
                    merged.append(msg)
                if merge_count > 0:
                    logger.info(
                        "llamacpp: merge_consecutive_messages: fused %d adjacent same-role pair(s), %d → %d msgs (model=%s)",
                        merge_count, len(msgs_list), len(merged), model,
                    )
                    body["messages"] = merged
        except Exception as e:
            logger.warning("llamacpp: merge_consecutive_messages skipped: %s", e)

        return body

    def _normalize_usage(self, data: dict) -> None:
        """Met data['usage'] au format attendu par les logs frontend (input_tokens, output_tokens).
        Accepte usage existant (prompt_tokens/completion_tokens ou input_tokens/output_tokens)
        ou des champs en racine (prompt_tokens, completion_tokens). Modifie data en place.
        """
        raw = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        # Certains serveurs mettent les tokens en racine de la réponse
        inp = raw.get("input_tokens") or raw.get("prompt_tokens")
        if inp is None and "prompt_tokens" in data:
            inp = data.get("prompt_tokens")
        out = raw.get("output_tokens") or raw.get("completion_tokens")
        if out is None and "completion_tokens" in data:
            out = data.get("completion_tokens")
        if inp is not None or out is not None or raw:
            usage = dict(raw)
            if inp is not None:
                usage["input_tokens"] = int(inp)
                usage["prompt_tokens"] = int(inp)
            if out is not None:
                usage["output_tokens"] = int(out)
                usage["completion_tokens"] = int(out)
            if usage.get("total_tokens") is None and inp is not None and out is not None:
                usage["total_tokens"] = int(inp) + int(out)
            if raw.get("tokens_per_second") is not None:
                usage["tokens_per_second"] = float(raw["tokens_per_second"])
            # Extract generation speed from llama-server timings (pure GPU time)
            timings = data.get("timings")
            if isinstance(timings, dict) and timings.get("predicted_per_second") is not None:
                usage["tokens_per_second"] = round(float(timings["predicted_per_second"]), 2)
            data["usage"] = usage

    async def chat(self, body: dict, stream: bool) -> Any:
        from routing.router import get_config
        body = self._prepare_body(body)
        if get_config().get("debug"):
            # Log un résumé structuré (toujours, peu coûteux) pour voir d'un coup d'œil
            # les champs critiques même quand le body complet est tronqué.
            keys = list(body.keys())
            tools = body.get("tools")
            tools_summary = (
                f"tools=[{len(tools)} fns: {','.join(t.get('function', {}).get('name', '?') for t in tools[:5])}{'…' if len(tools) > 5 else ''}]"
                if isinstance(tools, list) and tools else "tools=<absent>"
            )
            msgs = body.get("messages") or []
            roles = "+".join(m.get("role", "?") for m in msgs[:10]) + ("…" if len(msgs) > 10 else "")
            logger.info("DEBUG [llamacpp] envoyé summary: keys=%s, %d msgs (%s), %s", keys, len(msgs), roles, tools_summary)
            # Log full body (sans truncate par défaut, mais cap à 200KB pour éviter de péter les logs)
            js = json.dumps(body, ensure_ascii=False)
            MAX_LOG_BODY = 200_000
            logger.info(
                "DEBUG [llamacpp] envoyé: %s",
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
                    logger.info("DEBUG [llamacpp] reçu (non-stream): %s", debug_json(data))
                if resp.status_code >= 400:
                    # Upstream 4xx/5xx → lever pour permettre le fallback cloud (cf. contrat BackendRequestFailed)
                    err = (resp.text or str(resp.status_code))[:500]
                    logger.warning(
                        "llamacpp /v1/chat/completions erreur %s: %s",
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

        # Forcer l'inclusion de usage dans le dernier chunk SSE (standard OpenAI)
        body.setdefault("stream_options", {})["include_usage"] = True

        # Holder partagé pour exposer l'usage au worker après consommation du stream
        usage_out: dict = {}

        # Stream : passthrough SSE transparent + capture usage pour métriques et logs
        async def stream_gen():
            # No read/write timeout for streaming: during prompt processing on large
            # contexts (>50k tokens), llama.cpp sends no bytes for many minutes before
            # the first response token. Keep a short connect timeout only.
            client = httpx.AsyncClient(timeout=httpx.Timeout(timeout=None, connect=10.0))
            t0 = time.monotonic()
            _usage: dict | None = None
            sse_acc = "" if get_config().get("debug") else None
            stream_ok = False
            yielded_any = False  # au moins un octet envoyé au client ?
            # Marker in-flight: incremented at first iteration, decremented in finally.
            # Placing inside stream_gen (not in chat()) ensures we don't leak if the
            # caller never iterates (e.g. abandons before consuming). The finally runs
            # on GeneratorExit too, so cancellation is handled.
            inflight_enter(model_for_metrics)
            try:
                async with client.stream("POST", self.chat_url, json=body) as resp:
                    if resp.status_code >= 400:  # uniformité contrat (cf. ollama/vllm/lucebox/mlx) — 2xx/3xx = succès
                        err = await resp.aread()
                        err_text = err.decode("utf-8", errors="replace")
                        if get_config().get("debug"):
                            try:
                                err_data = json.loads(err_text)
                            except json.JSONDecodeError:
                                err_data = {"_raw": err_text[:2000]}
                            logger.info("DEBUG [llamacpp] reçu (stream, erreur): %s", debug_json(err_data))
                        # Upstream 4xx/5xx → lever pour permettre le fallback cloud (cf. contrat BackendRequestFailed).
                        # Le finally ci-dessous (update_metrics avec _usage=None, inflight_exit, aclose) s'exécute pendant la propagation.
                        err_detail = (err_text or str(resp.status_code))[:500]
                        logger.warning(
                            "llamacpp /v1/chat/completions erreur %s (stream): %s",
                            resp.status_code,
                            err_detail,
                        )
                        raise BackendRequestFailed(resp.status_code, err_detail)
                    async for chunk in resp.aiter_bytes():
                        decoded = chunk.decode("utf-8", errors="replace")
                        if sse_acc is not None:
                            sse_acc += decoded
                        # Extraire usage depuis les lignes data: du chunk
                        try:
                            for raw in decoded.split("\n"):
                                raw = raw.strip()
                                if raw.startswith("data:") and not raw.endswith("[DONE]"):
                                    d = json.loads(raw[5:].strip())
                                    if d.get("usage"):
                                        _usage = d["usage"]
                                        # Normaliser pour les logs frontend (input_tokens / output_tokens)
                                        fake = {"usage": dict(_usage)}
                                        self._normalize_usage(fake)
                                        usage_out["usage"] = fake.get("usage")
                        except Exception:
                            pass
                        yielded_any = True
                        yield chunk
                    stream_ok = True
            except httpx.TransportError as e:
                # Échec niveau connexion (llama.cpp déconnecté pendant un long prompt-processing,
                # ou avant d'envoyer les headers — cf. RemoteProtocolError "Server disconnected").
                # Ce n'est PAS un BackendRequestFailed (pas de status HTTP) : sans ça, ça remonte
                # brut → 500 non géré + future asyncio orpheline (cf. stack trace mercury 13:56).
                # Aucun octet envoyé → on convertit au contrat (worker = erreur propre / fallback).
                # En cours de stream → on termine proprement (le client a déjà du partiel).
                if yielded_any:
                    logger.warning("llamacpp stream coupé en cours (%s): %s — fin partielle", type(e).__name__, e)
                else:
                    logger.warning("llamacpp stream: connexion upstream échouée (%s): %s", type(e).__name__, e)
                    raise BackendRequestFailed(502, f"upstream connection error: {type(e).__name__}: {e}") from e
            finally:
                if sse_acc is not None and stream_ok:
                    logger.info(
                        "DEBUG [llamacpp] reçu (stream, %d chars): %s",
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
