"""Sérialisation JSON pour les logs (troncature)."""
import json

_DEBUG_JSON_MAX = 4000


def debug_json(obj, max_len: int | None = None) -> str:
    """Sérialise un objet pour les logs debug (tronqué sauf si debug_full_json)."""
    if max_len is None:
        max_len = _DEBUG_JSON_MAX
        try:
            from routing.router import get_config
            if get_config().get("debug_full_json"):
                max_len = 10_000_000
        except Exception:
            pass
    try:
        s = json.dumps(obj, ensure_ascii=False)
        if max_len <= 0 or len(s) <= max_len:
            return s
        return s[:max_len] + "..."
    except Exception:
        return str(obj)[:max_len] if max_len > 0 else str(obj)


class LazyDebugJson:
    """Wrapper lazy pour debug_json — la sérialisation n'a lieu que si __str__ est appelé.
    Utilisation : logger.debug("body: %s", LazyDebugJson(body))
    Si le log level n'est pas actif, json.dumps n'est jamais exécuté."""
    __slots__ = ("_obj",)

    def __init__(self, obj):
        self._obj = obj

    def __str__(self):
        return debug_json(self._obj)


lazy_json = LazyDebugJson
