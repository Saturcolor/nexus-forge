"""Routes templates de chargement (GET liste / POST upsert / DELETE)."""
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from data import db as db_module

router = APIRouter()


@router.get("/llamacpp/templates")
async def get_llamacpp_templates():
    """Liste tous les templates de chargement stockés en DB."""
    templates = db_module.get_llamacpp_templates()
    return JSONResponse(content={"templates": templates})


@router.post("/llamacpp/templates/{model_id:path}")
async def set_llamacpp_template(model_id: str, body: dict):
    """Crée ou met à jour le template d'un modèle.
    Body: { "load": { "ctx_size": 32768, "n_gpu_layers": 999, ... }, "defaults": { "temperature": 0.7, ... } }
    """
    if not model_id:
        return JSONResponse(status_code=400, content={"detail": "model_id requis"})
    # Valider les clés de la section load
    load = body.get("load") or {}
    valid_load_keys = {
        "ctx_size", "n_gpu_layers", "flash_attn", "no_mmap", "extra_args",
        "ctx_shift", "parallel", "unified_kv_cache", "swa_full",
        "n_batch", "n_ubatch", "n_threads", "n_threads_batch",
        "type_k", "type_v", "rope_freq_base", "rope_freq_scale",
        "kv_cache_auto_dump", "backend",
        "chat_template_file",  # NEW: override du template Jinja via --chat-template-file
        "mlock", "cache_ram", "ctx_checkpoints", "cache_idle_slots",
        "jinja",  # --jinja : active le template Jinja bundled dans le GGUF
        "debug",  # --verbose --verbose-prompt : dump le prompt rendu pour diagnostic
        "env_vars",  # dict forwardé tel quel à brain-daemon (vLLM, lucebox)
        "lucebox_draft",  # chemin safetensors draft model, requis pour backend=native-lucebox
        # Speculative decoding (MTP / Draft) — voir _common.py pour le mapping flags
        "spec_type",
        "spec_draft_n_max",
        "mtp_head",
        "draft_block_size",
        "draft_model",
        "draft_n_gpu_layers",
        "draft_ctx_size",
        "draft_max",
        "draft_min",
        "draft_p_min",
    }
    valid_defaults_keys = {
        "temperature", "top_p", "top_k", "repeat_penalty", "n_keep",
        "min_p", "typical_p", "tfs_z",
        "frequency_penalty", "presence_penalty",
        "mirostat_mode", "mirostat_tau", "mirostat_eta",
        "seed",
        "cache_prompt",
        "chat_template_kwargs",  # NEW: dict libre passé au template Jinja (enable_thinking, reasoning_effort, ...)
        "reasoning",  # legacy: migré au prochain load par backend.py, gardé pour compat lecture
        "thinking_budget_low", "thinking_budget_medium", "thinking_budget_high",
    }
    defaults = body.get("defaults") or {}
    unknown_load = set(load.keys()) - valid_load_keys
    unknown_defaults = set(defaults.keys()) - valid_defaults_keys
    if unknown_load:
        return JSONResponse(status_code=400, content={"detail": f"Clés load inconnues: {sorted(unknown_load)}"})
    if unknown_defaults:
        return JSONResponse(status_code=400, content={"detail": f"Clés defaults inconnues: {sorted(unknown_defaults)}"})
    # Validation : chat_template_kwargs doit être un dict
    ctk = defaults.get("chat_template_kwargs")
    if ctk is not None and not isinstance(ctk, dict):
        return JSONResponse(status_code=400, content={"detail": "defaults.chat_template_kwargs doit être un objet JSON"})
    template = {}
    if load:
        template["load"] = load
    if defaults:
        template["defaults"] = defaults
    merge_consecutive_messages = body.get("merge_consecutive_messages")
    if merge_consecutive_messages is not None:
        template["merge_consecutive_messages"] = bool(merge_consecutive_messages)
    db_module.set_llamacpp_template(model_id, template)
    return JSONResponse(content={"ok": True, "model_id": model_id, "template": template})


@router.delete("/llamacpp/templates/{model_id:path}")
async def delete_llamacpp_template(model_id: str):
    """Supprime le template d'un modèle."""
    deleted = db_module.delete_llamacpp_template(model_id)
    if not deleted:
        return JSONResponse(status_code=404, content={"detail": f"Template introuvable: {model_id}"})
    return JSONResponse(content={"ok": True, "model_id": model_id})
