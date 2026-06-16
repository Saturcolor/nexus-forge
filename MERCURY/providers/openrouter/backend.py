"""
Backend OpenRouter : POST https://openrouter.ai/api/v1/chat/completions
API compatible OpenAI : body et réponse identiques (sync + stream SSE).

Détails d'implémentation importants :
- Headers HTTP-Referer / X-OpenRouter-Title (config) pour attribution dashboard OR.
- reasoning : format OpenRouter { effort, max_tokens? }. Pour x-ai/grok, ne pas
  envoyer reasoning (rejet "Invalid arguments passed to the model").
- tools : pour modèles x-ai, retirer messages role=tool et tool_calls assistant
  (xAI rejette 422 sans tools dans le payload).
- stream_options.include_usage = True force OpenRouter à émettre le bloc usage
  dans le dernier event du SSE (sans ça, on perd les tokens prompt/completion).
- Connection pooling DÉSACTIVÉ (max_keepalive_connections=0) : OR route vers des
  upstreams (DeepInfra, Anthropic, Together…) dont les LB peuvent fermer une
  connexion silencieusement sans TCP FIN visible client → pool reuse → hang.
- Hard wall-clock cap 600s via asyncio.timeout, défense en profondeur.
- Retry léger (1 tentative) sur 502/503/504/429/network errors — non-stream
  uniquement, JAMAIS sur stream qui a déjà émis (risque double-output).
"""
import asyncio
import hashlib
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any, AsyncIterator

import httpx

from providers.base import BackendBase, BackendResult, BackendRequestFailed
from providers.openrouter import last_metrics
from providers.openrouter import circuit_breaker
from utils.debug import debug_json

logger = logging.getLogger("mercury.openrouter")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# Hard wall-clock cap for any single OpenRouter call (stream or non-stream).
# Defense-in-depth: even with no-keepalive + idle-read timeouts, weird upstream
# behaviours (long-running silent thinking with periodic keepalive comments,
# stalled provider, etc.) shouldn't pin the client forever. 10 minutes is well
# above any legitimate completion time we've seen (~2 min max for 30k+ token
# prompts on slow reasoning models).
OPENROUTER_TOTAL_TIMEOUT_S = 600

# httpx Limits with no connection pooling: every request opens a fresh TCP/TLS
# connection. Trade-off: +200-500ms handshake per request. Worth it: OpenRouter
# routes through different upstream providers (DeepInfra, Anthropic, Together…)
# whose load balancers can silently close connections without TCP FIN visible
# to the client. Pool reuse → next request grabs a half-closed connection →
# httpx hangs forever waiting for response headers. With pool disabled, every
# request gets a fresh connection so the whole class of "zombie connection"
# bugs disappears.
_OPENROUTER_NO_POOL = httpx.Limits(max_keepalive_connections=0, max_connections=20)

# Retry-able conditions for non-stream OpenRouter calls. Stream is never
# retried (a partial output already flowed to the client → re-running would
# duplicate). 4xx other than 429 = permanent (auth, payload error) → no retry.
_RETRY_STATUS_CODES = frozenset({429, 502, 503, 504})
_RETRY_NETWORK_EXCEPTIONS = (
    httpx.ReadTimeout,
    httpx.ConnectError,
    httpx.RemoteProtocolError,
    httpx.WriteError,
)
_MAX_TRANSIENT_RETRIES = 1
_BASE_RETRY_DELAY_S = 0.8

# Heartbeat: log every N seconds while a request is pending without response.
# Keeps the operator informed during legitimate long inferences (Moonshot
# reasoning runs of 5-7min observed) and turns "silence = stuck?" into a
# clearly-visible "still working".
_HEARTBEAT_INTERVAL_S = 60

# Champs acceptés par l'API OpenRouter (format OpenAI chat completions).
# Note: stream_options est explicitement listé pour que `include_usage`
# survive au sanitize (sans quoi on perdrait tout suivi tokens en stream).
# `provider` est listé pour permettre le routing custom OR (order, ignore,
# allow_fallbacks, ...) cf. https://openrouter.ai/docs/provider-routing.
# Mercury ajoute aussi automatiquement un `provider.ignore` quand le
# circuit breaker détecte qu'un upstream OR pète régulièrement.
OPENROUTER_ALLOWED_KEYS = frozenset({
    "model", "messages", "stream", "stream_options", "temperature", "max_tokens",
    "top_p", "frequency_penalty", "presence_penalty", "stop", "n", "tools",
    "tool_choice", "reasoning", "provider",
})

# Certains providers OR (notamment xAI mais pas seulement) rejettent
# patternProperties / additionalProperties dans les schémas d'outils.
PROBLEMATIC_SCHEMA_KEYWORDS = frozenset({"patternProperties", "additionalProperties"})


def _strip_problematic_schema_keys(obj: Any) -> Any:
    """Retire récursivement patternProperties/additionalProperties des schémas d'outils
    pour tous les modèles OpenRouter (certains providers les rejettent)."""
    if obj is None:
        return obj
    if isinstance(obj, list):
        return [_strip_problematic_schema_keys(v) for v in obj]
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in PROBLEMATIC_SCHEMA_KEYWORDS:
                continue
            out[k] = _strip_problematic_schema_keys(v)
        return out
    return obj


def _is_xai_model(model_id: str) -> bool:
    """True si le modèle est x-ai (ex. grok) — ne pas envoyer reasoning, nettoyer tools."""
    return (model_id or "").lower().startswith("x-ai/")


def _sanitize_messages_for_openrouter(messages: list, is_xai: bool = False) -> list:
    """
    Nettoyage des messages pour compatibilité OpenRouter :
    - Google : exige tool_call_id ou name sur les messages role=tool.
    - xAI  : sans tools dans le payload, les messages role=tool et les
              tool_calls des messages assistant provoquent un 422.
    """
    if not messages or not isinstance(messages, list):
        return messages
    out = []
    for msg in messages:
        if not isinstance(msg, dict):
            out.append(msg)
            continue
        role = (msg.get("role") or "").strip().lower()
        if role == "tool":
            if is_xai:
                continue
            msg = dict(msg)
            if not msg.get("tool_call_id") and not msg.get("name"):
                msg["tool_call_id"] = "openrouter_fallback"
            out.append(msg)
        elif role == "assistant" and is_xai and "tool_calls" in msg:
            msg = {k: v for k, v in msg.items() if k != "tool_calls"}
            out.append(msg)
        else:
            out.append(msg)
    return out


