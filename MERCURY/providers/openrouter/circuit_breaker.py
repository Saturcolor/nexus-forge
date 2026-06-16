"""
Circuit breaker pour les providers upstream OpenRouter.

Quand un upstream OR (DeepInfra, Anthropic, Together, …) accumule des fails
en peu de temps, on l'auto-blacklist via le champ `provider.ignore` dans le
body OR. OR route alors automatiquement vers un autre upstream supporté.
Self-heal : les fails > FAILURE_WINDOW_S sont oubliés, donc une fois que le
provider va mieux, il revient dans le pool.

Pattern dérivé de Hermes (_is_payment_error / _is_connection_error pour la
typage) + concept de provider routing OR — pas de circuit breaker actif comme
ça en amont, c'est notre dérivation.

Thread-safe via threading.Lock. État process-wide, reset au restart du
process Mercury (acceptable : 5 min après restart, le breaker reapprend).
"""
import logging
import threading
import time
from collections import defaultdict
from typing import Dict, List, Set

logger = logging.getLogger("mercury.openrouter.circuit_breaker")

# Fenêtre glissante des fails. Au-delà, le fail tombe du compteur.
FAILURE_WINDOW_S = 300.0  # 5 min

# Seuil de fails dans la fenêtre pour blacklister.
# 2 = strict (un seul tolère ; deuxième fail blackliste pour 5 min).
FAILURE_THRESHOLD = 2

# Catégories d'erreur qui comptent comme un fail provider-level.
# `payment` n'est PAS comptée (c'est ton wallet OR, pas le provider upstream).
# `auth` n'est PAS comptée (clé API rejetée = config OR, pas un upstream).
# `client_error` (4xx) n'est PAS comptée (mauvais payload de notre côté).
_PROVIDER_FAIL_CATEGORIES = frozenset({
    "timeout",
    "connection",
    "server_error",  # 5xx
    "rate_limit",    # 429 — débatable mais OK : si ce provider OR rate-limit, autre upstream
    # 200 OK mais stream vide (0 completion tokens) : upstream OR qui répond mais ne
    # produit rien (observé sur GMICloud / deepseek-v4-flash, 2026-05-31). C'est un
    # fail provider-level — l'upstream est cassé, pas notre payload. Compté pour que le
    # breaker l'écarte si ça se répète dans la fenêtre.
    "empty_response",
})

_lock = threading.Lock()
_failures: Dict[str, List[float]] = defaultdict(list)


def _evict_old(now: float, ts_list: List[float]) -> List[float]:
    """Garde uniquement les timestamps dans la fenêtre courante."""
    return [t for t in ts_list if (now - t) < FAILURE_WINDOW_S]


def record_failure(provider: str | None, category: str) -> None:
    """Enregistre un fail provider-level si la catégorie est éligible.

    `provider` est le nom court OR (ex. "DeepInfra", "Anthropic"). Si None
    (souvent le cas en non-stream sur erreur 5xx où l'OR n'attache pas
    encore le provider name au body), on ne peut pas l'attribuer →
    on ne compte pas. Pas de fallback agressif.
    """
    if category not in _PROVIDER_FAIL_CATEGORIES:
        return
    if not provider:
        # Visibilité : on logue les fails non-attribués pour qu'on sache combien on perd
        # côté observabilité (les hung calls non-attribuées défaisaient le but du breaker).
        logger.info("circuit breaker: fail non-attribué (provider=None, category=%s) — pas compté", category)
        return
    now = time.time()
    with _lock:
        ts_list = _evict_old(now, _failures[provider])
        ts_list.append(now)
        _failures[provider] = ts_list
        if len(ts_list) >= FAILURE_THRESHOLD:
            logger.warning(
                "circuit breaker: %s → BLACKLISTED (%d fails in %.0fs window, category=%s)",
                provider, len(ts_list), FAILURE_WINDOW_S, category,
            )
        else:
            logger.info(
                "circuit breaker: %s fail recorded (%d/%d in window, category=%s)",
                provider, len(ts_list), FAILURE_THRESHOLD, category,
            )


def record_success(provider: str | None) -> None:
    """Une success efface complètement les fails du provider — la santé revient
    en un seul appel OK plutôt qu'attendre la fenêtre. Important quand
    DeepInfra a juste eu un hiccup ponctuel."""
    if not provider:
        return
    with _lock:
        if provider in _failures and _failures[provider]:
            old_count = len(_failures[provider])
            _failures[provider] = []
            logger.info("circuit breaker: %s recovered (%d prior fails cleared)", provider, old_count)


def get_blacklist() -> Set[str]:
    """Liste actuelle des providers à blacklister (>= FAILURE_THRESHOLD fails
    dans la fenêtre). Recomputed à chaque appel (eviction live)."""
    now = time.time()
    out: Set[str] = set()
    with _lock:
        for provider, ts_list in list(_failures.items()):
            ts_list = _evict_old(now, ts_list)
            _failures[provider] = ts_list  # persist eviction
            if len(ts_list) >= FAILURE_THRESHOLD:
                out.add(provider)
    return out


def snapshot() -> Dict[str, Dict]:
    """État courant pour observabilité (admin endpoint, debug).

    Persist l'éviction (sinon les timestamps obsolètes restent en mémoire entre
    deux mutations — léger gonflement mémoire si /admin/openrouter/health est
    polled en continu sans aucun fail enregistré entre temps)."""
    now = time.time()
    out: Dict[str, Dict] = {}
    with _lock:
        for provider, ts_list in list(_failures.items()):
            ts_list = _evict_old(now, ts_list)
            _failures[provider] = ts_list  # persist eviction
            out[provider] = {
                "fails_in_window": len(ts_list),
                "blacklisted": len(ts_list) >= FAILURE_THRESHOLD,
                "oldest_fail_ago_s": round(now - ts_list[0], 1) if ts_list else None,
            }
    return out


def reset() -> None:
    """Reset complet (admin endpoint, ou test cleanup)."""
    with _lock:
        _failures.clear()
    logger.info("circuit breaker: all providers reset")
