"""
Collecte des infos Ollama (modèles chargés en mémoire) via GET /api/ps.
Utilisé par la probe si ollama_url est configuré dans config.yaml.
"""
import asyncio
import json
import logging
import urllib.error
import urllib.request
from typing import Any, Dict

logger = logging.getLogger("probe")

OLLAMA_TIMEOUT = 2.0


def _fetch_ps_sync(url: str) -> Dict[str, Any]:
    """GET {url}/api/ps en synchrone (appelé dans un thread)."""
    full_url = f"{url.rstrip('/')}/api/ps"
    req = urllib.request.Request(full_url)
    try:
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as r:
            data = json.loads(r.read().decode("utf-8"))
            models = data.get("models") or []
            return {
                "loaded_models": [m.get("name") or m.get("model") for m in models if isinstance(m, dict)],
                "models_detail": models,
            }
    except urllib.error.URLError as e:
        logger.debug("Ollama /api/ps: %s", e)
        return {"error": str(e.reason) if getattr(e, "reason", None) else str(e)}
    except Exception as e:
        logger.debug("Ollama /api/ps: %s", e)
        return {"error": str(e)}


async def get_ollama_state(ollama_url: str) -> Dict[str, Any]:
    """Retourne l'état Ollama (loaded_models, etc.) ou { error: "..." } si échec."""
    if not (ollama_url or "").strip():
        return {}
    url = ollama_url.strip()
    return await asyncio.to_thread(_fetch_ps_sync, url)
