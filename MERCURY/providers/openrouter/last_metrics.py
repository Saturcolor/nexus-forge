"""
Store des dernières métriques OpenRouter (réponses cloud) pour exposition
admin/dashboard. Aligné sur le pattern llamacpp/last_metrics.py.

Trois axes :
- Métriques globales (toute requête OR confondue)
- Par modèle (model_id OpenRouter, ex. "moonshotai/kimi-k2.6")
- Par provider upstream (ex. "DeepInfra", "Anthropic", "Together") — utile pour
  diagnostiquer "ce modèle a dérapé" → savoir lequel des upstreams OR routait.

In-flight tracker : compteur par model_id, incrémenté au début d'un appel,
décrémenté à la fin. Utile pour `/admin/openrouter/probe` afin de skip un
healthcheck synchrone si une inférence longue est en cours.

REFACTOR : ce module est désormais une FAÇADE mince au-dessus de providers.metrics_store.
L'API publique (signatures + noms) est INCHANGÉE. Profil riche : champs étendus
(last_provider/last_status/last_ttfb_ms/last_total_ms) + by_model + by_provider + in-flight.
NOTE : OpenRouter n'expose pas tokens_per_second → tok/s reste en wall-clock pur
(comportement préservé via MetricsStore.update_rich, pas de précédence server-tps ici).
"""
from typing import Any, Dict

from providers.metrics_store import MetricsStore

# Champs additionnels propres à OpenRouter (au-delà des 4 de base).
_EXTRA_FIELDS = ("last_provider", "last_status", "last_ttfb_ms", "last_total_ms")

# Store partagé configuré pour le profil OpenRouter : tout activé.
_store_obj = MetricsStore(
    "openrouter",
    extra_global_fields=_EXTRA_FIELDS,
    track_by_model=True,
    track_by_provider=True,
    track_inflight=True,
    expose_inflight_in_get=True,  # OpenRouter expose in_flight dans get() (contrat admin route)
)


def update_metrics(
    *,
    usage: dict | None = None,
    duration_seconds: float | None = None,
    model_id: str | None = None,
    provider: str | None = None,
    status: int | None = None,
    ttfb_ms: float | None = None,
    total_ms: float | None = None,
) -> None:
    """Enregistre les métriques d'un appel OpenRouter (succès ou échec)."""
    _store_obj.update_rich(
        usage=usage,
        duration_seconds=duration_seconds,
        model_id=model_id,
        provider=provider,
        status=status,
        ttfb_ms=ttfb_ms,
        total_ms=total_ms,
    )


def get_last_metrics() -> Dict[str, Any]:
    """Retourne une copie des métriques (pour l'API admin) : global + by_model + by_provider + in_flight."""
    return _store_obj.get()


def inflight_enter(model_id: str | None) -> None:
    """Marque le début d'un appel OpenRouter pour ce model_id."""
    _store_obj.inflight_enter(model_id)


def inflight_exit(model_id: str | None) -> None:
    """Marque la fin (succès ou échec) d'un appel OpenRouter pour ce model_id. Clamp ≥ 0."""
    _store_obj.inflight_exit(model_id)
