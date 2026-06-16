"""
Pool de clients httpx partagés pour éviter de recréer les connexions TCP/TLS à chaque requête.
Les clients sont créés paresseusement et fermés proprement via close_all() dans le lifespan.
"""
import logging
from typing import Dict, Optional

import httpx

logger = logging.getLogger("mercury.http_client")

_clients: Dict[str, httpx.AsyncClient] = {}
# Per-key first-creation kwargs snapshot — used to detect mismatched re-requests.
# We store only the keys we care to validate (timeout signature, limits) so the
# warning fires on the actual mistakes (someone added a new caller with different
# config) without false-positives on harmless kwargs.
_clients_kwargs: Dict[str, Dict[str, object]] = {}


def _timeout_signature(timeout: object) -> object:
    """Extract a comparable signature from a timeout arg (float or httpx.Timeout)."""
    if isinstance(timeout, httpx.Timeout):
        return (timeout.connect, timeout.read, timeout.write, timeout.pool)
    return timeout


def _limits_signature(limits: object) -> object:
    """Extract a comparable signature from a limits arg (httpx.Limits or None)."""
    if isinstance(limits, httpx.Limits):
        return (limits.max_connections, limits.max_keepalive_connections, limits.keepalive_expiry)
    return limits


def get_client(key: str, timeout: float = 300.0, **kwargs) -> httpx.AsyncClient:
    """Retourne un client httpx partagé (créé si nécessaire).
    key : identifiant unique (ex. 'openrouter', 'lm_studio', 'models_cache').

    DURCISSEMENT (2026-05-04) : si le client existe déjà, on compare les kwargs
    de réutilisation avec ceux du premier appel et on WARN sur tout mismatch.
    Le client retourné reste celui caché — on ne recrée pas pour respecter le
    cycle de vie partagé — mais le warn signale qu'un caller code une intention
    qui ne sera PAS honorée (ex. ajouter `limits=Limits(max_keepalive_connections=0)`
    sur un 2e caller alors que le 1er a créé sans = ce 2e caller croit avoir
    désactivé le pool, en fait non).
    """
    if key in _clients:
        existing = _clients[key]
        # Compare le snapshot des kwargs significatifs
        first_sig = _clients_kwargs.get(key, {})
        new_sig = {
            "timeout": _timeout_signature(timeout),
            "limits": _limits_signature(kwargs.get("limits")),
        }
        if first_sig and new_sig != first_sig:
            logger.warning(
                "get_client: '%s' kwargs mismatch — first=%r requested=%r. "
                "The cached client is returned AS IS; new kwargs are ignored. "
                "Either (a) all callers must pass identical kwargs, or (b) split "
                "into a distinct key, or (c) call reset_client('%s') first.",
                key, first_sig, new_sig, key,
            )
        return existing
    client = httpx.AsyncClient(timeout=timeout, **kwargs)
    _clients[key] = client
    _clients_kwargs[key] = {
        "timeout": _timeout_signature(timeout),
        "limits": _limits_signature(kwargs.get("limits")),
    }
    logger.debug("httpx client créé: %s (timeout=%.0fs, limits=%r)", key, timeout if isinstance(timeout, (int, float)) else "custom", kwargs.get("limits"))
    return client


async def close_all() -> None:
    """Ferme tous les clients partagés. Appelé dans le lifespan shutdown."""
    for key, client in list(_clients.items()):
        try:
            await client.aclose()
            logger.debug("httpx client fermé: %s", key)
        except Exception as e:
            logger.debug("Erreur fermeture httpx client %s: %s", key, e)
    _clients.clear()
    _clients_kwargs.clear()


async def reset_client(key: str) -> None:
    """Invalide un client et ferme proprement ses connexions."""
    client = _clients.pop(key, None)
    _clients_kwargs.pop(key, None)
    if client:
        try:
            await client.aclose()
            logger.debug("httpx client fermé et invalidé: %s", key)
        except Exception as e:
            logger.debug("Erreur fermeture httpx client %s: %s", key, e)
