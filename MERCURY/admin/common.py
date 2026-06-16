"""
Partagé admin : auth, chemins config, helpers JSON, lecture/écriture config.yaml.
"""
import hmac
import logging
import time
from pathlib import Path

import yaml
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from routing.router import get_config, load_config

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"
_bearer_scheme = HTTPBearer(auto_error=False)

_last_probe_warning: dict[str, float] = {}
PROBE_WARNING_COOLDOWN = 60.0


def log_probe_warning(url: str, label: str, e: Exception) -> None:
    """Log un WARNING au plus une fois par PROBE_WARNING_COOLDOWN par URL (évite le spam si la probe est injoignable)."""
    now = time.time()
    key = f"{label}:{url}"
    if now - _last_probe_warning.get(key, 0) >= PROBE_WARNING_COOLDOWN:
        _last_probe_warning[key] = now
        logger.warning(
            "Probe %s unreachable at %s: %s — Configure the URL to point at the host where the probe runs (e.g. http://brain:4567), not localhost if the probe is on another machine.",
            label,
            url,
            e,
        )


async def check_admin_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
):
    """Auth admin: token dédié, ou clé user API si admin_accept_user_api_key est actif.
    Accepts token via Bearer header OR ?token= query parameter (for iframe embedding)."""
    config = get_config()
    admin_token = (config.get("admin_token") or "").strip()

    # Try Bearer header first, then ?token= query param
    presented = (credentials.credentials if credentials is not None else "").strip()
    if not presented:
        presented = (request.query_params.get("token") or "").strip()

    # Token admin dédié (comportement historique)
    if admin_token and presented and hmac.compare_digest(presented.encode("utf-8"), admin_token.encode("utf-8")):
        return

    # Accepte aussi une clé user API connue sur /admin/* si l'option est active
    if config.get("admin_accept_user_api_key", True):
        try:
            from auth import resolve_user
            user_id, _, _ = resolve_user(f"Bearer {presented}" if presented else None)
            if user_id not in ("anonymous", "unknown"):
                return
        except Exception:
            pass

    # Sans admin_token, on garde le comportement "admin ouvert"
    if not admin_token:
        return
    if credentials is None or not hmac.compare_digest(credentials.credentials.encode("utf-8"), admin_token.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Token admin invalide ou manquant")


def json_safe(obj):
    """Retourne une version de l'objet garantie JSON-serializable."""
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, dict):
        return {str(k): json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [json_safe(x) for x in obj]
    return str(obj)


def sanitize_config_for_get(config: dict) -> dict:
    """Retourne une copie avec credits réduit à enabled, timeout_ms, providers_configured. Masque admin_token, openrouter_api_key, les clés audio et atlas_atlasmind_api_key (remplacés par un flag *_set)."""
    import json as _json
    from pathlib import Path as _Path
    out = json_safe(config)
    if isinstance(out, dict):
        if "admin_token" in out:
            out["admin_token_set"] = bool((out.get("admin_token") or "").strip())
            del out["admin_token"]
        if "openrouter_api_key" in out:
            out["openrouter_api_key_set"] = bool((out.get("openrouter_api_key") or "").strip())
            del out["openrouter_api_key"]
        # Audio provider API keys + clé bearer AtlasMind : masquer comme openrouter_api_key
        for secret_key in ("audio_openai_api_key", "audio_groq_api_key", "audio_elevenlabs_api_key", "atlas_atlasmind_api_key"):
            if secret_key in out:
                out[f"{secret_key}_set"] = bool((out.get(secret_key) or "").strip())
                del out[secret_key]
        # Anthropic OAuth : indiquer si les credentials sont disponibles sans exposer le token
        cred_file = (out.get("anthropic_credentials_file") or "").strip()
        cred_path = _Path(cred_file).expanduser() if cred_file else _Path.home() / ".claude" / ".credentials.json"
        try:
            data = _json.loads(cred_path.read_text(encoding="utf-8"))
            out["anthropic_credentials_set"] = bool((data.get("claudeAiOauth") or {}).get("accessToken", ""))
        except Exception:
            out["anthropic_credentials_set"] = False
    # Masquer api_key des users (GET /admin/users masque déjà, même traitement ici)
    if isinstance(out, dict) and isinstance(out.get("users"), list):
        masked_users = []
        for u in out["users"]:
            if isinstance(u, dict):
                u2 = dict(u)
                if "api_key" in u2:
                    u2["api_key"] = mask_key(u2["api_key"] or "")
                masked_users.append(u2)
            else:
                masked_users.append(u)
        out["users"] = masked_users
    if isinstance(out, dict) and "credits" in out and isinstance(out["credits"], dict):
        c = out["credits"]
        providers_configured = []
        key_flags = {}
        for name, key_name in [
            ("openrouter", "openrouter_key"),
            ("openai", "openai_key"),
            ("anthropic", "anthropic_key"),
            ("elevenlabs", "elevenlabs_key"),
        ]:
            if (c.get(key_name) or "").strip():
                providers_configured.append(name)
            key_flags[f"{key_name.replace('_key', '_key_set')}"] = bool((c.get(key_name) or "").strip())
        out["credits"] = {
            "enabled": c.get("enabled", False),
            "timeout_ms": int(c.get("timeout_ms", 30000)),
            "providers_configured": providers_configured,
            "openrouter_key_set": key_flags.get("openrouter_key_set", False),
            "openai_key_set": key_flags.get("openai_key_set", False),
            "anthropic_key_set": key_flags.get("anthropic_key_set", False),
            "elevenlabs_key_set": key_flags.get("elevenlabs_key_set", False),
        }
    return out


def merge_credits_for_post(current_credits: dict | None, body_credits: dict | None) -> dict:
    """Fusionne credits : garde les clés du fichier, override enabled/timeout_ms/providers_preferred et clés API depuis body."""
    current = dict(current_credits or {})
    body = dict(body_credits or {})
    out = dict(current)
    out["enabled"] = body.get("enabled", current.get("enabled", False)) if "enabled" in body else current.get("enabled", False)
    out["timeout_ms"] = int(body["timeout_ms"]) if body.get("timeout_ms") is not None else int(current.get("timeout_ms", 30000))
    if "providers_preferred" in body:
        try:
            out["providers_preferred"] = [str(x) for x in body.get("providers_preferred") or []]
        except TypeError:
            pass
    for key_name in ("openrouter_key", "openai_key", "anthropic_key", "elevenlabs_key"):
        if key_name in body:
            val = body[key_name]
            if isinstance(val, str) and val.strip():
                out[key_name] = val.strip()
            elif isinstance(val, str) and val == "":
                out.pop(key_name, None)
    return out


def mask_key(api_key: str, visible_tail: int = 4) -> str:
    if not api_key or len(api_key) <= visible_tail:
        return "****"
    return "****" + api_key[-visible_tail:]


def load_config_raw() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def save_config(config: dict):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.safe_dump(config, f, default_flow_style=False, allow_unicode=True)
    load_config(CONFIG_PATH)
