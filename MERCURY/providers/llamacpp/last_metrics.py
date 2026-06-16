"""
Store des dernières métriques llamacpp (réponses proxy) pour exposition dans GET /admin/llamacpp/probe.
Thread-safe, mis à jour à chaque réponse (usage OpenAI style).
Les entrées globales reflètent la dernière requête quelconque ; by_model indexe par model_id daemon.

In-flight tracker : compteur par model_id, incrémenté au début d'un proxy chat,
décrémenté à la fin. Sert à `/admin/llamacpp/session/{model_id}` pour skip le hit
synchrone `/mgmt/slots` quand le daemon est connu busy (sinon timeout / 502 upstream
pendant l'inférence longue).

REFACTOR : ce module est désormais une FAÇADE mince au-dessus de providers.metrics_store.
L'API publique (signatures + noms) est INCHANGÉE pour ne pas casser backend.py / admin routes.
"""
from typing import Any, Dict

from providers.metrics_store import MetricsStore

# Store partagé configuré pour le profil llamacpp : global + by_model + in-flight.
_store_obj = MetricsStore("llamacpp", track_by_model=True, track_inflight=True)


def update_metrics(
    usage: dict | None,
    duration_seconds: float | None = None,
    model_id: str | None = None,
) -> None:
    """Met à jour le store à partir d'un usage OpenAI (prompt_tokens, completion_tokens)."""
    _store_obj.update_from_openai_usage(usage, duration_seconds, model_id)


def get_last_metrics() -> Dict[str, Any]:
    """Retourne une copie des dernières métriques (pour l'API admin), incluant by_model."""
    return _store_obj.get()


def inflight_enter(model_id: str | None) -> None:
    """Marque le début d'un proxy chat pour ce model_id. Idempotent vis-à-vis d'un model_id None/empty."""
    _store_obj.inflight_enter(model_id)


def inflight_exit(model_id: str | None) -> None:
    """Marque la fin (succès ou échec) d'un proxy chat pour ce model_id. Clamp ≥ 0 et nettoie quand zéro."""
    _store_obj.inflight_exit(model_id)


def is_inferencing(model_id: str | None) -> bool:
    """True si au moins un proxy chat est actuellement en cours pour ce model_id."""
    return _store_obj.is_inferencing(model_id)


def get_inflight_snapshot() -> Dict[str, int]:
    """Snapshot du compteur (pour debug / health endpoint éventuel)."""
    return _store_obj.get_inflight_snapshot()
