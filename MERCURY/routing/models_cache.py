"""
Cache dynamique des modèles disponibles (Ollama, LM Studio, MLX).
GET /api/tags retourne ce cache ; le routage utilise le cache pour (backend, backend_model_id).
Permet load/unload à la demande : on rafraîchit le cache pour refléter l'état des backends.
Normalisation des noms pour matcher des formats différents (ex. qwen/qwen3.5:9b <-> qwen3.5-9b).
"""
import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

# Cache : liste pour /api/tags + index par name + par normalized pour resolve + updated_at_iso
_cache: Dict[str, Any] = {
    "models": [],
    "by_name": {},
    "by_normalized": {},
    "updated_at": 0.0,
    "updated_at_iso": "",
}

# Compteur de génération du cache : incrémenté à chaque flush_cache(). refresh() capture
# la génération à son début et n'écrit son résultat que si elle n'a pas changé entre-temps.
# Évite qu'un refresh concurrent (lancé avant le flush) ré-écrive un état périmé APRÈS un
# flush admin (load/unload/hidden/toggles) — annulant silencieusement le flush. Un lock ne
# suffirait pas : le flush peut tomber dans le `await` réseau entre le fetch et le writeback.
_cache_generation: int = 0


def flush_cache() -> None:
    """Vide entièrement le cache des modèles (force un refresh complet au prochain appel)."""
    global _cache_generation
    _cache_generation += 1
    _cache["models"] = []
    _cache["by_name"] = {}
    _cache["by_normalized"] = {}
    _cache["updated_at"] = 0.0
    _cache["updated_at_iso"] = ""


def get_loaded_models() -> Dict[str, Dict[str, Any]]:
    """Accessor public sur l'index by_name (snapshot des modèles actuellement chargés
    sur tous les backends, populé par refresh()). Utilisé par scheduler pour snapshot/restore."""
    return dict(_cache.get("by_name") or {})


# Single-flight refresh : une seule tâche refresh() en vol à la fois, partagée par tous
# les appelants (background ET ceux qui doivent attendre le résultat). Évite que des appels
# concurrents sur un cache vide/périmé (ex. /api/tags + /v1/responses en parallèle) lancent
# chacun un poll complet des backends. Le `_refresh_task` enveloppe directement refresh(),
# donc son résultat awaité est le by_name frais (et il propage l'éventuelle exception à
# l'appelant qui l'attend, contrairement à l'ancien _background_refresh qui l'avalait).
_refresh_task: Optional["asyncio.Task[Dict[str, Dict[str, Any]]]"] = None


def normalize_model_id(model_id: str) -> str:
    """
    Normalise un identifiant de modèle pour le matching (ex. client "qwen/qwen3.5:9b" ↔ LM Studio "qwen3.5-9b").
    Délègue à routing.backend_ids.normalize_for_matching pour une seule source de vérité.
    """
    from routing.backend_ids import normalize_for_matching
    return normalize_for_matching(model_id)


def get_cached_models() -> List[Dict[str, Any]]:
    """Retourne la liste pour GET /api/tags : [{ name, modified_at, size }, ...]."""
    return list(_cache.get("models", []))


def is_embedding_model(name: str) -> bool:
    """
    True si le modèle doit être exclu du mode auto (modèles d'embedding).
    Match "embedding" (ex. text-embedding-*) ET "embed" (ex. nomic-embed-text,
    mxbai-embed-large) — la docstring annonçait nomic-embed-text mais l'ancien
    test "embedding in" ne matchait que les variantes complètes.
    """
    s = (name or "").lower()
    return "embedding" in s or "-embed" in s or s.startswith("embed-")


