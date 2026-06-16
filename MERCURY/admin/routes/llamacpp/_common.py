"""Shared helpers + constants pour le package llamacpp."""
import logging
from typing import Any, Optional

import httpx

from routing.router import get_config, apply_db_overrides

logger = logging.getLogger(__name__)

DAEMON_TIMEOUT = 10.0
LOAD_TIMEOUT = 300.0


def llamacpp_base() -> str:
    config = get_config()
    if not config.get("llamacpp_enabled", True):
        return ""
    return str(config.get("llamacpp_url", "http://localhost:4321")).rstrip("/")


def _template_to_load_body(model_id: str, template: dict) -> dict:
    """Traduit le template['load'] en body pour POST /mgmt/load du daemon.

    Pour les backends vLLM (`vllm-*`) et Lucebox (`native-lucebox`), seul
    `extra_args` brut est forwardé + `ctx_size`. Tous les flags llama.cpp
    (`-fa`, `--jinja`, `-ngl`, etc.) sont skippés — ces runtimes crasheraient
    sur args inconnus. Lucebox requiert en plus `lucebox_draft` au top-level
    (chemin vers safetensors du draft model), persisté côté daemon.
    """
    load = template.get("load") or {}
    backend = load.get("backend", "native-vulkan")
    extra = [a for a in (load.get("extra_args") or []) if isinstance(a, str) and a]

    if backend.startswith("vllm-"):
        out = {
            "model_id": model_id,
            "ctx_size": load.get("ctx_size", 32768),
            "extra_args": extra,
            "backend": backend,
        }
        env_vars = load.get("env_vars")
        if isinstance(env_vars, dict) and env_vars:
            # Filtre clés/valeurs vides + cast en str (forward à brain-daemon /mgmt/load)
            cleaned = {str(k): str(v) for k, v in env_vars.items() if k and v is not None}
            if cleaned:
                out["env_vars"] = cleaned
        return out

    if backend == "native-lucebox":
        # Lucebox a son propre server.py — les flags llama.cpp-only n'ont pas de sens.
        # Args spécifiques (--budget, --cache-type-k/v, --fa-window, --draft-swa, ...)
        # passent par extra_args brut.
        out = {
            "model_id": model_id,
            "ctx_size": load.get("ctx_size", 32768),
            "extra_args": extra,
            "backend": backend,
        }
        draft = load.get("lucebox_draft")
        if isinstance(draft, str) and draft.strip():
            out["lucebox_draft"] = draft.strip()
        # Pas de fallback ici : si absent, brain-daemon retombera sur load_configs.json
        # (entrée persistée au précédent load) ou répondra 400. Mercury ne fabrique pas
        # de path par défaut — c'est au user de saisir le chemin draft une fois.
        env_vars = load.get("env_vars")
        if isinstance(env_vars, dict) and env_vars:
            cleaned = {str(k): str(v) for k, v in env_vars.items() if k and v is not None}
            if cleaned:
                out["env_vars"] = cleaned
        return out

    # ── llama.cpp backends (toolbox / native) ─────────────────────────────────
    # Les args sont ajoutés au début de extra pour que les valeurs utilisateur overrident les defaults hardcodés

    # Coerce des flags booléens connus : le template peut venir de JSON/YAML ou
    # d'une API admin qui stocke "true"/"false" comme strings. Sans coerce,
    # "false" (string non-vide) est truthy en Python → le flag serait ajouté
    # alors que l'utilisateur a bien dit False. On normalise en bool réel avant
    # tous les tests.
    _BOOL_KEYS_DEFAULTS: list[tuple[str, bool]] = [
        ("flash_attn", True),
        ("jinja", False),
        ("debug", False),
        ("no_mmap", True),
        ("unified_kv_cache", False),
        ("swa_full", False),
        ("ctx_shift", True),
        ("mlock", False),
        ("cache_idle_slots", True),
    ]
    for _bk, _bdefault in _BOOL_KEYS_DEFAULTS:
        _raw = load.get(_bk)
        if _raw is None:
            load[_bk] = _bdefault  # injecte le défaut pour que les tests ci-dessous soient cohérents
        elif not isinstance(_raw, bool):
            # Coerce str→bool (YAML/JSON peut envoyer "true"/"false"/0/1/etc.)
            if isinstance(_raw, str):
                load[_bk] = _raw.strip().lower() not in ("false", "0", "no", "off", "")
            else:
                load[_bk] = bool(_raw)

    # — Flags booléens
    if load.get("flash_attn", True):
        extra = ["-fa", "1"] + extra
    if load.get("jinja", False):
        # --jinja : active le template Jinja bundled dans le GGUF (vs template par défaut llama-server).
        # Requis pour les modèles avec chat templates avancés (tool-use, thinking, multi-turn complexes).
        extra = ["--jinja"] + extra
    if load.get("debug", False):
        # --verbose : logs détaillés du serveur (chaque requête, application du template, token counts, etc.).
        # Utile pour diagnostiquer les modèles qui partent en vrille (Mistral & co) : on voit ce que le modèle
        # reçoit en entrée, on peut diff fresh vs agentique. Logs dans le daemon llama-server.
        # Note: --verbose-prompt a été retiré dans les versions récentes de llama.cpp, on garde juste --verbose.
        extra = ["--verbose"] + extra
    if load.get("no_mmap", True):
        extra = ["--no-mmap"] + extra
    if load.get("unified_kv_cache", False):
        extra = ["--kv-unified"] + extra
    if load.get("swa_full", False):
        extra = ["--swa-full"] + extra
    if not load.get("ctx_shift", True):
        extra = ["--no-context-shift"] + extra
    if load.get("mlock", False):
        extra = ["--mlock"] + extra
    if load.get("cache_idle_slots", True) is False:
        extra = ["--no-cache-idle-slots"] + extra

    # — Cache / checkpoints (workarounds bugs Gemma-4 / hybrides SWA)
    cache_ram = load.get("cache_ram")
    if cache_ram is not None:
        extra = ["--cache-ram", str(cache_ram)] + extra
    ctx_checkpoints = load.get("ctx_checkpoints")
    if ctx_checkpoints is not None:
        extra = ["--ctx-checkpoints", str(ctx_checkpoints)] + extra

    # — Paramètres numériques principaux
    ngl = load.get("n_gpu_layers")
    if ngl is not None:
        extra = ["-ngl", str(ngl)] + extra
    extra = ["--parallel", str(load.get("parallel") or 1)] + extra

    # — Performance CPU/batch (optionnels, laisser vide = auto)
    n_batch = load.get("n_batch")
    if n_batch is not None:
        extra = ["-b", str(n_batch)] + extra
    n_ubatch = load.get("n_ubatch")
    if n_ubatch is not None:
        extra = ["-ub", str(n_ubatch)] + extra
    n_threads = load.get("n_threads")
    if n_threads is not None:
        extra = ["-t", str(n_threads)] + extra
    n_threads_batch = load.get("n_threads_batch")
    if n_threads_batch is not None:
        extra = ["-tb", str(n_threads_batch)] + extra

    # — KV cache quantization
    type_k = load.get("type_k")
    if type_k:
        extra = ["--cache-type-k", str(type_k)] + extra
    type_v = load.get("type_v")
    if type_v:
        extra = ["--cache-type-v", str(type_v)] + extra

    # — RoPE
    rope_base = load.get("rope_freq_base")
    if rope_base is not None:
        extra = ["--rope-freq-base", str(rope_base)] + extra
    rope_scale = load.get("rope_freq_scale")
    if rope_scale is not None:
        extra = ["--rope-freq-scale", str(rope_scale)] + extra

    # — Custom chat template file (override du template Jinja bundled dans le GGUF)
    # Use case : tools cassés sur Qwen3, thinking baked-in à bypass, formats custom.
    # Chemin relatif → résolu sous le répertoire configuré par `llamacpp_chat_templates_dir`
    # (défaut : ~/mercury/chat-templates, voir config.yaml.example).
    import os as _os
    _ctf_dir = get_config().get("llamacpp_chat_templates_dir") or _os.path.join(_os.path.expanduser("~"), "mercury", "chat-templates")
    ctf = load.get("chat_template_file")
    if ctf and isinstance(ctf, str) and ctf.strip():
        ctf = ctf.strip()
        if not ctf.startswith("/"):
            ctf = _os.path.join(_ctf_dir, ctf)
        if "--chat-template-file" not in extra:
            extra = ["--chat-template-file", ctf] + extra

    # — Speculative decoding (MTP / Draft)
    # Trois modes selon le build llama-server :
    #   1. MTP embedded (mainline PR #22673, slot native-mtp) :
    #        --spec-type mtp + --spec-draft-n-max N
    #        (le head MTP est dans le GGUF principal, pas de chemin séparé)
    #   2. MTP head séparé (fork atomic-llama-cpp-turboquant) :
    #        --mtp-head <path> + --spec-type mtp + --draft-block-size N + -ngld N
    #   3. Draft classique (mainline standard) :
    #        -md <path> + -cd N + -ngld N + --draft-max N + --draft-min N + --draft-p-min P
    # On expose tous les flags séparément ; libre au user de combiner selon son backend.
    # Tous les flags inconnus du binaire seront refusés au load (HTTP 400) — pas de risque
    # silencieux : le user voit l'erreur tout de suite.
    spec_type = load.get("spec_type")
    if spec_type and isinstance(spec_type, str) and spec_type.strip():
        st = spec_type.strip()
        # Mainline llama.cpp a renommé l'enum --spec-type (mtp→draft-mtp, draft→draft-simple,
        # ngram→ngram-simple). Le fork atomic-llama-cpp-turboquant garde encore les anciens
        # noms — exposé via la valeur `mtp-legacy` (voué à disparaître). Valeurs déjà au
        # nouveau format (contiennent un "-") passent inchangées.
        _SPEC_TYPE_MAP = {
            "mtp": "draft-mtp",
            "mtp-legacy": "mtp",
            "draft": "draft-simple",
            "ngram": "ngram-simple",
        }
        extra = ["--spec-type", _SPEC_TYPE_MAP.get(st, st)] + extra
    spec_draft_n_max = load.get("spec_draft_n_max")
    if spec_draft_n_max is not None:
        extra = ["--spec-draft-n-max", str(spec_draft_n_max)] + extra
    mtp_head = load.get("mtp_head")
    if mtp_head and isinstance(mtp_head, str) and mtp_head.strip():
        extra = ["--mtp-head", mtp_head.strip()] + extra
    draft_block_size = load.get("draft_block_size")
    if draft_block_size is not None:
        extra = ["--draft-block-size", str(draft_block_size)] + extra
    draft_model = load.get("draft_model")
    if draft_model and isinstance(draft_model, str) and draft_model.strip():
        extra = ["-md", draft_model.strip()] + extra
    draft_n_gpu_layers = load.get("draft_n_gpu_layers")
    if draft_n_gpu_layers is not None:
        extra = ["-ngld", str(draft_n_gpu_layers)] + extra
    draft_ctx_size = load.get("draft_ctx_size")
    if draft_ctx_size is not None:
        extra = ["-cd", str(draft_ctx_size)] + extra
    draft_max = load.get("draft_max")
    if draft_max is not None:
        extra = ["--draft-max", str(draft_max)] + extra
    draft_min = load.get("draft_min")
    if draft_min is not None:
        extra = ["--draft-min", str(draft_min)] + extra
    draft_p_min = load.get("draft_p_min")
    if draft_p_min is not None:
        extra = ["--draft-p-min", str(draft_p_min)] + extra

    return {
        "model_id": model_id,
        "ctx_size": load.get("ctx_size", 32768),
        "extra_args": extra,
        "backend": load.get("backend", "native-vulkan"),
    }
