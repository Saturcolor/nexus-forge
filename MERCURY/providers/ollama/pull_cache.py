"""
Cache pour éviter de re-vérifier/re-pull un modèle Ollama à chaque requête.
Pattern identique à providers/lm_studio/load_cache.py.
Stratégie : GET /api/tags pour vérifier la disponibilité ; cache TTL pour skip les checks fréquents.
"""
import time
from typing import Any, Dict, List, Tuple

# (ollama_url, model_id) -> timestamp du dernier check
_cache: Dict[Tuple[str, str], float] = {}
_TTL_SECONDS = 300  # 5 min


def should_skip_check(ollama_url: str, model_id: str) -> bool:
    """True si on peut sauter la vérification (déjà vérifié récemment)."""
    key = (ollama_url.rstrip("/"), (model_id or "").strip())
    if not key[1]:
        return False
    ts = _cache.get(key)
    if ts is None:
        return False
    return (time.time() - ts) < _TTL_SECONDS


def mark_check_done(ollama_url: str, model_id: str) -> None:
    """À appeler après vérification (modèle trouvé ou pull terminé)."""
    key = (ollama_url.rstrip("/"), (model_id or "").strip())
    if key[1]:
        _cache[key] = time.time()


def is_model_available(tags_data: Any, model_id: str) -> bool:
    """
    True si le modèle est présent dans la réponse GET /api/tags.
    tags_data : dict avec clé "models" (liste d'objets avec "name" ou "model").
    """
    if not isinstance(tags_data, dict) or not model_id:
        return False
    models: List[Dict[str, Any]] = tags_data.get("models", [])
    if not isinstance(models, list):
        return False
    mid = (model_id or "").strip()
    for m in models:
        name = (m.get("name") or m.get("model") or "").strip()
        if name == mid:
            return True
        # Match sans tag :latest (ex. "llama3" match "llama3:latest")
        if name == f"{mid}:latest" or (mid.endswith(":latest") and name == mid[:-7]):
            return True
    return False


def invalidate(model_id: str) -> None:
    """
    Retire du cache toute entrée pour ce model_id.
    À appeler après un delete admin pour forcer une re-vérification.
    """
    if not model_id:
        return
    mid = (model_id or "").strip()
    to_remove = [k for k in _cache if k[1] == mid]
    for k in to_remove:
        _cache.pop(k, None)