def get_available_chat_model_names(
    priority_order: Optional[List[str]] = None,
    model_priority: Optional[Dict[str, List[str]]] = None,
    hidden_models: Optional[Any] = None,
    prefer_loaded: bool = False,
) -> List[str]:
    """
    Liste des noms de modèles chat disponibles (hors embedding).
    Ordre par défaut : 1) priorité provider (priority_order), 2) au sein de chaque provider, priorité modèle
    (model_priority[backend]).
    - priority_order : ordre des backends (ex. ["ollama", "lm_studio", "mlx", "openrouter]).
    - model_priority : dict {backend: [model_name, ...]} ordre des modèles par backend.
    - hidden_models : set ou liste de noms à exclure (modèles masqués dans le dashboard).
    - prefer_loaded : si True, ne garde en tête de liste que les modèles marqués loaded=True dans le cache si au moins
      un modèle chargé est présent ; sinon, on retombe sur l'ordre classique.
    """
    by_name = _cache.get("by_name") or {}
    names = [n for n in by_name if not is_embedding_model(n)]
    if hidden_models:
        hidden_set = set(hidden_models) if not isinstance(hidden_models, set) else hidden_models
        names = [n for n in names if n not in hidden_set]
    if not names:
        return []

    # Si demandé, filtrer en priorité sur les modèles déjà chargés (ex. LM Studio loaded_instances > 0)
    if prefer_loaded:
        loaded_names = []
        for n in names:
            entry = by_name.get(n)
            if not isinstance(entry, dict):
                continue
            if entry.get("loaded"):
                loaded_names.append(n)
        if loaded_names:
            names = loaded_names

    by_backend: Dict[str, List[str]] = {}
    for n in names:
        entry = by_name.get(n)
        backend = (entry.get("backend") or "").strip() if isinstance(entry, dict) else ""
        if backend not in by_backend:
            by_backend[backend] = []
        by_backend[backend].append(n)
    backends_order: List[str] = list(priority_order) if priority_order and len(priority_order) >= 2 else sorted(by_backend)
    result: List[str] = []
    seen = set()
    for backend in backends_order:
        if backend not in by_backend:
            continue
        seen.add(backend)
        models_b = by_backend[backend]
        order_b = (model_priority or {}).get(backend) if isinstance(model_priority, dict) else None
        if order_b:
            ordered = [m for m in order_b if m in models_b]
            rest = [m for m in models_b if m not in order_b]
            result.extend(ordered + rest)
        else:
            result.extend(sorted(models_b))
    for backend in sorted(by_backend):
        if backend not in seen:
            models_b = by_backend[backend]
            order_b = (model_priority or {}).get(backend) if isinstance(model_priority, dict) else None
            if order_b:
                ordered = [m for m in order_b if m in models_b]
                rest = [m for m in models_b if m not in order_b]
                result.extend(ordered + rest)
            else:
                result.extend(sorted(models_b))
    return result


def get_first_available_chat_model_for_backend(
    backend: str,
    model_priority: Optional[Dict[str, List[str]]] = None,
    hidden_models: Optional[Any] = None,
    prefer_loaded: bool = False,
) -> Optional[str]:
    """
    Retourne le nom complet du premier modèle chat disponible pour ce backend
    (ex. "ollama/llama3.2"). Utilisé pour résoudre "ollama/ollama" / "lm_studio/lm_studio".
    Les modèles masqués (hidden_models) sont exclus.
    Si prefer_loaded=True, les modèles déjà chargés/en cours d'exécution sont mis en tête.
    """
    by_name = _cache.get("by_name") or {}
    models_b: List[str] = []
    hidden_set = set(hidden_models) if hidden_models and not isinstance(hidden_models, set) else (hidden_models or set())
    for n, entry in by_name.items():
        if is_embedding_model(n):
            continue
        if n in hidden_set:
            continue
        b = (entry.get("backend") or "").strip() if isinstance(entry, dict) else ""
        if b == backend:
            models_b.append(n)
    if not models_b:
        return None
    order_b = (model_priority or {}).get(backend) if isinstance(model_priority, dict) else None
    if order_b:
        ordered = [m for m in order_b if m in models_b]
        rest = [m for m in models_b if m not in order_b]
        models_b = ordered + rest
    else:
        models_b = sorted(models_b)
    if prefer_loaded:
        loaded = [m for m in models_b if (by_name.get(m) or {}).get("loaded")]
        not_loaded = [m for m in models_b if m not in set(loaded)]
        models_b = loaded + not_loaded
    return models_b[0] if models_b else None