def sanitize_body_for_openrouter(body: dict, model_id: str = "") -> dict:
    """
    Ne garde que les champs compatibles OpenAI/OpenRouter pour éviter 422.
    - model_id : si fourni et commence par "x-ai/", on retire reasoning et on
      nettoie les tools (xAI ne supporte pas reasoning ; le sanitize de messages
      retire aussi role=tool / tool_calls assistant).

    Note dette : OPENROUTER_ALLOWED_KEYS est volontairement étroit aujourd'hui.
    Si tu as besoin de response_format / seed / provider routing / models
    fallback, étends la frozenset (cf. audit 2026-05-04).
    """
    opts = body.get("options") or {}
    if not isinstance(opts, dict):
        opts = {}
    out = {}
    dropped_keys = []
    for key, val in body.items():
        if key not in OPENROUTER_ALLOWED_KEYS and key != "options":
            dropped_keys.append(key)
            continue
    for key in OPENROUTER_ALLOWED_KEYS:
        if key not in body:
            continue
        val = body[key]
        if key == "reasoning":
            if _is_xai_model(model_id):
                continue
            if isinstance(val, dict) and ("effort" in val or "max_tokens" in val):
                out[key] = val
            continue
        if key == "tools" and _is_xai_model(model_id):
            continue
        if key == "tool_choice" and _is_xai_model(model_id):
            continue
        if key == "messages" and isinstance(val, list):
            out[key] = _sanitize_messages_for_openrouter(val, is_xai=_is_xai_model(model_id))
            continue
        out[key] = val
    if "tools" in out and isinstance(out["tools"], list) and out["tools"]:
        out["tools"] = _strip_problematic_schema_keys(out["tools"])
    if "max_tokens" not in out and opts.get("num_predict") is not None:
        try:
            out["max_tokens"] = int(opts["num_predict"])
        except (TypeError, ValueError):
            pass
    if "stream" not in out:
        out["stream"] = True
    # Loguer les clés droppées pour repérer les features OR silencieusement
    # bloquées (response_format, seed, provider routing, etc.). Niveau DEBUG :
    # pas trop verbeux en prod, visible quand l'audit est actif.
    if dropped_keys:
        logger.debug("sanitize_body_for_openrouter: dropped keys=%s (extend OPENROUTER_ALLOWED_KEYS if needed)", dropped_keys)
    return out


def _parse_tool_calls_arguments(accumulated: dict[int, dict]) -> list[dict]:
    """Convertit les tool_calls accumulés (index → {id, name, arguments_str})
    en format Ollama (arguments = objet JSON, pas string)."""
    result = []
    for _idx in sorted(accumulated.keys()):
        tc = accumulated[_idx]
        args_str = tc.get("arguments_str", "")
        try:
            args_obj = json.loads(args_str) if args_str else {}
        except json.JSONDecodeError:
            args_obj = {"_raw": args_str}
        result.append({"function": {"name": tc.get("name", ""), "arguments": args_obj}})
    return result


# ────────────────────────────────────────────────────────────────────────────
# Typed error detectors (inspirés de Hermes auxiliary_client._is_*_error).
# OR wrap ses upstreams (DeepSeek, Anthropic, …) qui ont chacun leur formulation
# d'erreur. Sans matcher les substrings, on classifie systématiquement comme
# "5xx générique" et on perd 1h à comprendre que c'est juste le wallet OR vide.
# ────────────────────────────────────────────────────────────────────────────

_PAYMENT_KEYWORDS = (
    "credits", "insufficient funds", "can only afford", "billing",
    "payment required", "insufficient balance",
)


def _is_payment_error_status_body(status: int | None, body_repr: str) -> bool:
    """402 explicite, ou 4xx avec body qui parle d'argent.
    OR retourne souvent 402 mais parfois 429/500 wrappant un upstream payment error."""
    if status == 402:
        return True
    if status in (402, 429, 500, None):
        body_lower = body_repr.lower()
        if any(kw in body_lower for kw in _PAYMENT_KEYWORDS):
            return True
    return False


def _is_connection_error(exc: BaseException) -> bool:
    """Network unreachable / DNS / TLS / refused. Distinct des erreurs API
    (4xx/5xx du serveur OR), qui elles signifient que le serveur a bien
    répondu mais avec un échec applicatif."""
    if isinstance(exc, _RETRY_NETWORK_EXCEPTIONS):
        return True
    type_name = type(exc).__name__.lower()
    if any(kw in type_name for kw in ("connection", "timeout", "dns", "ssl")):
        return True
    msg = str(exc).lower()
    return any(kw in msg for kw in (
        "connection refused", "name or service not known",
        "no route to host", "network is unreachable",
        "timed out", "connection reset",
    ))


def _is_auth_error(status: int | None, body_repr: str) -> bool:
    """401 ou wording auth-failure dans body (clé API rejetée, expirée, etc.)."""
    if status == 401:
        return True
    body_lower = body_repr.lower()
    return "authentication" in body_lower or "invalid api key" in body_lower or "unauthorized" in body_lower


def _classify_error(status: int | None, body_repr: str, exc: BaseException | None = None) -> str:
    """Retourne un label court pour les logs/metrics : payment / auth / connection /
    timeout / rate_limit / server_error / client_error / unknown."""
    # Order matters: TimeoutError doit gagner sur connection (sinon `_is_connection_error`
    # match le nom de classe "Timeout" et classifie comme connection à tort)
    if isinstance(exc, asyncio.TimeoutError):
        return "timeout"
    if exc is not None and _is_connection_error(exc):
        return "connection"
    if status is None:
        return "unknown"
    if _is_payment_error_status_body(status, body_repr):
        return "payment"
    if _is_auth_error(status, body_repr):
        return "auth"
    if status == 429:
        return "rate_limit"
    if 500 <= status < 600:
        return "server_error"
    if 400 <= status < 500:
        return "client_error"
    return "unknown"


def _log_classified_error(category: str, status: int | None, model_id: str, payload_sha: str, msg: str) -> None:
    """Émet un WARN ciblé selon le type d'erreur, avec une remediation hint claire."""
    if category == "payment":
        logger.warning(
            "OpenRouter wallet/credits exhausted (status=%s model=%s sha=%s): %s "
            "→ check https://openrouter.ai/credits or top up the OR account",
            status, model_id, payload_sha, msg[:200],
        )
    elif category == "auth":
        logger.warning(
            "OpenRouter API key rejected (status=%s model=%s sha=%s): %s "
            "→ check OPENROUTER_API_KEY config",
            status, model_id, payload_sha, msg[:200],
        )
    elif category == "connection":
        logger.warning(
            "OpenRouter network unreachable (model=%s sha=%s): %s "
            "→ check status.openrouter.ai / Mercury network egress",
            model_id, payload_sha, msg[:200],
        )
    elif category == "timeout":
        logger.warning(
            "OpenRouter hard timeout (model=%s sha=%s): upstream took too long",
            model_id, payload_sha,
        )
    elif category == "rate_limit":
        logger.warning(
            "OpenRouter rate limit (status=429 model=%s sha=%s): %s",
            model_id, payload_sha, msg[:200],
        )
    elif category == "server_error":
        logger.warning(
            "OpenRouter upstream server error (status=%s model=%s sha=%s): %s",
            status, model_id, payload_sha, msg[:200],
        )
    else:
        logger.warning(
            "OpenRouter error (status=%s category=%s model=%s sha=%s): %s",
            status, category, model_id, payload_sha, msg[:200],
        )


