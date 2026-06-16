"""
Store de métriques partagé pour tous les providers (llamacpp, lm_studio, ollama, openrouter).

Historique : chaque provider avait sa propre copie de `last_metrics.py`, near-duplicate
mais DÉRIVÉE (schémas différents, champs en plus/en moins, précédence tok/s incohérente).
L'audit a relevé ce drift. Ce module fournit UNE seule implémentation thread-safe,
union de toutes les fonctionnalités, dont chaque `last_metrics.py` devient une façade mince.

Fonctionnalités (toutes optionnelles à la construction, pour coller au contrat de chaque provider) :
- store global   : last_generation_tokens_per_second / last_prompt_tokens /
                   last_generation_tokens / last_activity_ts (+ champs étendus OpenRouter).
- index by_model : métriques par model_id (llamacpp, openrouter).
- index by_provider : métriques par upstream provider + calls_count (openrouter).
- in-flight      : compteur par model_id (llamacpp, openrouter).

Précédence tok/s : "server-first" — on préfère le `tokens_per_second` rapporté par le
serveur (temps de génération pur) au calcul wall-clock (out / durée). Cf. update_from_openai_usage.
NOTE : OpenRouter n'a JAMAIS exposé `tokens_per_second` dans son usage et faisait du
wall-clock pur ; update_rich() préserve donc ce comportement (pas de server-tps là-bas).

Verbose logging : chaque mutation logge en DEBUG (timings, model, champs dérivés) et
chaque incohérence détectée (compteur in-flight négatif) logge en WARNING.
"""
import logging
import threading
import time
from typing import Any, Dict, Iterable, Optional

logger = logging.getLogger("mercury.metrics_store")

# Champs de base présents dans TOUS les stores globaux.
_BASE_FIELDS = (
    "last_generation_tokens_per_second",
    "last_prompt_tokens",
    "last_generation_tokens",
    "last_activity_ts",
)


