"""
Store des dernières métriques Ollama (réponses proxy) pour exposition dans GET /admin/host-stats.
Thread-safe, mis à jour à chaque réponse Ollama (stream done ou sync).

REFACTOR : ce module est désormais une FAÇADE mince au-dessus de providers.metrics_store.
L'API publique (signatures + noms) est INCHANGÉE. Deux entrées :
- set_last_metrics(obj)           : réponse Ollama NATIVE (eval_duration en ns).
- set_last_metrics_from_openai_usage(...) : usage style OpenAI (proxy Ollama).
Profil minimal : store global seul (pas de by_model).
"""
from typing import Any, Dict

from providers.metrics_store import MetricsStore

# Store partagé configuré pour le profil Ollama : global uniquement.
_store_obj = MetricsStore("ollama")


def set_last_metrics(obj: dict) -> None:
    """Extrait prompt_eval_count, eval_count, eval_duration (ns) de la réponse Ollama et met à jour le store."""
    _store_obj.set_from_native_ollama(obj)


def set_last_metrics_from_openai_usage(usage: dict | None, duration_seconds: float | None = None) -> None:
    """Met à jour le store à partir d'un usage style OpenAI (prompt_tokens, completion_tokens, etc.). Utilisé par le proxy Ollama."""
    _store_obj.update_from_openai_usage(usage, duration_seconds)


def get_last_metrics() -> Dict[str, Any]:
    """Retourne une copie des dernières métriques (pour l'API admin)."""
    return _store_obj.get()
