"""
Check de disponibilité des backends (ollama, mlx, lm_studio, llamacpp, vllm, openrouter, anthropic).
Partagé par GET /admin/backends et par le fallback auto (request_queue, server).
Évite l'import circulaire app_queue <-> admin.
"""
import logging

from providers.http_client import get_client

logger = logging.getLogger(__name__)

BACKEND_CHECK_TIMEOUT_DEFAULT = 2.0

_HEALTH_ENDPOINTS = {
    "ollama": ("ollama_enabled", "ollama_url", "http://localhost:11434", ""),
    "mlx": ("mlx_enabled", "mlx_url", "http://localhost:8080", ""),
    "lm_studio": ("lm_studio_enabled", "lm_studio_url", "http://localhost:1234", "/api/v1/models"),
    "llamacpp": ("llamacpp_enabled", "llamacpp_url", "http://localhost:4321", "/health"),
    # vllm partage le brain-daemon avec llamacpp par défaut (même URL, /health côté daemon).
    # Override via vllm_url si on déploie un daemon dédié pour vLLM.
    "vllm": ("vllm_enabled", "vllm_url", "http://localhost:4321", "/health"),
    # lucebox = backend natif extra du brain-daemon (`native-lucebox`), même /health partagé.
    # Override via lucebox_url si daemon dédié.
    "lucebox": ("lucebox_enabled", "lucebox_url", "http://localhost:4321", "/health"),
}


async def is_backend_up(backend_name: str, config: dict) -> bool:
    """
    Vérifie si le backend est joignable (même logique que GET /admin/backends).
    Utilisé pour le fallback auto : si le backend résolu est down, on bascule sur OpenRouter ou Anthropic.
    Utilise le pool HTTP partagé pour éviter de recréer un client à chaque appel.
    """
    if backend_name == "openrouter":
        return bool((config.get("openrouter_api_key") or "").strip()) and config.get("openrouter_enabled", False)

    if backend_name == "anthropic":
        if not config.get("anthropic_enabled", False):
            return False
        import json as _json
        from pathlib import Path as _Path
        cred_file = config.get("anthropic_credentials_file") or str(_Path.home() / ".claude" / ".credentials.json")
        try:
            data = _json.loads(_Path(cred_file).read_text(encoding="utf-8"))
            return bool((data.get("claudeAiOauth") or {}).get("accessToken", ""))
        except Exception:
            return False

    endpoint = _HEALTH_ENDPOINTS.get(backend_name)
    if endpoint is None:
        return False

    enabled_key, url_key, default_url, path = endpoint
    if not config.get(enabled_key, True):
        return False

    url = str(config.get(url_key, default_url)).rstrip("/")
    timeout = float(config.get("health_check_timeout", BACKEND_CHECK_TIMEOUT_DEFAULT))
    try:
        client = get_client("health_check", timeout=timeout)
        await client.get(f"{url}{path}")
        return True
    except Exception:
        return False