def _payload_sha(payload: dict) -> str:
    """Hash court et stable du payload (pour corréler avec OR dashboard)."""
    try:
        canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]
    except Exception:
        return "?"


async def _heartbeat_log(label: str, model_id: str, payload_sha: str, start: float) -> None:
    """Background task : log toutes les _HEARTBEAT_INTERVAL_S secondes que la
    requête est toujours pending. Permet de distinguer un upstream lent
    (légitime, 5-7min observés sur reasoning) d'un hang (silence absolu).

    Annulé via task.cancel() dans le finally du caller. Le CancelledError est
    avalé proprement — pas de log d'erreur sur cancellation.
    """
    try:
        while True:
            await asyncio.sleep(_HEARTBEAT_INTERVAL_S)
            elapsed = time.perf_counter() - start
            logger.info(
                "openrouter still pending: %s model=%s sha=%s elapsed=%.0fs",
                label, model_id, payload_sha, elapsed,
            )
    except asyncio.CancelledError:
        return


async def stream_openrouter_sse_to_ndjson(
    sse_stream: AsyncIterator[str],
    canonical_model: str,
    backend_name: str = "openrouter",
    config: dict | None = None,
) -> AsyncIterator[str]:
    """Convertit le flux SSE OpenRouter (OpenAI format) en NDJSON (format Ollama).

    Gère content, tool_calls (accumulation incrémentale des arguments),
    erreurs mid-stream (yield un chunk done:true + error explicite, sans empoisonner
    le content assistant), et garantit un chunk final done:true."""
    buffer = ""
    content_parts: list[str] = []
    # tool_calls accumulés : index → {id, name, arguments_str}
    acc_tool_calls: dict[int, dict] = {}
    done_sent = False

    def _log_response_if_debug() -> None:
        if config and config.get("debug") and content_parts:
            full_reply = "".join(content_parts)
            preview = (full_reply[:500] + "...") if len(full_reply) > 500 else full_reply
            logger.info("DEBUG [api/chat] réponse %s (stream, %d chars): %s", backend_name, len(full_reply), preview)

    def _make_ts() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    def _tool_calls_chunk() -> str:
        """Chunk intermédiaire avec les tool_calls accumulés (format Ollama)."""
        msg: dict[str, Any] = {"role": "assistant", "content": "", "tool_calls": _parse_tool_calls_arguments(acc_tool_calls)}
        return json.dumps({"model": canonical_model, "created_at": _make_ts(), "message": msg, "done": False}, ensure_ascii=False) + "\n"

    def _done_chunk(error: str | None = None) -> str:
        """Chunk final : content vide. Si error fourni, ajoute un champ `error`
        en top-level pour que le consommateur (Mastermind agent runner, etc.)
        puisse détecter l'échec sans regarder dans content."""
        payload: dict[str, Any] = {
            "model": canonical_model,
            "created_at": _make_ts(),
            "message": {"role": "assistant", "content": ""},
            "done": True,
        }
        if error:
            payload["error"] = error
        return json.dumps(payload, ensure_ascii=False) + "\n"

    async for part in sse_stream:
        buffer += part
        while "\n" in buffer or "data: [DONE]" in buffer:
            if "data: [DONE]" in buffer:
                buffer = buffer[buffer.index("data: [DONE]") + len("data: [DONE]"):].lstrip()
                _log_response_if_debug()
                if acc_tool_calls:
                    yield _tool_calls_chunk()
                yield _done_chunk()
                done_sent = True
                return
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            if data_str == "[DONE]":
                _log_response_if_debug()
                if acc_tool_calls:
                    yield _tool_calls_chunk()
                yield _done_chunk()
                done_sent = True
                return
            try:
                evt = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            # Erreur mid-stream OR : on stoppe NET avec un done chunk + error
            # explicite. PAS de réinjection en content_parts (sinon l'historique
            # assistant se retrouve avec "[Erreur OpenRouter: ...]" comme texte
            # de tour valide, ce que les agents downstream vont concat dans
            # leur conversation).
            if isinstance(evt.get("error"), dict):
                err_msg = evt["error"].get("message", "erreur inconnue OpenRouter")
                err_code = evt["error"].get("code")
                logger.warning("OpenRouter mid-stream error: code=%s msg=%s", err_code, err_msg[:300])
                _log_response_if_debug()
                if acc_tool_calls:
                    # Les tool_calls accumulés avant l'erreur sont yieldés —
                    # ils correspondent à un état réel envoyé par le modèle.
                    yield _tool_calls_chunk()
                yield _done_chunk(error=err_msg)
                done_sent = True
                return

            # Bloc usage (OpenAI stream_options.include_usage) — souvent émis
            # dans l'avant-dernier event SSE, choices peut être vide. On le
            # passe au consommateur via un attribut sur le générateur si on
            # l'avait, sinon on log juste.
            usage = evt.get("usage")
            if isinstance(usage, dict) and usage:
                # On ne yield rien (usage n'est pas un format Ollama natif),
                # mais on log et on attache au store global.
                logger.debug("openrouter stream usage: prompt=%s completion=%s",
                             usage.get("prompt_tokens"), usage.get("completion_tokens"))

            choices = evt.get("choices") or []
            if not choices or not isinstance(choices[0], dict):
                continue
            choice = choices[0]
            delta = choice.get("delta") or {}

            delta_content = delta.get("content")
            if isinstance(delta_content, str) and delta_content:
                content_parts.append(delta_content)
                chunk = {"model": canonical_model, "created_at": _make_ts(),
                         "message": {"role": "assistant", "content": delta_content}, "done": False}
                yield json.dumps(chunk, ensure_ascii=False) + "\n"

            delta_tcs = delta.get("tool_calls")
            if isinstance(delta_tcs, list):
                for tc in delta_tcs:
                    if not isinstance(tc, dict):
                        continue
                    idx = tc.get("index", 0)
                    fn = tc.get("function") or {}
                    if idx not in acc_tool_calls:
                        acc_tool_calls[idx] = {"id": tc.get("id", ""), "name": fn.get("name", ""), "arguments_str": ""}
                    if fn.get("name"):
                        acc_tool_calls[idx]["name"] = fn["name"]
                    if fn.get("arguments"):
                        acc_tool_calls[idx]["arguments_str"] += fn["arguments"]

            finish = choice.get("finish_reason")
            if finish:
                _log_response_if_debug()
                if acc_tool_calls:
                    yield _tool_calls_chunk()
                yield _done_chunk()
                done_sent = True
                return

    if buffer.strip():
        data_str = buffer.strip()
        if data_str.startswith("data:"):
            data_str = data_str[5:].strip()
        if data_str and data_str != "[DONE]":
            try:
                evt = json.loads(data_str)
                choices = evt.get("choices") or []
                if choices and isinstance(choices[0], dict):
                    delta = choices[0].get("delta") or {}
                    if delta.get("content"):
                        content_parts.append(delta["content"])
            except json.JSONDecodeError:
                pass

    if not done_sent:
        _log_response_if_debug()
        if acc_tool_calls:
            yield _tool_calls_chunk()
        yield _done_chunk()


