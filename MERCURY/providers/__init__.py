"""Backends + handlers par provider (ollama, mlx, lm_studio, openrouter, llamacpp, vllm, lucebox, anthropic)."""
from providers.base import BackendBase, BackendResult
from providers.ollama import OllamaBackend, OllamaProxyBackend, stream_ollama_chat, request_ollama_chat_sync
from providers.mlx import MLXBackend
from providers.lm_studio import (
    LMStudioBackend,
    build_lm_studio_body,
    stream_lm_studio_response,
    request_lm_studio_sync,
)
from providers.lm_studio.proxy_backend import LMStudioProxyBackend
from providers.llamacpp import LlamacppBackend
from providers.vllm import VllmBackend
from providers.lucebox import LuceboxBackend
from providers.show import get_model_show
from providers.openrouter import OpenRouterBackend
from providers.anthropic import AnthropicBackend


def get_backend(name: str, config: dict):
    timeout = float(config.get("backend_timeout", 300))
    if name == "demo":
        # Backend factice (MERCURY_DEMO_MODE) : réponses canned, zéro vrai modèle.
        from providers.demo import DemoBackend
        return DemoBackend("demo://local", timeout=timeout)
    if name == "ollama":
        if not config.get("ollama_enabled", True):
            raise ValueError("Backend ollama est désactivé")
        ollama_url = (config.get("ollama_url") or "http://localhost:11434").rstrip("/")
        if config.get("ollama_proxy_only"):
            return OllamaProxyBackend(ollama_url, timeout=timeout)
        return OllamaBackend(ollama_url, timeout=timeout)
    if name == "mlx":
        if not config.get("mlx_enabled", True):
            raise ValueError("Backend mlx est désactivé")
        return MLXBackend(config.get("mlx_url", "http://localhost:8080"), timeout=timeout)
    if name == "lm_studio":
        if not config.get("lm_studio_enabled", True):
            raise ValueError("Backend lm_studio est désactivé")
        lm_studio_url = (config.get("lm_studio_url") or "http://localhost:1234").rstrip("/")
        if config.get("lm_studio_proxy_only"):
            return LMStudioProxyBackend(lm_studio_url, timeout=timeout)
        return LMStudioBackend(lm_studio_url, timeout=timeout)
    if name == "llamacpp":
        if not config.get("llamacpp_enabled", True):
            raise ValueError("Backend llamacpp est désactivé")
        llamacpp_url = (config.get("llamacpp_url") or "http://localhost:4321").rstrip("/")
        return LlamacppBackend(llamacpp_url, timeout=timeout)
    if name == "vllm":
        if not config.get("vllm_enabled", False):
            raise ValueError("Backend vllm est désactivé")
        # Même brain-daemon que llamacpp (port 4321) — le daemon route vers
        # l'instance vLLM en interne via lookup model_id. Override possible
        # via vllm_url si on déploie un brain-daemon séparé pour vLLM.
        vllm_url = (config.get("vllm_url") or config.get("llamacpp_url") or "http://localhost:4321").rstrip("/")
        return VllmBackend(vllm_url, timeout=timeout)
    if name == "lucebox":
        if not config.get("lucebox_enabled", False):
            raise ValueError("Backend lucebox est désactivé")
        # Lucebox = backend natif extra du brain-daemon (`native-lucebox`).
        # Même brain-daemon que llamacpp/vllm par défaut. Override via lucebox_url.
        lucebox_url = (config.get("lucebox_url") or config.get("llamacpp_url") or "http://localhost:4321").rstrip("/")
        return LuceboxBackend(lucebox_url, timeout=timeout)
    if name == "openrouter":
        if not config.get("openrouter_enabled", False):
            raise ValueError("Backend openrouter est désactivé")
        api_key = (config.get("openrouter_api_key") or "").strip()
        if not api_key:
            raise ValueError("OpenRouter : clé API (openrouter_api_key) manquante")
        return OpenRouterBackend(api_key=api_key, timeout=timeout)
    if name == "anthropic":
        if not config.get("anthropic_enabled", False):
            raise ValueError("Backend anthropic est désactivé")
        cred_file = config.get("anthropic_credentials_file") or None
        return AnthropicBackend(credentials_file=cred_file, timeout=timeout)
    raise ValueError(f"Unknown backend: {name}")


__all__ = [
    "BackendBase",
    "BackendResult",
    "OllamaBackend",
    "OllamaProxyBackend",
    "MLXBackend",
    "LMStudioBackend",
    "LMStudioProxyBackend",
    "LlamacppBackend",
    "VllmBackend",
    "LuceboxBackend",
    "OpenRouterBackend",
    "AnthropicBackend",
    "get_backend",
    "stream_ollama_chat",
    "request_ollama_chat_sync",
    "build_lm_studio_body",
    "stream_lm_studio_response",
    "request_lm_studio_sync",
    "get_model_show",
]
