"""
Store des dernières métriques LM Studio (réponses proxy) pour exposition dans GET /admin/host-stats.
Thread-safe, mis à jour à chaque réponse (usage OpenAI style).

REFACTOR : ce module est désormais une FAÇADE mince au-dessus de providers.metrics_store.
L'API publique (signatures + noms) est INCHANGÉE. Profil minimal : store global seul (pas de by_model).
"""
from typing import Any, Dict

from providers.metrics_store import MetricsStore

# Store partagé configuré pour le profil LM Studio : global uniquement.
_store_obj = MetricsStore("lm_studio")


def update_metrics(usage: dict | None, duration_seconds: float | None = None) -> None:
    """Met à jour le store à partir d'un usage OpenAI (prompt_tokens, completion_tokens)."""
    _store_obj.update_from_openai_usage(usage, duration_seconds)


def get_last_metrics() -> Dict[str, Any]:
    """Retourne une copie des dernières métriques (pour l'API admin)."""
    return _store_obj.get()