def _error_detail_from_body(body: Any, status: int) -> str:
    """Extrait un message d'erreur lisible depuis un body OpenAI-shape normalisé
    (`_build_error_response`) pour le `detail` de BackendRequestFailed.
    Préserve la category OR (server_error/rate_limit/payment/...) quand présente
    afin que le caller garde l'info de classification dans le detail string."""
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            msg = err.get("message") or f"HTTP {status}"
            category = err.get("category")
            return f"{msg} (category={category})" if category else str(msg)
        if isinstance(err, str) and err:
            return err
    return f"OpenRouter HTTP {status}"


def _build_error_response(status: int, message: str, model_id: str) -> dict:
    """Body d'erreur OpenAI-shape (choices présent + error top-level).
    Évite le KeyError chez les callers qui font body['choices'][0]['message']."""
    return {
        "id": f"error-{int(time.time()*1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_id,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": ""},
            "finish_reason": "error",
        }],
        "error": {"message": message, "code": status},
    }


# ────────────────────────────────────────────────────────────────────────────
# Fallback model logic (item G).
# Quand le model principal échoue avec un trigger éligible (timeout, payment,
# server_error persistant, etc.), Mercury bascule transparemment vers un model
# alternatif configuré. Le caller reçoit la response du fallback ; un champ
# `x_mercury_fallback` est ajouté au body pour que la couche au-dessus puisse
# détecter que ce n'est pas le model demandé qui a répondu (qualité possiblement
# différente).
# ────────────────────────────────────────────────────────────────────────────

_DEFAULT_FALLBACK_TRIGGERS = frozenset({"timeout", "payment", "server_error", "connection"})


def _result_fallback_category(result: BackendResult, triggers: frozenset[str]) -> str | None:
    """Si le BackendResult est éligible au fallback, retourne la catégorie. Sinon None."""
    if result.status_code < 400:
        return None
    body = result.body if isinstance(result.body, dict) else {}
    err = body.get("error") if isinstance(body.get("error"), dict) else {}
    category = err.get("category")
    if category and category in triggers:
        return category
    # Pas de catégorie typée → classifier à la volée depuis le status
    if result.status_code in (502, 503, 504) and "server_error" in triggers:
        return "server_error"
    if result.status_code == 408 and "timeout" in triggers:
        return "timeout"
    return None


def _resolve_fallback_models(primary_model: str, fb_config: dict) -> list[str]:
    """Lit la chain de fallbacks depuis la config et retourne la liste à essayer
    dans l'ordre. Le model primary est filtré (pas de no-op).

    Format config (simplifié 2026-05-04) :
      openrouter_model_fallback:
        enabled: true
        triggers: [timeout, payment, server_error, connection]
        chain: ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini", "google/gemini-2.5-flash"]

    La chain est globale : peu importe le model demandé, on essaie les fallbacks
    dans l'ordre. Si le primary model lui-même apparaît dans la chain, on le skippe
    (pas la peine de re-tester ce qui vient de fail).
    """
    if not fb_config.get("enabled"):
        return []
    chain = fb_config.get("chain")
    if not isinstance(chain, list):
        return []
    # Filtre : strings non vides, et != primary
    return [m for m in chain if isinstance(m, str) and m.strip() and m != primary_model]


# ────────────────────────────────────────────────────────────────────────────
# Empty-stream detection + fallback (2026-05-31).
# Un upstream OR peut renvoyer HTTP 200 + un stream qui ne contient QUE des
# commentaires keep-alive (": OPENROUTER PROCESSING"), zéro delta de contenu,
# zéro completion token, puis ferme proprement. Sans détection, stream_ok=True
# et le caller reçoit un tour vide "réussi" (cf. virgil 2026-05-31). On détecte
# ce cas et on retry transparent sur un autre upstream/model tant que rien n'a
# encore été émis vers le client.
# ────────────────────────────────────────────────────────────────────────────

# Nombre max de tentatives quand un stream revient vide (primary + dodge upstream
# + 1er fallback de la chain). Borne la latence du pire cas (~N × ttfb).
_MAX_EMPTY_STREAM_ATTEMPTS = 3

# Détecte qu'un chunk SSE porte un VRAI delta exploitable par le client :
# content/reasoning non-vide, ou un tool_call. Ne matche PAS "content":"" (delta
# vide du chunk role initial) ni les commentaires keep-alive. Volontairement un
# regex (pas de json.loads par chunk) pour rester cheap sur le hot path.
_CONTENT_DELTA_RE = re.compile(
    r'"(?:content|reasoning|reasoning_content)"\s*:\s*"(?:\\.|[^"\\])'
    r'|"tool_calls"\s*:\s*\['
)


def _chunk_has_content(chunk: str) -> bool:
    """True si le chunk contient un delta de contenu/tool_call réel (non-vide)."""
    return bool(_CONTENT_DELTA_RE.search(chunk))


def _extract_error_provider(chunk: str) -> str | None:
    """Extrait error.provider d'un chunk d'erreur SSE (`data: {...}`). None si absent."""
    start = chunk.find("{")
    end = chunk.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(chunk[start:end + 1])
    except (json.JSONDecodeError, ValueError):
        return None
    err = obj.get("error") if isinstance(obj, dict) else None
    if isinstance(err, dict):
        prov = err.get("provider")
        if isinstance(prov, str) and prov.strip():
            return prov
    return None


