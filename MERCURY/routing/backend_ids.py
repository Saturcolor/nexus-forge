"""
Préfixes et règles par backend pour dériver backend_model_id à partir du champ model.
Centralise la logique de strip de préfixe et format (ex. : → - pour LM Studio).
"""
import re
from typing import Dict, Optional, Tuple

# (préfixe principal, préfixe alternatif accepté ex. lmstudio/)
_BACKEND_PREFIXES: Dict[str, Tuple[str, str]] = {
    "ollama": ("ollama/", ""),
    "lm_studio": ("lm_studio/", "lmstudio/"),
    "mlx": ("mlx/", ""),
    "llamacpp": ("llamacpp/", ""),
    "vllm": ("vllm/", ""),
    "lucebox": ("lucebox/", ""),
    "openrouter": ("openrouter/", ""),
}


def backend_and_model_id_by_prefix(model: str) -> Optional[Tuple[str, str]]:
    """
    Si model commence par un préfixe connu (ollama/, mlx/, lm_studio/, lmstudio/, llamacpp/),
    retourne (backend, backend_model_id). Sinon None. N'inclut pas openrouter.
    """
    if not model or not isinstance(model, str):
        return None
    s = model.strip()
    for backend, (main, alt) in _BACKEND_PREFIXES.items():
        if backend == "openrouter":
            continue
        if main and s.startswith(main):
            return (backend, backend_model_id_from_request(backend, model))
        if alt and s.lower().startswith(alt):
            return (backend, backend_model_id_from_request(backend, model))
    return None


def backend_model_id_from_request(backend: str, model: str) -> str:
    """
    Retourne l'id à envoyer au backend à partir du champ model de la requête.
    - Enlève le préfixe connu (ex. ollama/, lm_studio/, lmstudio/).
    - Pour LM Studio : remplace ":" par "-" (format canonique côté client vs id LM Studio).
    """
    if not model or not isinstance(model, str):
        return (model or "").strip()
    s = model.strip()
    prefixes = _BACKEND_PREFIXES.get(backend)
    if prefixes:
        main, alt = prefixes
        if main and s.startswith(main):
            s = s[len(main):].strip()
        elif alt and s.lower().startswith(alt):
            s = s[len(alt):].strip()
    if backend == "lm_studio" and ":" in s:
        s = s.replace(":", "-")
    return s


def normalize_for_matching(model_id: str) -> str:
    """
    Normalise un identifiant pour le matching (ex. cache par clé normalisée).
    - Partie après le dernier "/", ":" → "-", supprime "@...", minuscules.
    Utilisé par models_cache pour matcher des formats différents (ex. requête client vs id LM Studio).
    """
    if not model_id or not isinstance(model_id, str):
        return ""
    s = model_id.strip().lower()
    if "/" in s:
        s = s.split("/")[-1]
    s = s.replace(":", "-")
    if "@" in s:
        s = s.split("@")[0].strip()
    s = re.sub(r"-+", "-", s).strip()
    return s
