"""
Handler POST /api/show : infos détaillées sur un modèle (Ollama, LM Studio).
"""
import logging

import httpx
from fastapi import HTTPException

logger = logging.getLogger(__name__)


async def get_model_show(
    backend: str,
    backend_model_id: str,
    name: str,
    config: dict,
) -> dict:
    """
    Retourne le dict à renvoyer au client pour POST /api/show.
    Lève HTTPException en cas d'erreur.
    """
    timeout = config.get("backend_timeout", 300)
    async with httpx.AsyncClient(timeout=float(timeout)) as client:
        if backend == "ollama":
            ollama_url = (config.get("ollama_url") or "http://localhost:11434").rstrip("/")
            try:
                r = await client.post(f"{ollama_url}/api/show", json={"name": backend_model_id})
                if r.status_code != 200:
                    raise HTTPException(status_code=r.status_code, detail=(r.text or str(r.status_code))[:500])
                try:
                    data = r.json()
                except (ValueError, Exception) as json_err:
                    logger.warning("POST /api/show: réponse Ollama non-JSON (HTTP 200): %s", json_err)
                    raise HTTPException(status_code=502, detail="Réponse Ollama invalide (non-JSON)")
                if isinstance(data, dict):
                    data["name"] = name
                return data
            except httpx.RequestError as e:
                logger.warning("POST /api/show: %s", e)
                raise HTTPException(status_code=502, detail="Ollama unreachable")

        if backend == "lm_studio":
            lm_studio_url = (config.get("lm_studio_url") or "http://localhost:1234").rstrip("/")
            try:
                r = await client.get(f"{lm_studio_url}/api/v1/models")
                if r.status_code != 200:
                    raise HTTPException(status_code=r.status_code, detail=(r.text or str(r.status_code))[:500])
                try:
                    data = r.json()
                except (ValueError, Exception) as json_err:
                    logger.warning("POST /api/show (lm_studio): réponse non-JSON (HTTP 200): %s", json_err)
                    raise HTTPException(status_code=502, detail="Réponse LM Studio invalide (non-JSON)")
                items = data.get("models", data.get("data", [])) if isinstance(data, dict) else data or []
                if not isinstance(items, list):
                    items = []
                for m in items:
                    if (m.get("key") or m.get("id") or "") == backend_model_id:
                        return {
                            "name": name,
                            "details": {
                                "display_name": m.get("display_name"),
                                "size_bytes": m.get("size_bytes"),
                                "max_context_length": m.get("max_context_length"),
                                "architecture": m.get("architecture"),
                                "format": m.get("format"),
                            },
                        }
                raise HTTPException(status_code=404, detail=f"Modèle lm_studio non trouvé: {backend_model_id}")
            except httpx.RequestError as e:
                logger.warning("POST /api/show (lm_studio): %s", e)
                raise HTTPException(status_code=502, detail="LM Studio unreachable")

        if backend == "openrouter":
            return {"name": name, "details": {"backend": "openrouter", "model_id": backend_model_id}}

    raise HTTPException(status_code=501, detail=f"POST /api/show non supporté pour le backend {backend}")
