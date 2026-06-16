"""
Backend Anthropic via OAuth Claude Code.

Authentification : tokens OAuth sk-ant-oat01-* lus depuis ~/.claude/.credentials.json
(même mécanisme que l'extension VS Code / Claude Code CLI). Refresh automatique via
platform.claude.com/v1/oauth/token avec fallback console.anthropic.com.

Pour /v1/chat/completions (worker) : chat(stream=True) retourne des chunks OpenAI SSE.
Pour /api/chat (direct) : chat_raw_sse() + stream_anthropic_sse_to_ndjson().
"""
import asyncio
import json
import logging
import subprocess
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Optional

import httpx

from providers.base import BackendBase, BackendResult, BackendRequestFailed
from utils.debug import debug_json

logger = logging.getLogger("mercury.anthropic")

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_DEFAULT_MAX_TOKENS = 4096

# Requis pour que l'infrastructure OAuth d'Anthropic route correctement les requêtes.
# Sans ce préfixe, les requêtes OAuth reçoivent des erreurs 400 intermittentes.
_CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

# Endpoint de refresh OAuth (Claude Code ≥ 2.1.81 → platform.claude.com)
_OAUTH_REFRESH_ENDPOINTS = [
    "https://platform.claude.com/v1/oauth/token",
    "https://console.anthropic.com/v1/oauth/token",
]
_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

# Beta headers pour toutes les requêtes OAuth (chat normal + reasoning).
# interleaved-thinking-2025-05-14 active la capacité mais ne déclenche pas le thinking
# sans le paramètre thinking:{type:"enabled"} dans le payload.
_COMMON_BETAS = [
    "interleaved-thinking-2025-05-14",
    "fine-grained-tool-streaming-2025-05-14",
]
# Beta headers supplémentaires requis pour les tokens OAuth
_OAUTH_BETAS = [
    "claude-code-20250219",
    "oauth-2025-04-20",
]

_CLAUDE_CODE_VERSION_FALLBACK = "2.1.74"
_claude_code_version_cache: Optional[str] = None