class OpenRouterBackend(BackendBase):
    """Provider web OpenRouter (clé API standard, pas la clé OpenBill/credits)."""

    def __init__(self, api_key: str, timeout: float = 300.0, base_url: str = ""):
        super().__init__(base_url or OPENROUTER_URL.rstrip("/"), timeout)
        self.api_key = (api_key or "").strip()
        if not self.api_key:
            raise ValueError("OpenRouter : clé API (openrouter_api_key) manquante")

    async def chat(self, body: dict, stream: bool):
        """Entry point public — wrappe `_chat_inner` avec la logique fallback model.
        Stream : fallback UNIQUEMENT tant que rien n'a été émis (cf.
        `_stream_with_empty_fallback`) — une fois du contenu streamé, on ne
        re-fire jamais (ça produirait un re-stream incohérent côté caller)."""
        if stream:
            return self._stream_with_empty_fallback(body)

        from routing.router import get_config
        fb_config = (get_config() or {}).get("openrouter_model_fallback") or {}
        primary_model = (body.get("model") or "").strip()
        triggers_cfg = fb_config.get("triggers")
        triggers = frozenset(triggers_cfg) if isinstance(triggers_cfg, list) else _DEFAULT_FALLBACK_TRIGGERS

        # Premier appel = model demandé
        result = await self._chat_inner(body, stream=False)

        category = _result_fallback_category(result, triggers)
        if category is None:
            return self._finalize_nonstream(result)

        fallbacks = _resolve_fallback_models(primary_model, fb_config)
        if not fallbacks:
            return self._finalize_nonstream(result)

        # Itère sur les fallbacks jusqu'à un succès (ou épuisement)
        for fb_model in fallbacks:
            logger.warning(
                "openrouter model fallback: primary=%s failed (category=%s) → trying %s",
                primary_model, category, fb_model,
            )
            body_copy = dict(body)
            body_copy["model"] = fb_model
            result = await self._chat_inner(body_copy, stream=False)

            new_category = _result_fallback_category(result, triggers)
            if new_category is None:
                # Succès → annoter le body pour traçabilité côté caller
                if isinstance(result.body, dict):
                    result.body["x_mercury_fallback"] = {
                        "original_model": primary_model,
                        "actual_model": fb_model,
                        "trigger_category": category,
                    }
                logger.info(
                    "openrouter model fallback: success on %s after %s failed (%s)",
                    fb_model, primary_model, category,
                )
                return result
            category = new_category  # update reason for next log if continuing

        logger.warning(
            "openrouter model fallback: ALL fallbacks exhausted for %s (last category=%s)",
            primary_model, category,
        )
        return self._finalize_nonstream(result)

    def _finalize_nonstream(self, result: BackendResult) -> BackendResult:
        """Contrat BackendRequestFailed (cf. providers/base.py + ollama/llamacpp) au
        niveau du point de sortie public non-stream : si le résultat FINAL est un
        4xx/5xx upstream (après la retry interne `_post_with_retry` ET la chaîne de
        fallback model `openrouter_model_fallback`), on lève BackendRequestFailed
        pour homogénéiser avec les 6 autres backends.

        IMPORTANT : on lève ICI et pas dans `_chat_inner`, volontairement.
        `_chat_inner` doit continuer à RETOURNER un BackendResult sur erreur car :
          - le circuit_breaker (record_success/record_failure) est déjà décompté
            DANS `_chat_inner` sur le path BackendResult — le raise est postérieur,
            l'accounting reste intact (aucun double-compte, aucun compte manqué) ;
          - la chaîne `openrouter_model_fallback` inspecte le BackendResult via
            `_result_fallback_category` — un raise prématuré dans `_chat_inner`
            court-circuiterait les fallbacks model (anthropic/haiku, gpt-5-mini…).
        Le status_code et le message/category OR sont préservés dans l'exception
        (le caller queue mappe e.status_code ; cf. routes_chat_completions:259)."""
        if isinstance(result, BackendResult) and result.status_code >= 400:
            detail = _error_detail_from_body(result.body, result.status_code)
            raise BackendRequestFailed(result.status_code, detail)
        return result

    async def _stream_with_empty_fallback(self, body: dict):
        """Wrappe `_chat_inner(stream=True)` avec un fallback sur réponse vide.

        On bufferise les chunks jusqu'au 1er delta de contenu réel. Tant que rien
        n'est committé (= rien d'exploitable envoyé au client), si l'attempt se
        termine vide (chunk d'erreur category=empty_response émis par
        stream_generator), on re-fire :
          1. même model en excluant l'upstream fautif (provider.ignore) ;
          2. puis les models de la fallback chain configurée.
        Dès qu'un delta de contenu apparaît, on flush le buffer et on passe en
        pur passthrough — plus aucun retry possible (le caller a déjà reçu du
        contenu). Si toutes les tentatives sont vides, on remonte le dernier
        chunk d'erreur tel quel.
        """
        from routing.router import get_config
        fb_config = (get_config() or {}).get("openrouter_model_fallback") or {}
        primary_model = (body.get("model") or "").strip()
        chain = _resolve_fallback_models(primary_model, fb_config)

        # Plan : primary, primary (dodge upstream fautif), puis la chain. Borné.
        plan = [primary_model, primary_model, *chain][:_MAX_EMPTY_STREAM_ATTEMPTS]
        ignore: set[str] = set()
        last_buffer: list[str] | None = None

        for i, model in enumerate(plan):
            attempt_body = dict(body)
            attempt_body["model"] = model
            if ignore:
                prov = dict(attempt_body.get("provider") or {}) if isinstance(attempt_body.get("provider"), dict) else {}
                prov["ignore"] = sorted({*(prov.get("ignore") or []), *ignore})
                prov.setdefault("allow_fallbacks", True)
                attempt_body["provider"] = prov
            if i > 0:
                logger.warning(
                    "openrouter empty-stream fallback: attempt %d/%d model=%s ignore=%s",
                    i + 1, len(plan), model, sorted(ignore),
                )

            gen = await self._chat_inner(attempt_body, stream=True)
            committed = False
            buffer: list[str] = []
            saw_empty = False
            async for chunk in gen:
                if committed:
                    yield chunk
                    continue
                if _chunk_has_content(chunk):
                    committed = True
                    for buffered in buffer:
                        yield buffered
                    buffer = []
                    yield chunk
                    continue
                buffer.append(chunk)
                if not saw_empty and "empty_response" in chunk:
                    saw_empty = True
                    prov = _extract_error_provider(chunk)
                    if prov:
                        ignore.add(prov)

            if committed:
                return  # contenu déjà streamé intégralement
            if not saw_empty:
                # Fin de stream sans contenu détecté ET sans signal d'erreur vide
                # (cas ambigu : régression de détection, stream non-standard…).
                # On délivre ce qu'on a bufferisé tel quel, SANS retry (safe).
                for buffered in buffer:
                    yield buffered
                return
            # Vrai stream vide → on garde le buffer pour un flush final si on épuise
            last_buffer = buffer

        # Toutes les tentatives vides → remonter le dernier chunk d'erreur au client.
        if last_buffer is not None:
            for buffered in last_buffer:
                yield buffered

    async def _chat_inner(self, body: dict, stream: bool):
        from routing.router import get_config
        config = get_config()
        debug = bool(config.get("debug"))

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        # Optionnel : attribution OpenRouter
        ref = (config.get("openrouter_http_referer") or "").strip()
        if ref:
            headers["HTTP-Referer"] = ref
        title = (config.get("openrouter_title") or "").strip()
        if title:
            headers["X-OpenRouter-Title"] = title

        model_id = (body.get("model") or "").strip()
        payload = sanitize_body_for_openrouter(body, model_id)
        payload["stream"] = stream
        if model_id:
            payload["model"] = model_id

        # Force le bloc usage en stream (sinon perdu dans 95% du trafic).
        # OR supporte include_usage via stream_options (compat OpenAI).
        if stream:
            so = payload.setdefault("stream_options", {}) if isinstance(payload.get("stream_options"), dict) else {}
            payload["stream_options"] = {**so, "include_usage": True}

        # Circuit breaker : injecter automatiquement un `provider.ignore`
        # avec les upstreams OR currently blacklisted. Si le caller a déjà
        # passé son propre `provider.ignore`, on merge (les deux comptent).
        blacklist = circuit_breaker.get_blacklist()
        if blacklist:
            existing_provider = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
            # Normaliser existing_ignore : str → [str] (proxy parfois sérialise mal),
            # list → keep, autre → log warning et ignorer (on garde caller intent visible)
            raw_ignore = existing_provider.get("ignore")
            if isinstance(raw_ignore, list):
                existing_ignore = [s for s in raw_ignore if isinstance(s, str)]
            elif isinstance(raw_ignore, str) and raw_ignore.strip():
                existing_ignore = [raw_ignore.strip()]
            elif raw_ignore is None:
                existing_ignore = []
            else:
                logger.warning(
                    "circuit breaker: caller passed provider.ignore of unexpected type %s — ignoring caller value, using only CB blacklist",
                    type(raw_ignore).__name__,
                )
                existing_ignore = []
            merged_ignore = sorted({*existing_ignore, *blacklist})
            payload["provider"] = {
                **existing_provider,
                "ignore": merged_ignore,
                # allow_fallbacks=True (default OR) — on veut explicitement
                # que OR route vers un autre upstream si tous les nôtres sont fails
                "allow_fallbacks": existing_provider.get("allow_fallbacks", True),
            }
            logger.info("circuit breaker: injecting provider.ignore=%s into OR payload", merged_ignore)

        payload_sha = _payload_sha(payload)

        if debug:
            js = json.dumps(payload, ensure_ascii=False)
            logger.info("DEBUG [openrouter] envoyé (model=%s sha=%s): %s",
                        model_id, payload_sha, (js[:4000] + "...") if len(js) > 4000 else js)

        # Client partagé via get_client (durci 2026-05-04 : warn sur kwargs
        # mismatch). Le no-keepalive + total timeout sont les clés ici.
        from providers.http_client import get_client
        # Timeouts httpx : connect 30s, idle-read 90s. Le hard cap total
        # via asyncio.timeout est appliqué dans les blocs ci-dessous.
        stream_timeout = httpx.Timeout(self.timeout, connect=30.0, read=90.0)
        client = get_client("openrouter", timeout=stream_timeout, limits=_OPENROUTER_NO_POOL)

        # ──────────── NON-STREAM ────────────
        if not stream:
            last_metrics.inflight_enter(model_id)
            t_start = time.perf_counter()
            ttfb_ms: float | None = None
            heartbeat_task = asyncio.create_task(
                _heartbeat_log("non-stream", model_id, payload_sha, t_start)
            )
            try:
                resp = await self._post_with_retry(client, headers, payload, model_id)
                ttfb_ms = (time.perf_counter() - t_start) * 1000.0  # full body in non-stream

                # Body parsing avec garde-fou : OR peut renvoyer du HTML/text
                # sur 502 générique upstream, ce qui plante resp.json().
                raw_body = resp.content if resp.content else b""
                text = raw_body.decode("utf-8", errors="replace") if raw_body else ""
                try:
                    data = json.loads(text) if text else {}
                except json.JSONDecodeError:
                    logger.warning(
                        "OpenRouter non-JSON body (status=%d, %d chars): %s",
                        resp.status_code, len(text), text[:300],
                    )
                    data = _build_error_response(
                        resp.status_code,
                        f"OpenRouter returned non-JSON body: {text[:200]}",
                        model_id,
                    )

                # Si erreur HTTP avec body JSON sans choices, normaliser shape
                if resp.status_code >= 400 and isinstance(data, dict) and "choices" not in data:
                    err_inner = data.get("error", {}) if isinstance(data.get("error"), dict) else {}
                    err_msg = err_inner.get("message") or text[:300] or f"HTTP {resp.status_code}"
                    # Classify + emit a remediation-oriented WARN
                    body_repr = str(err_inner or text)
                    category = _classify_error(resp.status_code, body_repr)
                    _log_classified_error(category, resp.status_code, model_id, payload_sha, body_repr)
                    data = _build_error_response(resp.status_code, err_msg, model_id)
                    # On préserve les métadonnées OR (provider, error code) si présentes
                    if err_inner:
                        data["error"].update({k: v for k, v in err_inner.items() if k != "message"})
                    data["error"]["category"] = category
            except asyncio.TimeoutError:
                _log_classified_error("timeout", None, model_id, payload_sha,
                                      f"hard timeout after {OPENROUTER_TOTAL_TIMEOUT_S}s")
                # Circuit breaker : on ne sait pas quel provider a hangé puisqu'OR
                # n'a jamais répondu. On ne peut pas record_failure ici (pas de
                # provider name). Le fallback model (item G) gère ce cas en
                # bypassant complètement OR pour une retry.
                total_ms = (time.perf_counter() - t_start) * 1000.0
                last_metrics.update_metrics(
                    model_id=model_id, status=504,
                    ttfb_ms=None, total_ms=total_ms,
                )
                return BackendResult(504, _build_error_response(
                    504, f"OpenRouter request exceeded hard cap of {OPENROUTER_TOTAL_TIMEOUT_S}s", model_id,
                ))
            except _RETRY_NETWORK_EXCEPTIONS as e:
                _log_classified_error("connection", None, model_id, payload_sha, str(e))
                total_ms = (time.perf_counter() - t_start) * 1000.0
                last_metrics.update_metrics(
                    model_id=model_id, status=502,
                    ttfb_ms=None, total_ms=total_ms,
                )
                return BackendResult(502, _build_error_response(
                    502, f"OpenRouter network error: {e}", model_id,
                ))
            finally:
                heartbeat_task.cancel()
                try:
                    await heartbeat_task
                except asyncio.CancelledError:
                    pass
                except Exception as hb_exc:
                    # Bug latent dans _heartbeat_log → ne pas masquer en silence
                    # (sinon une régression future passe inaperçue pendant le démontage).
                    logger.warning("heartbeat task raised on cleanup: %s", hb_exc)
                last_metrics.inflight_exit(model_id)

            total_ms = (time.perf_counter() - t_start) * 1000.0
            usage = data.get("usage") if isinstance(data, dict) else None
            provider_name = data.get("provider") if isinstance(data, dict) else None
            req_id = resp.headers.get("x-request-id") or resp.headers.get("x-openrouter-request-id") or "?"
            finish = "?"
            err_category: str | None = None
            if isinstance(data, dict):
                ch = data.get("choices") or []
                if ch and isinstance(ch[0], dict):
                    finish = ch[0].get("finish_reason") or "?"
                # Si on a normalisé une erreur dans data["error"], récupérer la category
                err_obj = data.get("error") if isinstance(data.get("error"), dict) else None
                if err_obj:
                    err_category = err_obj.get("category")

            # Circuit breaker — record success ou failure selon le résultat.
            if resp.status_code < 400:
                circuit_breaker.record_success(provider_name)
            else:
                circuit_breaker.record_failure(provider_name, err_category or _classify_error(resp.status_code, str(data)))

            # Logging structuré post-call : provider, tokens, timing, sha, req-id.
            # C'est LA ligne qu'il faut pour diagnostiquer "pourquoi cette run dérape"
            # sans avoir à re-correler avec OR dashboard.
            logger.info(
                "openrouter call: model=%s provider=%s status=%d total=%.0fms "
                "prompt_tok=%s completion_tok=%s finish=%s sha=%s req_id=%s",
                model_id, provider_name or "?", resp.status_code, total_ms,
                (usage or {}).get("prompt_tokens", "?"),
                (usage or {}).get("completion_tokens", "?"),
                finish, payload_sha, req_id,
            )

            last_metrics.update_metrics(
                usage=usage,
                duration_seconds=total_ms / 1000.0 if total_ms else None,
                model_id=model_id,
                provider=provider_name,
                status=resp.status_code,
                ttfb_ms=ttfb_ms,
                total_ms=total_ms,
            )

            if debug:
                logger.info("DEBUG [openrouter] reçu (non-stream sha=%s): %s", payload_sha, debug_json(data))

            return BackendResult(resp.status_code, data)

        # ──────────── STREAM ────────────
        # PAS DE RETRY sur stream : si on a déjà émis du contenu et qu'on retry,
        # le caller voit deux passes du même tour. Le no-pool + hard timeout
        # protègent contre les hangs ; les 502/503 transient deviennent des
        # erreurs propres remontées au client.
        async def stream_generator():
            sse_acc = "" if debug else None
            stream_ok = False
            saw_content = False  # a-t-on émis au moins un delta de contenu/tool_call réel ?
            t_start = time.perf_counter()
            ttfb_ms: float | None = None
            captured_usage: dict | None = None
            captured_provider: str | None = None
            captured_status: int = 0
            captured_req_id: str = "?"
            last_metrics.inflight_enter(model_id)
            heartbeat_task = asyncio.create_task(
                _heartbeat_log("stream", model_id, payload_sha, t_start)
            )
            try:
                async with asyncio.timeout(OPENROUTER_TOTAL_TIMEOUT_S):
                    async with client.stream("POST", OPENROUTER_URL, headers=headers, json=payload) as resp:
                        captured_status = resp.status_code
                        captured_req_id = (
                            resp.headers.get("x-request-id")
                            or resp.headers.get("x-openrouter-request-id")
                            or "?"
                        )
                        if resp.status_code >= 400:
                            err_body = await resp.aread()
                            err_msg = f"OpenRouter HTTP {resp.status_code}"
                            err_repr = ""
                            try:
                                err_data = json.loads(err_body.decode("utf-8", errors="replace"))
                                err_repr = str(err_data)
                                if isinstance(err_data, dict):
                                    nested = err_data.get("error", {})
                                    err_msg = nested.get("message", err_msg) if isinstance(nested, dict) else err_msg
                                if debug:
                                    logger.info("DEBUG [openrouter] reçu (stream, erreur): %s", debug_json(err_data))
                            except Exception:
                                err_repr = err_body.decode("utf-8", errors="replace") if err_body else ""
                                if debug:
                                    raw = err_body.decode("utf-8", errors="replace") if err_body else ""
                                    logger.info("DEBUG [openrouter] reçu (stream, erreur): %s", debug_json({"_raw": raw[:2000]}))
                            # Classify + emit remediation-oriented WARN
                            category = _classify_error(resp.status_code, err_repr)
                            _log_classified_error(category, resp.status_code, model_id, payload_sha,
                                                  f"req_id={captured_req_id} body={err_repr[:300]}")
                            # Erreur structurée : delta vide + error en top-level chunk
                            # + finish_reason="error". Le parser Ollama (stream_..._to_ndjson)
                            # détecte le top-level error et émet un done chunk avec error sans
                            # empoisonner content.
                            err_chunk = {
                                "choices": [{"delta": {}, "finish_reason": "error", "index": 0}],
                                "error": {"message": err_msg, "code": resp.status_code, "category": category},
                            }
                            yield f"data: {json.dumps(err_chunk, ensure_ascii=False)}\n\n"
                            yield "data: [DONE]\n\n"
                            return

                        first_chunk = True
                        # Buffer pour réassembler les events SSE quand un chunk httpx
                        # coupe une ligne `data: {...}` au milieu (rare mais arrive sur
                        # MTU edge cases). Sans buffer, json.loads() échoue silencieusement
                        # et on rate captured_usage / captured_provider.
                        sniff_buffer = ""
                        async for chunk in resp.aiter_text():
                            if not chunk:
                                continue
                            if first_chunk:
                                ttfb_ms = (time.perf_counter() - t_start) * 1000.0
                                first_chunk = False
                            # Capture lightweight des métadonnées via sniff sur les events
                            # où usage/provider apparaissent. Pour éviter le coût d'un
                            # parser complet à chaque chunk, on ne sniff que lorsque ces
                            # mots-clés sont présents — cas typique : avant-dernier event
                            # OR avec stream_options.include_usage=True.
                            need_sniff = (
                                (captured_usage is None and "\"usage\"" in chunk)
                                or (captured_provider is None and "\"provider\"" in chunk)
                            )
                            if need_sniff:
                                sniff_buffer += chunk
                                # Process any complete data: lines we have so far.
                                while "\n" in sniff_buffer:
                                    line, sniff_buffer = sniff_buffer.split("\n", 1)
                                    line = line.strip()
                                    if not line.startswith("data:"):
                                        continue
                                    body_str = line[5:].strip()
                                    if not body_str or body_str == "[DONE]":
                                        continue
                                    try:
                                        evt = json.loads(body_str)
                                    except json.JSONDecodeError:
                                        continue
                                    if isinstance(evt.get("usage"), dict) and captured_usage is None:
                                        captured_usage = evt["usage"]
                                    if isinstance(evt.get("provider"), str) and captured_provider is None:
                                        captured_provider = evt["provider"]
                                # Cap buffer growth — refuse to accumulate more than 64KB
                                # waiting for a newline (defensive against pathological streams).
                                if len(sniff_buffer) > 64_000:
                                    sniff_buffer = sniff_buffer[-32_000:]
                            if sse_acc is not None:
                                sse_acc += chunk
                            if not saw_content and _chunk_has_content(chunk):
                                saw_content = True
                            yield chunk
                        # Stream fermé proprement. On distingue une vraie complétion
                        # d'une réponse vide upstream (200 + keep-alive comments only,
                        # 0 completion tokens — observé GMICloud/deepseek-v4-flash le
                        # 2026-05-31). La remonter en erreur permet au circuit breaker
                        # de pénaliser l'upstream et au wrapper empty-fallback de
                        # retry, au lieu de livrer silencieusement un tour vide.
                        completion_tok = (captured_usage or {}).get("completion_tokens")
                        # On ne déclare "vide" QUE si l'upstream a explicitement rapporté
                        # un usage avec 0 completion token. Si aucun usage n'a été capturé
                        # (captured_usage is None), on ne sait pas → on NE flagge PAS : ça
                        # évite d'injecter une erreur APRÈS du contenu réel dont le delta
                        # aurait été raté par la heuristique regex sur un chunk splitté.
                        # include_usage=True est forcé (l.686) donc le vrai cas vide
                        # (GMICloud 200 + keep-alive) rapporte bien usage completion=0.
                        if not saw_content and captured_usage is not None and not completion_tok:
                            _log_classified_error(
                                "empty_response", captured_status or 200, model_id, payload_sha,
                                f"provider={captured_provider} completion_tok={completion_tok!r} "
                                f"sse_chars={len(sse_acc or '')} req_id={captured_req_id}",
                            )
                            circuit_breaker.record_failure(captured_provider, "empty_response")
                            err_chunk = {
                                "choices": [{"delta": {}, "finish_reason": "error", "index": 0}],
                                "error": {
                                    "message": "OpenRouter upstream returned an empty response (0 completion tokens)",
                                    "code": 502,
                                    "category": "empty_response",
                                    "provider": captured_provider,
                                },
                            }
                            yield f"data: {json.dumps(err_chunk, ensure_ascii=False)}\n\n"
                            yield "data: [DONE]\n\n"
                        else:
                            stream_ok = True
                            yield "data: [DONE]\n\n"
            except asyncio.TimeoutError:
                _log_classified_error("timeout", None, model_id, payload_sha,
                                      f"stream hard timeout after {OPENROUTER_TOTAL_TIMEOUT_S}s "
                                      f"sse_chars={len(sse_acc or '')}")
                circuit_breaker.record_failure(captured_provider, "timeout")
                err_chunk = {
                    "choices": [{"delta": {}, "finish_reason": "error", "index": 0}],
                    "error": {"message": f"OpenRouter hard timeout {OPENROUTER_TOTAL_TIMEOUT_S}s", "code": 504, "category": "timeout"},
                }
                yield f"data: {json.dumps(err_chunk, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
                captured_status = captured_status or 504
            except _RETRY_NETWORK_EXCEPTIONS as e:
                _log_classified_error("connection", None, model_id, payload_sha, str(e))
                circuit_breaker.record_failure(captured_provider, "connection")
                err_chunk = {
                    "choices": [{"delta": {}, "finish_reason": "error", "index": 0}],
                    "error": {"message": f"OpenRouter network error: {e}", "code": 502, "category": "connection"},
                }
                yield f"data: {json.dumps(err_chunk, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
                captured_status = captured_status or 502
            finally:
                heartbeat_task.cancel()
                try:
                    await heartbeat_task
                except asyncio.CancelledError:
                    pass
                except Exception as hb_exc:
                    # Bug latent dans _heartbeat_log → ne pas masquer en silence
                    # (sinon une régression future passe inaperçue pendant le démontage).
                    logger.warning("heartbeat task raised on cleanup: %s", hb_exc)
                last_metrics.inflight_exit(model_id)
                total_ms = (time.perf_counter() - t_start) * 1000.0
                # Logging structuré post-stream + last_metrics.
                logger.info(
                    "openrouter stream: model=%s provider=%s status=%d ttfb=%.0fms total=%.0fms "
                    "prompt_tok=%s completion_tok=%s ok=%s sha=%s req_id=%s",
                    model_id, captured_provider or "?", captured_status,
                    ttfb_ms or 0.0, total_ms,
                    (captured_usage or {}).get("prompt_tokens", "?"),
                    (captured_usage or {}).get("completion_tokens", "?"),
                    stream_ok, payload_sha, captured_req_id,
                )
                last_metrics.update_metrics(
                    usage=captured_usage,
                    duration_seconds=total_ms / 1000.0 if total_ms else None,
                    model_id=model_id,
                    provider=captured_provider,
                    status=captured_status if captured_status else (200 if stream_ok else None),
                    ttfb_ms=ttfb_ms,
                    total_ms=total_ms,
                )
                # Circuit breaker : record success if stream completed OK
                if stream_ok:
                    circuit_breaker.record_success(captured_provider)
                # Debug dump du SSE complet : dangereux sur gros prompts (10MB+
                # de logs). On garde mais on tronque dur à 50KB pour rester
                # lisible et économe disk.
                if sse_acc is not None and stream_ok:
                    sse_for_log = sse_acc if len(sse_acc) <= 50_000 else (sse_acc[:50_000] + f"...[+{len(sse_acc) - 50_000} chars truncated]")
                    logger.info(
                        "DEBUG [openrouter] reçu (stream, %d chars sha=%s): %s",
                        len(sse_acc), payload_sha,
                        debug_json({"_sse": sse_for_log}),
                    )

        return stream_generator()

    async def _post_with_retry(
        self,
        client: httpx.AsyncClient,
        headers: dict,
        payload: dict,
        model_id: str,
    ) -> httpx.Response:
        """POST non-stream avec 1 retry sur transient (502/503/504/429/network).

        Volontairement minimaliste :
        - max 1 retry (donc 2 tentatives au total)
        - respecte Retry-After sur 429 (capé à 5s)
        - backoff fixe court sur les autres conditions (pas exponentiel — ça
          revient au même avec une seule retry)
        - JAMAIS appelé pour stream (cf. commentaire dans chat()).
        """
        last_resp: httpx.Response | None = None
        last_exc: BaseException | None = None
        for attempt in range(_MAX_TRANSIENT_RETRIES + 1):
            try:
                async with asyncio.timeout(OPENROUTER_TOTAL_TIMEOUT_S):
                    resp = await client.post(OPENROUTER_URL, headers=headers, json=payload)
                if resp.status_code in _RETRY_STATUS_CODES and attempt < _MAX_TRANSIENT_RETRIES:
                    delay = _BASE_RETRY_DELAY_S
                    if resp.status_code == 429:
                        try:
                            delay = float(resp.headers.get("retry-after", _BASE_RETRY_DELAY_S))
                        except (TypeError, ValueError):
                            delay = _BASE_RETRY_DELAY_S
                        delay = min(max(delay, 0.1), 5.0)
                    logger.info(
                        "openrouter retry: status=%d attempt=%d/%d delay=%.1fs model=%s",
                        resp.status_code, attempt + 1, _MAX_TRANSIENT_RETRIES + 1, delay, model_id,
                    )
                    last_resp = resp
                    await asyncio.sleep(delay)
                    continue
                return resp
            except _RETRY_NETWORK_EXCEPTIONS as e:
                last_exc = e
                if attempt < _MAX_TRANSIENT_RETRIES:
                    logger.info(
                        "openrouter retry: %s attempt=%d/%d delay=%.1fs model=%s",
                        type(e).__name__, attempt + 1, _MAX_TRANSIENT_RETRIES + 1, _BASE_RETRY_DELAY_S, model_id,
                    )
                    await asyncio.sleep(_BASE_RETRY_DELAY_S)
                    continue
                raise
        # Si on tombe ici, on a épuisé les retries sur statut retryable
        if last_resp is not None:
            return last_resp
        if last_exc is not None:
            raise last_exc
        # Cas théoriquement impossible mais on couvre
        raise RuntimeError("OpenRouter _post_with_retry: no response and no exception captured")