class MetricsStore:
    """
    Store thread-safe de métriques d'inférence pour un provider.

    Args:
        name: identifiant pour les logs (ex. "llamacpp", "openrouter").
        extra_global_fields: champs additionnels dans le store global au-delà des 4 de base
            (OpenRouter : last_provider/last_status/last_ttfb_ms/last_total_ms).
        track_by_model: active l'index par model_id.
        track_by_provider: active l'index par upstream provider (avec calls_count).
        track_inflight: active le compteur in-flight par model_id.
        expose_inflight_in_get: inclut la clé "in_flight" dans get() (OpenRouter le veut ;
            llamacpp NON — il garde le tracker actif mais l'expose via is_inferencing /
            get_inflight_snapshot uniquement, jamais dans le dict de get()).
    """

    def __init__(
        self,
        name: str,
        *,
        extra_global_fields: Iterable[str] = (),
        track_by_model: bool = False,
        track_by_provider: bool = False,
        track_inflight: bool = False,
        expose_inflight_in_get: bool = False,
    ) -> None:
        self._name = name
        self._log = logging.getLogger(f"mercury.{name}.last_metrics")
        # Ordre stable : base puis extras (dédupliqués en préservant l'ordre).
        seen: Dict[str, None] = {}
        for f in (*_BASE_FIELDS, *extra_global_fields):
            seen.setdefault(f, None)
        self._global_fields = tuple(seen.keys())
        self._extra_fields = tuple(f for f in self._global_fields if f not in _BASE_FIELDS)

        self._lock = threading.Lock()
        self._store: Dict[str, Any] = {f: None for f in self._global_fields}
        self._track_by_model = track_by_model
        self._track_by_provider = track_by_provider
        self._track_inflight = track_inflight
        self._expose_inflight_in_get = expose_inflight_in_get
        self._by_model: Dict[str, Dict[str, Any]] = {}
        self._by_provider: Dict[str, Dict[str, Any]] = {}
        self._in_flight: Dict[str, int] = {}
        self._log.debug(
            "MetricsStore init: name=%s fields=%s by_model=%s by_provider=%s inflight=%s",
            name, self._global_fields, track_by_model, track_by_provider, track_inflight,
        )

    # ------------------------------------------------------------------ helpers

    def _empty_model_metrics(self) -> Dict[str, Any]:
        """Squelette d'une entrée by_model : mêmes champs que le store global."""
        return {f: None for f in self._global_fields}

    def _empty_provider_metrics(self) -> Dict[str, Any]:
        """Squelette d'une entrée by_provider : champs globaux SANS last_provider + calls_count."""
        d = {f: None for f in self._global_fields if f != "last_provider"}
        d["calls_count"] = 0
        return d

    @staticmethod
    def _usage_tokens(usage: dict) -> tuple[Optional[int], Optional[int]]:
        """Extrait (prompt_tokens, completion_tokens) d'un usage style OpenAI (alias input/output)."""
        inp = usage.get("prompt_tokens") or usage.get("input_tokens")
        out = usage.get("completion_tokens") or usage.get("output_tokens")
        inp_i = int(inp) if inp is not None else None
        out_i = int(out) if out is not None else None
        return inp_i, out_i

    @staticmethod
    def _tps_server_first(usage: dict, out: Optional[int], duration_seconds: Optional[float]) -> Optional[float]:
        """
        Précédence tok/s : serveur d'abord (génération pure), sinon wall-clock, sinon None.
        Renvoie une valeur arrondie à 2 décimales ou None.
        """
        server_tps = usage.get("tokens_per_second")
        if server_tps is not None:
            return round(float(server_tps), 2)
        if duration_seconds and duration_seconds > 0 and out is not None:
            return round(float(out) / duration_seconds, 2)
        return None

    # --------------------------------------------------- mutation: OpenAI usage

    def update_from_openai_usage(
        self,
        usage: Optional[dict],
        duration_seconds: Optional[float] = None,
        model_id: Optional[str] = None,
    ) -> None:
        """
        Met à jour le store depuis un usage OpenAI (prompt_tokens/completion_tokens).
        Applique la précédence server-tps-first. Touche by_model si activé et model_id fourni.
        Toujours rafraîchit last_activity_ts, même sans usage.
        """
        with self._lock:
            now = time.time()
            self._store["last_activity_ts"] = now
            mid = (model_id or "").strip() or None
            target_model: Optional[Dict[str, Any]] = None
            if self._track_by_model and mid:
                target_model = self._by_model.setdefault(mid, self._empty_model_metrics())
                target_model["last_activity_ts"] = now
            if not usage:
                self._log.debug("update_from_openai_usage: no usage, ts only (model=%s)", mid)
                return
            inp, out = self._usage_tokens(usage)
            tps = self._tps_server_first(usage, out, duration_seconds)
            self._store["last_prompt_tokens"] = inp
            self._store["last_generation_tokens"] = out
            self._store["last_generation_tokens_per_second"] = tps
            if target_model is not None:
                target_model["last_prompt_tokens"] = inp
                target_model["last_generation_tokens"] = out
                target_model["last_generation_tokens_per_second"] = tps
            self._log.debug(
                "update_from_openai_usage: model=%s prompt=%s gen=%s tps=%s dur=%ss",
                mid, inp, out, tps, duration_seconds,
            )

    # ------------------------------------------------- mutation: native Ollama

    @staticmethod
    def _native_get_int(obj: dict, *keys: str) -> Optional[int]:
        """Première clé int-compatible (top-level ou sous obj['message'])."""
        for k in keys:
            v = obj.get(k)
            if v is None and isinstance(obj.get("message"), dict):
                v = obj["message"].get(k)
            if v is not None:
                try:
                    return int(v) if not isinstance(v, dict) else v.get("count")
                except (TypeError, ValueError):
                    pass
        return None

    def set_from_native_ollama(self, obj: Optional[dict]) -> None:
        """
        Extrait prompt_eval_count / eval_count / eval_duration (ns) d'une réponse Ollama native.
        Convertit eval_duration en tok/s (durée en ns, ou en secondes si < 1e6).
        """
        if not obj:
            return
        inp = self._native_get_int(obj, "prompt_eval_count", "input_tokens")
        out = obj.get("eval_count")
        if isinstance(out, dict):
            out = out.get("count")
        if out is None:
            out = (obj.get("message") or {}).get("eval_count") or obj.get("completion_eval_count")
        if isinstance(out, dict):
            out = out.get("count")
        try:
            out = int(out) if out is not None else None
        except (TypeError, ValueError):
            out = None
        eval_duration_ns = obj.get("eval_duration")
        if eval_duration_ns is None and isinstance(obj.get("message"), dict):
            eval_duration_ns = obj["message"].get("eval_duration")
        # durée en ns (Ollama) ou en secondes si valeur < 1e6 → reconvertir en ns
        if eval_duration_ns is not None and float(eval_duration_ns) < 1e6:
            eval_duration_ns = int(float(eval_duration_ns) * 1e9)
        with self._lock:
            self._store["last_activity_ts"] = time.time()
            self._store["last_prompt_tokens"] = inp
            self._store["last_generation_tokens"] = out
            if eval_duration_ns is not None and eval_duration_ns > 0 and out is not None:
                tps = round(float(out) / (float(eval_duration_ns) / 1e9), 2)
            else:
                tps = None
            self._store["last_generation_tokens_per_second"] = tps
            self._log.debug(
                "set_from_native_ollama: prompt=%s gen=%s eval_dur_ns=%s tps=%s",
                inp, out, eval_duration_ns, tps,
            )

    # --------------------------------------------- mutation: rich (OpenRouter)

    def _apply_rich(
        self,
        target: Dict[str, Any],
        usage: Optional[dict],
        duration_seconds: Optional[float],
        provider: Optional[str],
        status: Optional[int],
        ttfb_ms: Optional[float],
        total_ms: Optional[float],
    ) -> None:
        """
        Applique un set de métriques riches (multi-axes) à `target`.
        NOTE : wall-clock pur pour tok/s (OpenRouter n'expose pas tokens_per_second) —
        comportement préservé à l'identique de l'ancien openrouter/last_metrics.py.
        Champs partiels : on ne sur-écrit pas avec None (préserve la dernière valeur connue).
        """
        if usage:
            inp, out = self._usage_tokens(usage)
            if inp is not None:
                target["last_prompt_tokens"] = inp
            if out is not None:
                target["last_generation_tokens"] = out
            if duration_seconds and duration_seconds > 0 and out is not None:
                target["last_generation_tokens_per_second"] = round(float(out) / duration_seconds, 2)
        if provider is not None and "last_provider" in target:
            target["last_provider"] = provider
        if status is not None:
            target["last_status"] = int(status)
        if ttfb_ms is not None:
            target["last_ttfb_ms"] = round(float(ttfb_ms), 1)
        if total_ms is not None:
            target["last_total_ms"] = round(float(total_ms), 1)

    def update_rich(
        self,
        *,
        usage: Optional[dict] = None,
        duration_seconds: Optional[float] = None,
        model_id: Optional[str] = None,
        provider: Optional[str] = None,
        status: Optional[int] = None,
        ttfb_ms: Optional[float] = None,
        total_ms: Optional[float] = None,
    ) -> None:
        """
        Enregistre un appel multi-axes (global + by_model + by_provider). Utilisé par OpenRouter.
        Succès ou échec (status peut être un code d'erreur). by_provider incrémente calls_count.
        """
        with self._lock:
            now = time.time()
            self._store["last_activity_ts"] = now
            self._apply_rich(self._store, usage, duration_seconds, provider, status, ttfb_ms, total_ms)
            mid = (model_id or "").strip() or None
            if self._track_by_model and mid:
                tm = self._by_model.setdefault(mid, self._empty_model_metrics())
                tm["last_activity_ts"] = now
                self._apply_rich(tm, usage, duration_seconds, provider, status, ttfb_ms, total_ms)
            prov = (provider or "").strip() or None
            if self._track_by_provider and prov:
                tp = self._by_provider.setdefault(prov, self._empty_provider_metrics())
                tp["last_activity_ts"] = now
                tp["calls_count"] += 1
                # provider=None ici : le nom est la clé, pas un champ de l'entrée.
                self._apply_rich(tp, usage, duration_seconds, None, status, ttfb_ms, total_ms)
            self._log.debug(
                "update_rich: model=%s provider=%s status=%s ttfb=%s total=%s dur=%s",
                mid, prov, status, ttfb_ms, total_ms, duration_seconds,
            )

    # ----------------------------------------------------------------- readers

    def get(self) -> Dict[str, Any]:
        """
        Copie défensive du store global. Inclut by_model / by_provider / in_flight
        UNIQUEMENT pour les axes activés à la construction (préserve le shape par provider).
        """
        with self._lock:
            out = self._store.copy()
            if self._track_by_model:
                out["by_model"] = {k: v.copy() for k, v in self._by_model.items()}
            if self._track_by_provider:
                out["by_provider"] = {k: v.copy() for k, v in self._by_provider.items()}
            if self._expose_inflight_in_get:
                out["in_flight"] = dict(self._in_flight)
            return out

    # ---------------------------------------------------------------- in-flight

    def inflight_enter(self, model_id: Optional[str]) -> None:
        """Incrémente le compteur in-flight pour ce model_id. No-op si tracker désactivé ou model_id vide."""
        if not self._track_inflight:
            return
        mid = (model_id or "").strip()
        if not mid:
            return
        with self._lock:
            self._in_flight[mid] = self._in_flight.get(mid, 0) + 1
            self._log.debug("inflight_enter: model=%s count=%d", mid, self._in_flight[mid])

    def inflight_exit(self, model_id: Optional[str]) -> None:
        """Décrémente le compteur in-flight (clamp ≥ 0, nettoie l'entrée à zéro). WARNING si négatif."""
        if not self._track_inflight:
            return
        mid = (model_id or "").strip()
        if not mid:
            return
        with self._lock:
            cur = self._in_flight.get(mid, 0) - 1
            if cur <= 0:
                self._in_flight.pop(mid, None)
                if cur < 0:
                    # Décrément sans enter correspondant — bug d'instrumentation.
                    self._log.warning(
                        "inflight_exit: counter went negative for model=%s (now clamped to 0)", mid
                    )
            else:
                self._in_flight[mid] = cur
            self._log.debug("inflight_exit: model=%s count=%d", mid, max(cur, 0))

    def is_inferencing(self, model_id: Optional[str]) -> bool:
        """True si au moins un appel est en cours pour ce model_id."""
        if not self._track_inflight:
            return False
        mid = (model_id or "").strip()
        if not mid:
            return False
        with self._lock:
            return self._in_flight.get(mid, 0) > 0

    def get_inflight_snapshot(self) -> Dict[str, int]:
        """Snapshot du compteur in-flight (debug / health)."""
        with self._lock:
            return dict(self._in_flight)
