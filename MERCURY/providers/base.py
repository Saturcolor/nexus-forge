"""
Interface commune pour les backends Ollama / MLX.
Adapte la requête, appelle le backend, renvoie la réponse (ou stream).
"""
from abc import ABC, abstractmethod
from typing import AsyncIterator, Any, Optional
import json


class StreamWithUsage:
    """Wrapper autour d'un async generator de stream SSE : après consommation, .usage contient le dernier usage vu (pour les logs)."""
    def __init__(self, stream_gen, usage_holder: dict):
        self._stream_gen = stream_gen
        self._usage_holder = usage_holder

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self._stream_gen.__anext__()

    @property
    def usage(self) -> Optional[dict]:
        return self._usage_holder.get("usage")


class BackendResult:
    """Résultat non-streamé : body JSON et status."""
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self.body = body


class BackendRequestFailed(Exception):
    """Levée quand le backend a répondu 4xx/5xx (après retries). Permet le fallback OpenRouter."""
    def __init__(self, status_code: int, detail: str = ""):
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"{status_code}: {detail}")


DEFAULT_TIMEOUT = 300.0


class BackendBase(ABC):
    def __init__(self, base_url: str, timeout: float = DEFAULT_TIMEOUT):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    @abstractmethod
    async def chat(self, body: dict, stream: bool) -> Any:
        """
        Envoie la requête chat au backend.
        - Si stream=False : retourne BackendResult(status_code, body_dict).
        - Si stream=True : yield des chunks (bytes ou str) à renvoyer au client (SSE).
        """
        pass

    def _openai_to_messages(self, body: dict) -> list:
        """Extrait messages au format attendu par les backends."""
        return body.get("messages", [])