def _detect_claude_code_version() -> str:
    """Détecte la version de Claude Code installée (pour le User-Agent OAuth)."""
    global _claude_code_version_cache
    if _claude_code_version_cache is not None:
        return _claude_code_version_cache
    for cmd in ("claude", "claude-code"):
        try:
            result = subprocess.run(
                [cmd, "--version"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                version = result.stdout.strip().split()[0]
                if version and version[0].isdigit():
                    _claude_code_version_cache = version
                    return version
        except Exception:
            pass
    _claude_code_version_cache = _CLAUDE_CODE_VERSION_FALLBACK
    return _CLAUDE_CODE_VERSION_FALLBACK


# ── OAuth Token Manager ──────────────────────────────────────────────────────

# Registre process-wide des OAuthTokenManager, keyé par chemin de credentials résolu.
# CRITIQUE : get_backend("anthropic", ...) instancie un AnthropicBackend FRAIS à chaque
# requête (cf. providers/__init__.py + appels per-request dans routes_chat_completions /
# request_queue / routes_api). Si chaque backend créait son propre OAuthTokenManager, son
# asyncio.Lock serait per-instance → ZÉRO exclusion mutuelle entre requêtes concurrentes :
# N requêtes concurrentes avec un token expiré déclencheraient N refreshs OAuth simultanés
# (+ N écritures concurrentes sur ~/.claude/.credentials.json → corruption / refresh_token
# rotation race). On partage donc UN seul manager (et donc UN seul lock + UN seul cache de
# token) par chemin de credentials, à l'échelle du process. Calqué sur le pattern
# _pull_locks de providers/ollama/proxy_backend.py.
_token_managers: dict[str, "OAuthTokenManager"] = {}
_token_managers_mutex = asyncio.Lock()


async def get_token_manager(credentials_file: Optional[str] = None) -> "OAuthTokenManager":
    """Retourne le OAuthTokenManager partagé pour ce chemin de credentials (singleton process-wide).

    Garantit qu'un seul manager (donc un seul asyncio.Lock + un seul cache de token) existe
    par fichier de credentials, pour que le lock de refresh protège réellement contre les
    refreshs concurrents inter-requêtes.
    """
    # Clé = chemin résolu (expanduser) pour que None et "~/.claude/.credentials.json"
    # pointent sur le même manager.
    key = str(Path(credentials_file or "~/.claude/.credentials.json").expanduser())
    async with _token_managers_mutex:
        mgr = _token_managers.get(key)
        if mgr is None:
            mgr = OAuthTokenManager(credentials_file)
            _token_managers[key] = mgr
            logger.debug("Anthropic OAuth: nouveau OAuthTokenManager partagé créé pour %s", key)
        return mgr


class OAuthTokenManager:
    """Gère le cycle de vie des tokens OAuth Claude Code avec refresh automatique.

    Lit depuis ~/.claude/.credentials.json (ou chemin configuré),
    rafraîchit automatiquement via platform.claude.com avant expiration.
    Thread-safe via asyncio.Lock pour éviter les refreshs parallèles.

    IMPORTANT : ne JAMAIS instancier directement par requête — passer par
    get_token_manager() pour récupérer le singleton partagé (sinon le lock ci-dessous
    devient per-instance et ne protège plus rien). Cf. note _token_managers ci-dessus.
    """

    def __init__(self, credentials_file: Optional[str] = None):
        self._cred_path = Path(
            credentials_file or "~/.claude/.credentials.json"
        ).expanduser()
        self._access_token: str = ""
        self._refresh_token: str = ""
        self._expires_at_ms: int = 0
        self._lock = asyncio.Lock()
        self._load()

    def _load(self) -> None:
        """Charge les credentials depuis le fichier."""
        try:
            data = json.loads(self._cred_path.read_text(encoding="utf-8"))
            oauth = data.get("claudeAiOauth") or {}
            self._access_token = oauth.get("accessToken", "")
            self._refresh_token = oauth.get("refreshToken", "")
            self._expires_at_ms = int(oauth.get("expiresAt", 0))
        except (json.JSONDecodeError, OSError, IOError) as e:
            logger.debug("Anthropic OAuth: impossible de lire %s: %s", self._cred_path, e)

    def _is_valid(self) -> bool:
        """Vérifie que le token n'est pas expiré (buffer de 60s)."""
        if not self._access_token:
            return False
        if not self._expires_at_ms:
            # Pas de date d'expiration → supposer valide tant que le token est présent
            return True
        now_ms = int(time.time() * 1000)
        return now_ms < (self._expires_at_ms - 60_000)

    def _refresh_sync(self) -> bool:
        """Tente de rafraîchir le token via les endpoints OAuth (appel synchrone stdlib)."""
        if not self._refresh_token:
            logger.debug("Anthropic OAuth: pas de refresh_token disponible")
            return False

        version = _detect_claude_code_version()
        payload = json.dumps({
            "grant_type": "refresh_token",
            "refresh_token": self._refresh_token,
            "client_id": _OAUTH_CLIENT_ID,
        }).encode()
        headers = {
            "Content-Type": "application/json",
            "User-Agent": f"claude-cli/{version} (external, cli)",
        }

        for endpoint in _OAUTH_REFRESH_ENDPOINTS:
            req = urllib.request.Request(
                endpoint, data=payload, headers=headers, method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    result = json.loads(resp.read().decode())
                    new_access = result.get("access_token", "")
                    new_refresh = result.get("refresh_token", self._refresh_token)
                    expires_in = result.get("expires_in", 3600)

                    if new_access:
                        new_expires_ms = int(time.time() * 1000) + (expires_in * 1000)
                        self._access_token = new_access
                        self._refresh_token = new_refresh
                        self._expires_at_ms = new_expires_ms
                        self._write_credentials(new_access, new_refresh, new_expires_ms)
                        logger.info("Anthropic OAuth: token rafraîchi via %s", endpoint)
                        return True
            except Exception as e:
                logger.debug("Anthropic OAuth: refresh échoué sur %s: %s", endpoint, e)

        return False

    def _write_credentials(self, access_token: str, refresh_token: str, expires_at_ms: int) -> None:
        """Écrit les credentials rafraîchis dans le fichier (préserve les autres champs)."""
        try:
            existing: dict = {}
            if self._cred_path.exists():
                existing = json.loads(self._cred_path.read_text(encoding="utf-8"))
            existing["claudeAiOauth"] = {
                "accessToken": access_token,
                "refreshToken": refresh_token,
                "expiresAt": expires_at_ms,
            }
            self._cred_path.parent.mkdir(parents=True, exist_ok=True)
            self._cred_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
            self._cred_path.chmod(0o600)
        except (OSError, IOError) as e:
            logger.debug("Anthropic OAuth: impossible d'écrire les credentials rafraîchis: %s", e)

    def get_token(self) -> str:
        """Retourne un token valide, rafraîchit si nécessaire (synchrone).

        Lève ValueError si aucun token valide n'est disponible.
        """
        if self._is_valid():
            return self._access_token

        # Recharger depuis le fichier au cas où une autre instance l'aurait rafraîchi
        self._load()
        if self._is_valid():
            return self._access_token

        logger.info("Anthropic OAuth: token expiré, tentative de refresh")
        if self._refresh_sync():
            return self._access_token

        raise ValueError(
            "Anthropic OAuth: token expiré et refresh échoué. "
            "Relancez 'claude login' pour renouveler les credentials."
        )

    async def get_token_async(self) -> str:
        """Version async de get_token avec lock pour éviter les refreshs parallèles."""
        if self._is_valid():
            return self._access_token
        async with self._lock:
            # Revérifier sous le lock (autre coroutine a peut-être déjà rafraîchi)
            if self._is_valid():
                return self._access_token
            return await asyncio.get_event_loop().run_in_executor(None, self.get_token)


# ── OAuth headers ────────────────────────────────────────────────────────────


def _build_oauth_headers(token: str) -> dict:
    """Construit les headers HTTP pour une requête OAuth Anthropic."""
    version = _detect_claude_code_version()
    all_betas = _COMMON_BETAS + _OAUTH_BETAS
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ",".join(all_betas),
        "user-agent": f"claude-cli/{version} (external, cli)",
        "x-app": "cli",
    }


# ── Format conversion : OpenAI → Anthropic ──────────────────────────────────


def _convert_image_url_to_anthropic(image_url: dict) -> dict:
    """Convertit un bloc image_url OpenAI en bloc image Anthropic."""
    url = (image_url.get("url") or "").strip()
    if url.startswith("data:"):
        # data URI → base64
        try:
            header, data = url.split(",", 1)
            media_type = header.split(":")[1].split(";")[0]
        except (IndexError, ValueError):
            media_type = "image/jpeg"
            data = url
        return {
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        }
    # URL HTTP
    return {
        "type": "image",
        "source": {"type": "url", "url": url},
    }


def _convert_content_to_anthropic(content: Any) -> Any:
    """Convertit le contenu d'un message OpenAI en format Anthropic."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type", "")
            if btype == "text":
                out.append({"type": "text", "text": block.get("text", "")})
            elif btype == "image_url":
                out.append(_convert_image_url_to_anthropic(block.get("image_url") or {}))
        return out
    return content


def _convert_tool(tool: dict) -> dict:
    """Convertit un tool OpenAI en format Anthropic (parameters → input_schema)."""
    fn = tool.get("function") or tool
    return {
        "name": fn.get("name", ""),
        "description": fn.get("description", ""),
        "input_schema": fn.get("parameters") or fn.get("input_schema") or {"type": "object", "properties": {}},
    }


def _merge_consecutive_roles(messages: list) -> list:
    """Fusionne les messages consécutifs de même rôle (requis par Anthropic)."""
    if not messages:
        return messages
    merged = []
    for msg in messages:
        if merged and merged[-1]["role"] == msg["role"]:
            prev = merged[-1]
            pc = prev["content"]
            nc = msg["content"]
            # Normaliser en listes si nécessaire
            if isinstance(pc, str) and isinstance(nc, str):
                prev["content"] = pc + "\n\n" + nc
            elif isinstance(pc, list) and isinstance(nc, list):
                prev["content"] = pc + nc
            elif isinstance(pc, str) and isinstance(nc, list):
                prev["content"] = [{"type": "text", "text": pc}] + nc
            elif isinstance(pc, list) and isinstance(nc, str):
                prev["content"] = pc + [{"type": "text", "text": nc}]
            else:
                prev["content"] = str(pc) + "\n\n" + str(nc)
        else:
            merged.append(dict(msg))
    return merged


def convert_openai_to_anthropic(body: dict, stream: bool) -> dict:
    """Convertit un body OpenAI chat completions en format Anthropic Messages API."""
    messages = body.get("messages") or []
    system_parts: list[str] = []
    converted_messages: list[dict] = []

    for msg in messages:
        role = (msg.get("role") or "").strip().lower()
        content = msg.get("content")

        if role in ("system", "developer"):
            # Extraire le contenu système
            if isinstance(content, str):
                system_parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        system_parts.append(block.get("text", ""))
            continue

        if role == "tool":
            # Résultat d'outil → message user avec tool_result
            converted_messages.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": msg.get("tool_call_id") or "call_0",
                    "content": content if isinstance(content, str) else json.dumps(content),
                }],
            })
            continue

        if role == "assistant":
            tool_calls = msg.get("tool_calls") or []
            if tool_calls:
                # Assistant avec tool_calls → blocs tool_use
                content_blocks: list[dict] = []
                if content:
                    text = content if isinstance(content, str) else str(content)
                    if text.strip():
                        content_blocks.append({"type": "text", "text": text})
                for tc in tool_calls:
                    if not isinstance(tc, dict):
                        continue
                    fn = tc.get("function") or {}
                    args_str = fn.get("arguments", "{}")
                    try:
                        args = json.loads(args_str) if args_str else {}
                    except (json.JSONDecodeError, TypeError):
                        args = {"_raw": args_str}
                    content_blocks.append({
                        "type": "tool_use",
                        "id": tc.get("id") or "call_0",
                        "name": fn.get("name", ""),
                        "input": args,
                    })
                converted_messages.append({"role": "assistant", "content": content_blocks})
            else:
                converted_messages.append({
                    "role": "assistant",
                    "content": _convert_content_to_anthropic(content) if content is not None else "",
                })
            continue

        if role == "user":
            converted_messages.append({
                "role": "user",
                "content": _convert_content_to_anthropic(content) if content is not None else "",
            })
            continue

    merged = _merge_consecutive_roles(converted_messages)

    # Anthropic refuse les messages avec contenu vide ou whitespace-only
    def _ensure_content(msg: dict) -> dict:
        c = msg.get("content")
        if c is None or (isinstance(c, str) and not c.strip()) or c == []:
            return {**msg, "content": "."}
        if isinstance(c, list):
            cleaned = [b for b in c if not (
                isinstance(b, dict) and b.get("type") == "text" and not (b.get("text") or "").strip()
            )]
            if not cleaned:
                return {**msg, "content": "."}
            return {**msg, "content": cleaned}
        return msg

    merged = [_ensure_content(m) for m in merged]

    out: dict = {
        "model": body.get("model", ""),
        "messages": merged,
        "max_tokens": body.get("max_tokens") or ANTHROPIC_DEFAULT_MAX_TOKENS,
        "stream": stream,
    }

    # OAuth : toujours préfixer le système avec l'identité Claude Code.
    # Requis par l'infrastructure OAuth d'Anthropic (cf. hermes-agent anthropic_adapter.py).
    system_text = "\n\n".join(system_parts) if system_parts else ""
    if system_text:
        out["system"] = [
            {"type": "text", "text": _CLAUDE_CODE_SYSTEM_PREFIX},
            {"type": "text", "text": system_text},
        ]
    else:
        out["system"] = [{"type": "text", "text": _CLAUDE_CODE_SYSTEM_PREFIX}]

    for key in ("temperature", "top_p"):
        if key in body and body[key] is not None:
            out[key] = body[key]

    tools = body.get("tools")
    if tools and isinstance(tools, list):
        out["tools"] = [_convert_tool(t) for t in tools]
        tc = body.get("tool_choice")
        if tc is not None:
            if isinstance(tc, str):
                if tc == "auto":
                    out["tool_choice"] = {"type": "auto"}
                elif tc == "required":
                    out["tool_choice"] = {"type": "any"}
                # "none" → ne pas envoyer tool_choice
            elif isinstance(tc, dict) and tc.get("type") == "function":
                fn_name = (tc.get("function") or {}).get("name", "")
                if fn_name:
                    out["tool_choice"] = {"type": "tool", "name": fn_name}

    return out


def convert_anthropic_to_openai_response(resp: dict, canonical_model: str) -> dict:
    """Convertit une réponse Anthropic non-stream en format OpenAI chat.completion."""
    content_blocks = resp.get("content") or []
    text_parts = [b.get("text", "") for b in content_blocks if b.get("type") == "text"]
    tool_use_blocks = [b for b in content_blocks if b.get("type") == "tool_use"]

    message: dict = {"role": "assistant"}
    text_content = "\n".join(text_parts) if text_parts else (None if tool_use_blocks else "")
    message["content"] = text_content

    if tool_use_blocks:
        message["tool_calls"] = [
            {
                "id": b.get("id", ""),
                "type": "function",
                "function": {
                    "name": b.get("name", ""),
                    "arguments": json.dumps(b.get("input") or {}, ensure_ascii=False),
                },
            }
            for b in tool_use_blocks
        ]

    stop_reason = resp.get("stop_reason", "end_turn")
    finish_reason = "tool_calls" if stop_reason == "tool_use" else "stop"

    usage_raw = resp.get("usage") or {}
    usage = {
        "prompt_tokens": usage_raw.get("input_tokens", 0),
        "completion_tokens": usage_raw.get("output_tokens", 0),
        "total_tokens": usage_raw.get("input_tokens", 0) + usage_raw.get("output_tokens", 0),
    }

    return {
        "id": resp.get("id", ""),
        "object": "chat.completion",
        "created": int(datetime.now(timezone.utc).timestamp()),
        "model": canonical_model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": usage,
    }


# ── Stream converters ────────────────────────────────────────────────────────


def _make_ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


async def stream_anthropic_sse_to_openai(
    sse_stream: AsyncIterator[str],
    canonical_model: str,
    config: Optional[dict] = None,
) -> AsyncIterator[str]:
    """Convertit le flux SSE Anthropic en SSE OpenAI (data: {...}\\n\\n chunks).

    Utilisé par AnthropicBackend.chat(stream=True) pour le chemin worker
    /v1/chat/completions.
    """
    import uuid as _uuid
    completion_id = f"chatcmpl-{_uuid.uuid4().hex[:12]}"
    created = int(datetime.now(timezone.utc).timestamp())
    # acc_tools: block_index → {id, name, arguments_str}
    acc_tools: dict[int, dict] = {}
    buffer = ""
    done_sent = False
    # Accumulateurs usage (AUDIT FIX : usage cloud Anthropic était toujours None — le
    # converter ne propageait pas les tokens des events message_start/message_delta).
    usage_prompt = 0
    usage_completion = 0

    def _chunk(delta: dict, finish_reason: Optional[str] = None) -> str:
        payload = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": canonical_model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    # Header initial avec le rôle
    yield _chunk({"role": "assistant", "content": ""})

    async for part in sse_stream:
        buffer += part
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line or line.startswith(":") or line.startswith("event:"):
                continue
            if not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            try:
                evt = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            etype = evt.get("type", "")

            if etype == "message_start":
                # Anthropic place input_tokens (et un output_tokens partiel) ici.
                _mu = ((evt.get("message") or {}).get("usage")) or {}
                if _mu.get("input_tokens") is not None:
                    usage_prompt = _mu.get("input_tokens") or 0
                if _mu.get("output_tokens"):
                    usage_completion = _mu.get("output_tokens")

            elif etype == "content_block_start":
                idx = evt.get("index", 0)
                block = evt.get("content_block") or {}
                if block.get("type") == "tool_use":
                    acc_tools[idx] = {
                        "id": block.get("id", ""),
                        "name": block.get("name", ""),
                        "arguments_str": "",
                    }
                    yield _chunk({"tool_calls": [{
                        "index": idx,
                        "id": block.get("id", ""),
                        "type": "function",
                        "function": {"name": block.get("name", ""), "arguments": ""},
                    }]})

            elif etype == "content_block_delta":
                idx = evt.get("index", 0)
                delta_data = evt.get("delta") or {}
                dtype = delta_data.get("type", "")
                if dtype == "text_delta":
                    text = delta_data.get("text", "")
                    if text:
                        yield _chunk({"content": text})
                elif dtype == "input_json_delta":
                    partial = delta_data.get("partial_json", "")
                    if idx in acc_tools:
                        acc_tools[idx]["arguments_str"] += partial
                    if partial:
                        yield _chunk({"tool_calls": [{"index": idx, "function": {"arguments": partial}}]})

            elif etype == "message_delta":
                # message_delta porte le compte final cumulatif d'output_tokens.
                _du = evt.get("usage") or {}
                if _du.get("output_tokens") is not None:
                    usage_completion = _du.get("output_tokens")
                stop_reason = (evt.get("delta") or {}).get("stop_reason", "end_turn")
                finish_reason = "tool_calls" if stop_reason == "tool_use" else "stop"
                yield _chunk({}, finish_reason=finish_reason)

            elif etype == "message_stop":
                # Emit un chunk usage final (style OpenAI stream_options.include_usage) AVANT
                # [DONE] pour que la route /v1/chat/completions capture le compte de tokens
                # (sinon usage cloud Anthropic = None — accounting perdu).
                if usage_prompt or usage_completion:
                    _usage_payload = {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": canonical_model,
                        "choices": [],
                        "usage": {
                            "prompt_tokens": usage_prompt,
                            "completion_tokens": usage_completion,
                            "total_tokens": usage_prompt + usage_completion,
                        },
                    }
                    yield f"data: {json.dumps(_usage_payload, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
                done_sent = True
                return

            elif etype == "error":
                # Erreur mid-stream : on emit un chunk OpenAI avec finish_reason="error"
                # + champ error top-level, PAS dans delta.content (sinon les clients
                # concat ça dans l'historique assistant). Puis [DONE] et fin.
                err_msg = (evt.get("error") or {}).get("message", "Anthropic error")
                logger.warning("Anthropic erreur stream (SSE→OpenAI): %s", err_msg)
                err_payload = {
                    "choices": [{"delta": {}, "finish_reason": "error", "index": 0}],
                    "error": {"message": err_msg, "type": "anthropic_error"},
                }
                yield f"data: {json.dumps(err_payload, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
                done_sent = True
                return

    if not done_sent:
        yield "data: [DONE]\n\n"


async def stream_anthropic_sse_to_ndjson(
    sse_stream: AsyncIterator[str],
    canonical_model: str,
    config: Optional[dict] = None,
) -> AsyncIterator[str]:
    """Convertit le flux SSE Anthropic en NDJSON Ollama.

    Utilisé par le chemin /api/chat (routes_api.py) via _fallback_stream.
    Miroir de stream_openrouter_sse_to_ndjson mais lit les événements Anthropic.
    """
    acc_tools: dict[int, dict] = {}
    content_parts: list[str] = []
    done_sent = False
    buffer = ""

    def _done_chunk(error: str | None = None) -> str:
        """Chunk final NDJSON. Si error fourni, ajoute un champ `error` top-level
        pour que le consommateur (Mastermind, agent runner) détecte l'échec
        sans regarder dans content — calqué sur stream_openrouter_sse_to_ndjson."""
        payload: dict[str, Any] = {
            "model": canonical_model,
            "created_at": _make_ts(),
            "message": {"role": "assistant", "content": ""},
            "done": True,
        }
        if error:
            payload["error"] = error
        return json.dumps(payload, ensure_ascii=False) + "\n"

    def _tool_calls_chunk() -> str:
        tool_calls = []
        for idx in sorted(acc_tools.keys()):
            tc = acc_tools[idx]
            args_str = tc.get("arguments_str", "")
            try:
                args_obj = json.loads(args_str) if args_str else {}
            except json.JSONDecodeError:
                args_obj = {"_raw": args_str}
            tool_calls.append({"function": {"name": tc.get("name", ""), "arguments": args_obj}})
        return json.dumps({
            "model": canonical_model,
            "created_at": _make_ts(),
            "message": {"role": "assistant", "content": "", "tool_calls": tool_calls},
            "done": False,
        }, ensure_ascii=False) + "\n"

    async for part in sse_stream:
        buffer += part
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line or line.startswith(":") or line.startswith("event:"):
                continue
            if not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            try:
                evt = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            etype = evt.get("type", "")

            if etype == "content_block_start":
                idx = evt.get("index", 0)
                block = evt.get("content_block") or {}
                if block.get("type") == "tool_use":
                    acc_tools[idx] = {
                        "id": block.get("id", ""),
                        "name": block.get("name", ""),
                        "arguments_str": "",
                    }

            elif etype == "content_block_delta":
                idx = evt.get("index", 0)
                delta_data = evt.get("delta") or {}
                dtype = delta_data.get("type", "")
                if dtype == "text_delta":
                    text = delta_data.get("text", "")
                    if text:
                        content_parts.append(text)
                        yield json.dumps({
                            "model": canonical_model,
                            "created_at": _make_ts(),
                            "message": {"role": "assistant", "content": text},
                            "done": False,
                        }, ensure_ascii=False) + "\n"
                elif dtype == "input_json_delta":
                    partial = delta_data.get("partial_json", "")
                    if idx in acc_tools and partial:
                        acc_tools[idx]["arguments_str"] += partial

            elif etype == "message_delta":
                stop_reason = (evt.get("delta") or {}).get("stop_reason", "end_turn")
                if stop_reason == "tool_use" and acc_tools:
                    yield _tool_calls_chunk()

            elif etype == "message_stop":
                if config and config.get("debug") and content_parts:
                    full_reply = "".join(content_parts)
                    preview = (full_reply[:500] + "...") if len(full_reply) > 500 else full_reply
                    logger.info("DEBUG [anthropic] réponse (%d chars): %s", len(full_reply), preview)
                yield _done_chunk()
                done_sent = True
                return

            elif etype == "error":
                # Mid-stream error : on stoppe NET avec un done chunk + error explicite.
                # PAS de réinjection en content (sinon l'historique assistant se retrouve
                # avec "[Erreur Anthropic: ...]" comme texte de tour valide → les agents
                # downstream le concat dans leur conversation). Calqué sur OpenRouter NDJSON.
                err_msg = (evt.get("error") or {}).get("message", "Anthropic error")
                logger.warning("Anthropic erreur stream: %s", err_msg)
                if acc_tools:
                    yield _tool_calls_chunk()
                yield _done_chunk(error=err_msg)
                done_sent = True
                return

    if not done_sent:
        if acc_tools:
            yield _tool_calls_chunk()
        yield _done_chunk()


# ── AnthropicBackend ─────────────────────────────────────────────────────────


class AnthropicBackend(BackendBase):
    """Backend Anthropic via OAuth Claude Code.

    Lit les tokens depuis ~/.claude/.credentials.json (ou chemin configuré).
    Refresh automatique via platform.claude.com/v1/oauth/token.
    """

    def __init__(self, credentials_file: Optional[str] = None, timeout: float = 300.0):
        super().__init__(ANTHROPIC_URL.rstrip("/"), timeout)
        # On NE crée PAS le OAuthTokenManager ici : un AnthropicBackend est instancié par
        # requête (get_backend), donc un manager per-instance aurait un lock per-instance
        # inutile. On résout le manager PARTAGÉ paresseusement dans _get_headers() via
        # get_token_manager(). On mémorise juste le chemin demandé.
        self._credentials_file = credentials_file

    async def _get_headers(self) -> dict:
        """Retourne les headers avec token valide (refresh si nécessaire)."""
        # 1) Détecter la version Claude Code HORS event-loop : _detect_claude_code_version()
        #    fait un subprocess.run(timeout=5) bloquant au cold-start (cache vide). Exécuté
        #    directement sur la boucle, il gèle TOUTES les requêtes/streams en cours pendant
        #    jusqu'à ~5-10s. On le pousse dans un thread (idempotent : peuple le cache module).
        #    Calqué sur le run_in_executor déjà utilisé par get_token_async pour _refresh_sync.
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _detect_claude_code_version)
        # 2) Récupérer le manager partagé (singleton process-wide → lock de refresh partagé).
        token_mgr = await get_token_manager(self._credentials_file)
        token = await token_mgr.get_token_async()
        # _build_oauth_headers rappelle _detect_claude_code_version() mais le cache est
        # désormais chaud (peuplé ci-dessus hors-loop) → aucun subprocess sur la boucle.
        return _build_oauth_headers(token)

    async def chat_raw_sse(self, anthropic_payload: dict) -> AsyncIterator[str]:
        """Retourne le flux SSE Anthropic brut (pour stream_anthropic_sse_to_ndjson).

        Utilisé par routes_api.py pour le chemin /api/chat.
        """
        from providers.http_client import get_client

        headers = await self._get_headers()
        stream_timeout = httpx.Timeout(self.timeout, connect=30.0, read=90.0)
        client = get_client("anthropic", timeout=stream_timeout)

        async def _gen() -> AsyncIterator[str]:
            try:
                async with client.stream("POST", ANTHROPIC_URL, headers=headers, json=anthropic_payload) as resp:
                    if resp.status_code >= 400:
                        err_body = await resp.aread()
                        err_msg = f"HTTP {resp.status_code}"
                        try:
                            err_data = json.loads(err_body.decode("utf-8", errors="replace"))
                            logger.warning("Anthropic HTTP %s: %s", resp.status_code, str(err_data)[:500])
                            if isinstance(err_data, dict):
                                nested = err_data.get("error") or {}
                                err_msg = nested.get("message", err_msg) if isinstance(nested, dict) else err_msg
                        except Exception:
                            logger.warning("Anthropic HTTP %s: %s", resp.status_code, err_body[:200])
                        # Émettre un événement d'erreur Anthropic synthétique
                        yield f"event: error\ndata: {json.dumps({'type': 'error', 'error': {'type': 'api_error', 'message': f'Anthropic {err_msg}'}})}\n\n"
                        yield "event: message_stop\ndata: {\"type\": \"message_stop\"}\n\n"
                        return
                    async for chunk in resp.aiter_text():
                        if chunk:
                            yield chunk
                    # Garantir que message_stop est toujours émis
                    yield "event: message_stop\ndata: {\"type\": \"message_stop\"}\n\n"
            except Exception as e:
                logger.warning("Anthropic stream exception: %s", e)
                yield f"event: error\ndata: {json.dumps({'type': 'error', 'error': {'type': 'api_error', 'message': str(e)}})}\n\n"
                yield "event: message_stop\ndata: {\"type\": \"message_stop\"}\n\n"

        return _gen()

    async def chat(self, body: dict, stream: bool):
        """Interface BackendBase.

        Non-stream : retourne BackendResult avec body au format OpenAI.
        Stream : retourne un AsyncIterator de chunks SSE OpenAI (data: {...}\\n\\n).
        """
        from providers.http_client import get_client
        from routing.router import get_config

        config = get_config()
        headers = await self._get_headers()
        payload = convert_openai_to_anthropic(body, stream)

        if config.get("debug"):
            js = json.dumps(payload, ensure_ascii=False)
            logger.info(
                "DEBUG [anthropic] envoyé (model=%s): %s",
                payload.get("model"), (js[:4000] + "...") if len(js) > 4000 else js,
            )

        stream_timeout = httpx.Timeout(self.timeout, connect=30.0, read=90.0)
        client = get_client("anthropic", timeout=stream_timeout)

        if not stream:
            resp = await client.post(ANTHROPIC_URL, headers=headers, json=payload)
            data = resp.json() if resp.content else {}
            if resp.status_code >= 400:
                # Upstream 4xx/5xx → lever BackendRequestFailed pour permettre le fallback
                # (cf. contrat providers/base.py, miroir de llamacpp/ollama). On NE renvoie
                # PLUS un BackendResult avec un body d'erreur OpenAI-shape : un retour normal
                # court-circuitait le fallback (le caller traitait l'erreur comme une réponse
                # valide et la relayait au client avec le status upstream). detail = message
                # Anthropic extrait (error.message) sinon repli sur le body brut tronqué.
                raw_err = data.get("error") if isinstance(data, dict) else None
                if isinstance(raw_err, dict):
                    err_detail = raw_err.get("message", f"HTTP {resp.status_code}")
                else:
                    err_detail = (data.get("message") or str(data))[:500] if isinstance(data, dict) else f"HTTP {resp.status_code}"
                logger.warning("Anthropic HTTP %s: %s", resp.status_code, str(err_detail)[:500])
                raise BackendRequestFailed(resp.status_code, str(err_detail)[:500])
            if config.get("debug"):
                logger.info("DEBUG [anthropic] reçu (non-stream): %s", debug_json(data))
            openai_body = convert_anthropic_to_openai_response(data, body.get("model", ""))
            return BackendResult(resp.status_code, openai_body)

        # Stream : convertir Anthropic SSE → OpenAI SSE via stream_anthropic_sse_to_openai.
        #
        # On N'utilise PAS chat_raw_sse() ici : ce dernier est partagé avec le chemin
        # /api/chat (routes_api.py → stream_anthropic_sse_to_ndjson) qui s'appuie sur son
        # comportement "swallow le 4xx/5xx en event:error synthétique". Le chemin worker
        # /v1/chat/completions doit au contraire LEVER BackendRequestFailed sur 4xx/5xx
        # upstream pour permettre le fallback (cf. contrat providers/base.py, miroir de
        # llamacpp/backend.py qui check le status AVANT le premier yield). On ouvre donc
        # ici notre propre stream raw : status >= 400 → raise (aucun chunk émis) ; sinon on
        # passe les chunks bruts (+ message_stop garanti) au converter SSE→OpenAI.
        async def _raw_stream() -> AsyncIterator[str]:
            async with client.stream("POST", ANTHROPIC_URL, headers=headers, json=payload) as resp:
                if resp.status_code >= 400:
                    # Lu/raise AVANT tout yield → le worker capte l'exception et déclenche
                    # le fallback (rien n'a encore été streamé au client).
                    err_body = await resp.aread()
                    err_detail = f"HTTP {resp.status_code}"
                    try:
                        err_data = json.loads(err_body.decode("utf-8", errors="replace"))
                        if isinstance(err_data, dict):
                            nested = err_data.get("error") or {}
                            err_detail = nested.get("message", err_detail) if isinstance(nested, dict) else err_detail
                    except Exception:
                        err_detail = (err_body.decode("utf-8", errors="replace") or err_detail)[:500]
                    logger.warning("Anthropic HTTP %s (stream): %s", resp.status_code, str(err_detail)[:500])
                    raise BackendRequestFailed(resp.status_code, str(err_detail)[:500])
                async for chunk in resp.aiter_text():
                    if chunk:
                        yield chunk
                # Garantir que message_stop est toujours émis (le converter en dépend pour
                # clôturer proprement, cf. chat_raw_sse).
                yield "event: message_stop\ndata: {\"type\": \"message_stop\"}\n\n"

        return stream_anthropic_sse_to_openai(_raw_stream(), body.get("model", ""), config)