def get_cached_backend_model(name: str) -> Optional[Tuple[str, str]]:
    """
    Retourne (backend, backend_model_id) si le modèle est dans le cache, sinon None.
    Utilisé par router.resolve_model() en priorité sur model_mapping / model_routes.
    """
    name = (name or "").strip()
    by_name = _cache.get("by_name") or {}
    entry = by_name.get(name)
    if not entry or not isinstance(entry, dict):
        return None
    backend = (entry.get("backend") or "").strip()
    backend_id = (entry.get("backend_model_id") or name).strip()
    if backend and backend_id:
        return (backend, backend_id)
    return None


def get_cached_backend_model_by_normalized(normalized_key: str) -> Optional[Tuple[str, str]]:
    """
    Retourne (backend, backend_model_id) si un modèle du cache a cette clé normalisée.
    Permet de matcher "qwen/qwen3.5:9b" (normalized "qwen3.5-9b") avec "qwen3.5-9b" côté LM Studio.
    """
    if not normalized_key or not isinstance(normalized_key, str):
        return None
    key = normalized_key.strip().lower()
    by_norm = _cache.get("by_normalized") or {}
    entry = by_norm.get(key)
    if not entry or not isinstance(entry, dict):
        return None
    backend = (entry.get("backend") or "").strip()
    backend_id = (entry.get("backend_model_id") or "").strip()
    if backend and backend_id:
        return (backend, backend_id)
    return None


def get_cache_state() -> Dict[str, Any]:
    """État du cache pour le frontend : count, updated_at (ISO)."""
    models = _cache.get("models") or []
    return {
        "count": len(models),
        "updated_at": _cache.get("updated_at_iso") or "",
    }


def get_cached_models_for_admin() -> List[Dict[str, Any]]:
    """Liste pour le dashboard : [{ name, modified_at, size, backend? }, ...] (sans déclencher de refresh)."""
    by_name = _cache.get("by_name") or {}
    result = []
    for name, entry in by_name.items():
        if not isinstance(entry, dict):
            continue
        result.append({
            "name": name,
            "modified_at": entry.get("modified_at", ""),
            "size": entry.get("size", 0),
            "backend": entry.get("backend", ""),
            "loaded": bool(entry.get("loaded")),
        })
    return result


def get_cached_models_with_normalized() -> List[Dict[str, Any]]:
    """Liste pour le dashboard mapping : name, backend, backend_model_id, normalized."""
    by_name = _cache.get("by_name") or {}
    result = []
    for name, entry in by_name.items():
        if not isinstance(entry, dict):
            continue
        bid = (entry.get("backend_model_id") or name).strip()
        result.append({
            "name": name,
            "backend": entry.get("backend", ""),
            "backend_model_id": bid,
            "normalized": normalize_model_id(bid),
        })
    return result


def is_stale(ttl_seconds: float) -> bool:
    """True si le cache est vide ou plus vieux que ttl_seconds."""
    if ttl_seconds <= 0:
        return True
    updated = _cache.get("updated_at") or 0
    return not _cache.get("models") or (time.monotonic() - updated) > ttl_seconds


async def refresh(config: dict) -> Dict[str, Dict[str, Any]]:
    """
    Interroge les backends activés, met à jour le cache, retourne l'index by_name
    { name: { name, backend, backend_model_id, modified_at, size, loaded? } }.
    Retourne by_name (pas la liste slim models) pour que les appelants (scheduler) disposent
    de l'état chargé MÊME si un flush concurrent a fait jeter le writeback cache (gen-counter).
    """
    from providers.http_client import get_client
    timeout = float(config.get("backend_timeout", 300))
    # Timeout court pour le refresh (pas besoin d'attendre 300s une réponse de /api/tags)
    refresh_timeout = min(timeout, 15.0)
    client = get_client("models_cache", timeout=refresh_timeout)
    # Génération capturée AVANT tout fetch réseau : si un flush_cache() survient pendant
    # le refresh (dans un `await` ci-dessous), la génération change et on jette le résultat
    # périmé au lieu d'écraser le flush.
    gen_at_start = _cache_generation
    models: List[Dict[str, Any]] = []
    by_name: Dict[str, Dict[str, Any]] = {}

    if config.get("ollama_enabled", True):
        ollama_url = (config.get("ollama_url") or "http://localhost:11434").rstrip("/")
        ollama_running: set[str] = set()
        try:
            ps_r = await client.get(f"{ollama_url}/api/ps")
            if ps_r.status_code == 200:
                ps_data = ps_r.json()
                for rm in ps_data.get("models") or []:
                    rn = rm.get("name") or rm.get("model") or ""
                    if rn:
                        ollama_running.add(rn)
        except Exception:
            pass
        try:
            r = await client.get(f"{ollama_url}/api/tags")
            if r.status_code == 200:
                data = r.json()
                for m in data.get("models") or []:
                    name = m.get("name") or m.get("model") or "unknown"
                    display_name = f"ollama/{name}"
                    entry = {
                        "name": display_name,
                        "backend": "ollama",
                        "backend_model_id": name,
                        "modified_at": m.get("modified_at", ""),
                        "size": m.get("size", 0),
                        "loaded": name in ollama_running,
                    }
                    models.append({"name": display_name, "modified_at": entry["modified_at"], "size": entry["size"]})
                    by_name[display_name] = entry
        except Exception as e:
            logger.warning("models_cache refresh (Ollama): %s", e)

    if config.get("lm_studio_enabled", True):
        lm_studio_url = (config.get("lm_studio_url") or "http://localhost:1234").rstrip("/")
        try:
            r = await client.get(f"{lm_studio_url}/api/v1/models")
            if r.status_code == 200:
                data = r.json()
                items = data.get("models", data.get("data", [])) if isinstance(data, dict) else data or []
                if not isinstance(items, list):
                    items = []
                for m in items:
                    mid = m.get("key") or m.get("id") or m.get("name")
                    if isinstance(mid, dict):
                        mid = mid.get("key") or mid.get("id") or "unknown"
                    if not mid:
                        continue
                    display_name = f"lm_studio/{mid}"
                    loaded = bool(m.get("loaded_instances"))
                    entry = {
                        "name": display_name,
                        "backend": "lm_studio",
                        "backend_model_id": mid,
                        "modified_at": m.get("modified_at", m.get("created_at", "")),
                        "size": m.get("size_bytes", m.get("size", 0)),
                        "loaded": loaded,
                    }
                    models.append({
                        "name": display_name,
                        "modified_at": entry["modified_at"],
                        "size": entry["size"],
                    })
                    by_name[display_name] = entry
        except Exception as e:
            logger.warning("models_cache refresh (LM Studio): %s", e)

    if config.get("mlx_enabled", True):
        mlx_url = (config.get("mlx_url") or "http://localhost:8080").rstrip("/")
        try:
            r = await client.get(f"{mlx_url}/v1/models")
            if r.status_code == 200:
                data = r.json()
                for m in data.get("data", []):
                    mid = m.get("id") or "unknown"
                    display_name = f"mlx/{mid}"
                    entry = {
                        "name": display_name,
                        "backend": "mlx",
                        "backend_model_id": mid,
                        "modified_at": "",
                        "size": 0,
                    }
                    models.append({"name": display_name, "modified_at": "", "size": 0})
                    by_name[display_name] = entry
        except Exception as e:
            logger.warning("models_cache refresh (MLX): %s", e)

    # llamacpp + vllm + lucebox partagent le brain-daemon (port 4321). On split par :
    #   - `kind` exposé dans /v1/models du daemon : "hf" → vllm, "gguf" → soit
    #     llamacpp soit lucebox (les deux servent des GGUF).
    #   - le template Mercury DB : si `template.load.backend === 'native-lucebox'`,
    #     le GGUF est classé lucebox. Lucebox n'expose pas son propre /api/tags,
    #     donc cette jointure est la seule source de vérité pour le distinguer.
    # Chaque provider doit être enabled pour récupérer sa slice (sinon le modèle
    # disparaît de la liste publique).
    llamacpp_enabled = config.get("llamacpp_enabled", True)
    vllm_enabled = config.get("vllm_enabled", False)
    lucebox_enabled = config.get("lucebox_enabled", False)
    if llamacpp_enabled or vllm_enabled or lucebox_enabled:
        llamacpp_url = (config.get("llamacpp_url") or "http://localhost:4321").rstrip("/")
        try:
            # Templates Mercury : nécessaires pour classer les GGUF lucebox.
            # Lookup local DB, pas de risque réseau.
            try:
                from data import db as db_module
                templates = db_module.get_llamacpp_templates() or {}
            except Exception as _e:
                logger.warning("models_cache: lookup templates failed: %s", _e)
                templates = {}

            r = await client.get(f"{llamacpp_url}/v1/models")
            if r.status_code == 200:
                data = r.json()
                for m in data.get("data", []):
                    mid = m.get("id") or "unknown"
                    kind = (m.get("kind") or "gguf").lower()
                    tpl_backend = (((templates.get(mid) or {}).get("load") or {}).get("backend") or "")
                    if kind == "hf":
                        if not vllm_enabled:
                            continue
                        backend = "vllm"
                        display_name = f"vllm/{mid}"
                    elif tpl_backend == "native-lucebox":
                        if not lucebox_enabled:
                            continue
                        backend = "lucebox"
                        display_name = f"lucebox/{mid}"
                    else:
                        if not llamacpp_enabled:
                            continue
                        backend = "llamacpp"
                        display_name = f"llamacpp/{mid}"
                    entry = {
                        "name": display_name,
                        "backend": backend,
                        "backend_model_id": mid,
                        "modified_at": "",
                        "size": int(float(m.get("size_gb", 0)) * 1e9),
                        "loaded": bool(m.get("running", False)),
                    }
                    models.append({
                        "name": display_name,
                        "modified_at": "",
                        "size": entry["size"],
                    })
                    by_name[display_name] = entry
        except Exception as e:
            logger.warning("models_cache refresh (llamacpp/vllm/lucebox): %s", e)

    # Provider web OpenRouter : liste des modèles (tous providers côté OpenRouter)
    if config.get("openrouter_enabled") and (config.get("openrouter_api_key") or "").strip():
        openrouter_api_key = (config.get("openrouter_api_key") or "").strip()
        try:
            openrouter_models_url = "https://openrouter.ai/api/v1/models"
            r = await client.get(
                openrouter_models_url,
                headers={"Authorization": f"Bearer {openrouter_api_key}"},
            )
            if r.status_code == 200:
                data = r.json() if r.content else {}
                items = data.get("data", []) if isinstance(data, dict) else data or []
                if not isinstance(items, list):
                    items = []
                for m in items:
                    mid = (m.get("id") if isinstance(m, dict) else None) or ""
                    mid = mid.strip()
                    if not mid:
                        continue
                    display_name = f"openrouter/{mid}"
                    if display_name in by_name:
                        continue
                    entry = {
                        "name": display_name,
                        "backend": "openrouter",
                        "backend_model_id": mid,
                        "modified_at": "",
                        "size": 0,
                    }
                    models.append({"name": display_name, "modified_at": "", "size": 0})
                    by_name[display_name] = entry
        except Exception as e:
            logger.warning("models_cache refresh (OpenRouter): %s", e)

    # Index par clé normalisée pour le matching intelligent (ex. qwen/qwen3.5:9b -> qwen3.5-9b)
    by_normalized: Dict[str, Dict[str, Any]] = {}
    for entry in by_name.values():
        if not isinstance(entry, dict):
            continue
        bid = (entry.get("backend_model_id") or "").strip()
        if not bid:
            continue
        key = normalize_model_id(bid)
        if key and key not in by_normalized:
            by_normalized[key] = entry

    # Garde anti-race : un flush_cache() pendant ce refresh a incrémenté la génération.
    # Le résultat reflète l'état d'AVANT le flush → on le jette pour ne pas annuler le flush.
    # (Pas de yield entre ce check et le writeback : sûr sur l'event loop mono-thread.)
    if _cache_generation != gen_at_start:
        logger.info(
            "models_cache refresh: flush concurrent détecté (gen %s→%s), résultat périmé jeté (%s modèles)",
            gen_at_start, _cache_generation, len(models),
        )
        return by_name

    _cache["models"] = models
    _cache["by_name"] = by_name
    _cache["by_normalized"] = by_normalized
    _cache["updated_at"] = time.monotonic()
    _cache["updated_at_iso"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    logger.info("models_cache refresh: %s modèles", len(models))
    return by_name


def _get_or_start_refresh_task(config: dict) -> "asyncio.Task[Dict[str, Dict[str, Any]]]":
    """Retourne la tâche refresh() en vol, ou en démarre une nouvelle (single-flight).
    La tâche enveloppe directement refresh() : son résultat est le by_name frais.
    Source unique de vérité du single-flight pour refresh_in_background ET refresh_shared."""
    global _refresh_task
    if _refresh_task is not None and not _refresh_task.done():
        return _refresh_task  # Refresh déjà en cours : on partage la même tâche
    task = asyncio.create_task(refresh(config))
    # Consomme l'exception côté tâche pour les appelants fire-and-forget
    # (refresh_in_background, qui n'await jamais la tâche) : sinon asyncio loggue
    # "Task exception was never retrieved" au GC. N'empêche PAS refresh_shared de
    # la ré-lever via son propre `await task` (le callback ne fait que la "retrieve").
    def _consume_exc(t: "asyncio.Task[Dict[str, Dict[str, Any]]]") -> None:
        if not t.cancelled() and t.exception() is not None:
            logger.debug("Background models_cache refresh: %s", t.exception())
    task.add_done_callback(_consume_exc)
    _refresh_task = task
    return _refresh_task


async def refresh_in_background(config: dict) -> None:
    """Lance un refresh en background si aucun n'est déjà en cours (fire-and-forget).
    Ne bloque pas l'appelant — le cache sera mis à jour quand le refresh se termine.
    Partage la tâche single-flight avec refresh_shared() : un refresh_shared() concurrent
    réutilise cette tâche au lieu d'en lancer un second."""
    _get_or_start_refresh_task(config)


async def refresh_shared(config: dict) -> Dict[str, Dict[str, Any]]:
    """Refresh single-flight : si un refresh est déjà en vol, attend SON résultat au lieu
    de relancer un poll complet ; sinon en démarre un et l'attend. Retourne le by_name frais.
    À utiliser par les chemins cache-périmé qui veulent juste un cache à jour sans dupliquer
    le travail (ex. GET /api/tags, POST /v1/responses lancés en parallèle).

    NB scheduler : snapshot/unload_all appellent refresh() DIRECTEMENT (pas refresh_shared)
    car ils ont besoin d'un by_name qu'ils ont eux-mêmes fetché — robuste au flush concurrent
    (gen-counter). Ne PAS les rerouter ici : un flush pendant la tâche partagée renverrait un
    by_name « jeté » côté cache et fausserait leur décision unload/restore.
    """
    task = _get_or_start_refresh_task(config)
    # await en dehors de la création : plusieurs coroutines peuvent attendre la même Task.
    # Si la tâche raise, l'exception est propagée ici à chaque awaiter (le re-await d'une
    # Task terminée en erreur re-lève la même exception — pas de double exécution du refresh).
    return await task
