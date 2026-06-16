"""
brain-daemon — Programme unifie pour le brain.
Regroupe : LLM model management, stats systeme, thermal control, perf modes, toolbox updates.

Port unique : 4321 (configurable)
API :
  /v1/*          → OpenAI-compatible proxy (inchange)
  /mgmt/*        → Management API modeles (inchange)
  /stats/*       → Stats systeme + logs LM Studio/Ollama (ex-probe)
  /thermal/*     → Controle thermique
  /perf/*        → Modes performance/eco
  /updater/*     → Mise a jour toolboxes
  /health        → Health check enrichi
"""
import asyncio
import datetime
import json
import logging
import os
import time
from collections import deque
from pathlib import Path
from typing import Any

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from manager import ModelManager
from version import __version__ as DAEMON_VERSION

# ── Config ────────────────────────────────────────────────────────────────────

_cfg_env = os.environ.get("BRAIN_CONFIG")
config_path = Path(_cfg_env) if _cfg_env else (Path(__file__).parent / "config.yaml")
if not config_path.exists():
    _example = Path(__file__).parent / "config.yaml.example"
    if _example.exists():
        config_path = _example
with open(config_path, encoding="utf-8") as f:
    config = yaml.safe_load(f)

# Mode démo : aucun GPU/llama-server/modèle requis (BRAIN_DEMO_MODE=1). Voir DEMO.md.
DEMO_MODE = bool(os.environ.get("BRAIN_DEMO_MODE"))

# ── Helpers DÉMO ────────────────────────────────────────────────────────────────
_DEMO_MODELS = [
    {"id": "demo/qwen-demo-7b", "running": True, "port": 11430, "kind": "gguf", "size_gb": 4.2},
    {"id": "demo/embed-demo", "running": False, "port": 11431, "kind": "gguf", "size_gb": 0.6},
]


def _demo_chat_response(raw_body: bytes):
    """Réponse canned OpenAI chat.completions (stream ou non) pour BRAIN_DEMO_MODE."""
    try:
        parsed = json.loads(raw_body or b"{}")
    except Exception:
        parsed = {}
    model = parsed.get("model") or "demo/qwen-demo-7b"
    stream = bool(parsed.get("stream"))
    last = ""
    for m in reversed(parsed.get("messages") or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            last = m["content"]
            break
    reply = (
        "brain-daemon is running in DEMO_MODE — no llama-server is spawned and no GPU is used. "
        f"Canned reply for model '{model}'. You said: \"{last[:200]}\"."
    )
    created = int(time.time())
    base = {"id": "chatcmpl-demo", "created": created, "model": model}
    if stream:
        def _gen():
            yield f"data: {json.dumps({**base, 'object': 'chat.completion.chunk', 'choices': [{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}]})}\n\n"
            for word in reply.split(" "):
                yield f"data: {json.dumps({**base, 'object': 'chat.completion.chunk', 'choices': [{'index': 0, 'delta': {'content': word + ' '}, 'finish_reason': None}]})}\n\n"
            yield f"data: {json.dumps({**base, 'object': 'chat.completion.chunk', 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(_gen(), media_type="text/event-stream")
    return JSONResponse({
        **base, "object": "chat.completion",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": len(reply.split()), "total_tokens": len(reply.split())},
    })

# ── Logging en memoire ────────────────────────────────────────────────────────

class _DequeLogHandler(logging.Handler):
    def __init__(self, buf: deque):
        super().__init__()
        self._buf = buf

    def emit(self, record: logging.LogRecord):
        try:
            self._buf.append(self.format(record))
        except Exception:
            pass

_daemon_log_buffer: deque = deque(maxlen=500)
_log_handler = _DequeLogHandler(_daemon_log_buffer)
_log_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%H:%M:%S"))
logging.root.addHandler(_log_handler)

# Also stream to stderr so journalctl/systemd captures tracebacks from
# logger.exception(). Without this, our DequeLogHandler swallows them
# into the in-memory ring buffer only — invisible during incidents.
_stream_handler = logging.StreamHandler()
_stream_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%H:%M:%S"))
logging.root.addHandler(_stream_handler)

logging.root.setLevel(logging.INFO)

logger = logging.getLogger("brain-daemon")

# ── App & Manager ─────────────────────────────────────────────────────────────

app = FastAPI(title="brain-daemon")
manager = ModelManager(config)

# Toolboxes disponibles
_TOOLBOX_VULKAN = config.get("toolbox_name", "llama-vulkan-radv")
_TOOLBOX_ROCM   = config.get("toolbox_rocm_name", "llama-rocm-7.2")
_TOOLBOX_VLLM   = config.get("toolbox_vllm_name", "vllm")
_NATIVE_VULKAN  = config.get("native_vulkan_binary", "/opt/llama-native/bin/llama-server")
# backend name → (resource, backend_type)
#   resource = toolbox container name (for "toolbox"/"vllm-toolbox" types) OR native binary path (for "native" type)
#   backend_type:
#     "toolbox"        = llama-server via `toolbox run`
#     "native"         = llama-server direct binary on host
#     "vllm-toolbox"   = `vllm serve` via `toolbox run` (HF dir model layout, no GGUF)
_BACKEND_MAP: dict[str, tuple[str, str]] = {
    "vulkan":        (_TOOLBOX_VULKAN, "toolbox"),
    "rocm":          (_TOOLBOX_ROCM,   "toolbox"),
    "native-vulkan": (_NATIVE_VULKAN,  "native"),
    "vllm-rocm":     (_TOOLBOX_VLLM,   "vllm-toolbox"),
}

# Extra native backends declared in config.yaml under `extra_native_backends:`.
# Each entry maps a backend name (e.g. "native-dflash") to its build settings.
# Only the `binary` field is consumed at load-time; `pr`, `branch`, `prefix`
# are consumed by the updater (build script invocation).
#   extra_native_backends:
#     native-dflash:
#       binary: /opt/llama-native-dflash/bin/llama-server
#       pr: 22105
#       branch: pr-22105
#     native-mtp:
#       binary: /opt/llama-native-mtp/bin/llama-server
#       pr: 22673
_EXTRA_NATIVE: dict[str, dict] = config.get("extra_native_backends") or {}
# Sidecar map for backend-specific extras (e.g. lucebox needs server_script + test_bin).
# Keyed by backend name; consumed at /mgmt/load to forward to ModelManager.load_model.
_BACKEND_EXTRAS: dict[str, dict] = {}
_VALID_EXTRA_TYPES = {"native", "lucebox"}
for _name, _spec in _EXTRA_NATIVE.items():
    if not isinstance(_spec, dict):
        logger.warning("extra_native_backends.%s: not a dict, skipped", _name)
        continue
    _bin = _spec.get("binary")
    if not _bin or not isinstance(_bin, str):
        logger.warning("extra_native_backends.%s: missing 'binary' string, skipped", _name)
        continue
    _btype = _spec.get("backend_type", "native")
    if _btype not in _VALID_EXTRA_TYPES:
        logger.warning("extra_native_backends.%s: invalid backend_type=%r (allowed: %s), skipped",
                       _name, _btype, sorted(_VALID_EXTRA_TYPES))
        continue
    if _name in _BACKEND_MAP:
        logger.warning("extra_native_backends.%s: shadows a builtin backend, overriding", _name)
    _BACKEND_MAP[_name] = (_bin, _btype)
    _BACKEND_EXTRAS[_name] = _spec
    logger.info("extra_native_backends: registered %s (type=%s) → %s", _name, _btype, _bin)

# Load configs persistantes
_LOAD_CONFIGS_PATH = Path(__file__).parent / "load_configs.json"
_model_load_configs: dict[str, dict] = {}
if _LOAD_CONFIGS_PATH.exists():
    try:
        _model_load_configs = json.loads(_LOAD_CONFIGS_PATH.read_text(encoding="utf-8"))
        logger.info("load_configs: restaure %d config(s)", len(_model_load_configs))
    except Exception as _e:
        logger.warning("load_configs: impossible de charger: %s", _e)


def _save_load_configs():
    try:
        _LOAD_CONFIGS_PATH.write_text(json.dumps(_model_load_configs, indent=2), encoding="utf-8")
    except Exception as _e:
        logger.warning("load_configs: impossible de sauvegarder: %s", _e)


# ── Thermal controller ────────────────────────────────────────────────────────

from thermal.controller import ThermalController
thermal_controller = ThermalController(manager, config)

from memory.controller import MemoryController

def _persist_model_config(model_id: str, key: str, value):
    """Persist a per-model config key to load_configs.json."""
    if model_id not in _model_load_configs:
        _model_load_configs[model_id] = {}
    _model_load_configs[model_id][key] = value
    _save_load_configs()

memory_controller = MemoryController(manager, thermal_controller, config, persist_fn=_persist_model_config)

# ── Mount sub-modules ─────────────────────────────────────────────────────────

from stats.routes import router as stats_router, init_stats
from thermal.routes import router as thermal_router, set_thermal_controller
from updater.routes import router as updater_router, init_updater
from updater.lucebox import router as lucebox_updater_router, init_lucebox_updater
from audio.routes import router as audio_router, init_audio
from memory.routes import router as memory_router, set_memory_controller
from downloader.routes import router as downloader_router, init_downloader
from atlas.routes import router as atlas_router, init_atlas
from quantize.routes import router as quant_router, init_quant, shutdown_quant

app.include_router(stats_router, prefix="/stats")
app.include_router(thermal_router)
app.include_router(updater_router, prefix="/updater")
# lucebox updater registers its own /updater/lucebox prefix internally
# (parallel pipeline; can't share the build-native.sh path because Lucebox
# uses its own cmake/HIP build with custom flags).
app.include_router(lucebox_updater_router)
app.include_router(audio_router, prefix="/audio")
app.include_router(memory_router, prefix="/memory")
app.include_router(downloader_router, prefix="/downloader")
app.include_router(atlas_router, prefix="/atlas")
app.include_router(quant_router, prefix="/quant")

set_thermal_controller(thermal_controller)
set_memory_controller(memory_controller)


@app.on_event("startup")
async def startup():
    """Initialise les sous-modules au demarrage."""
    if DEMO_MODE:
        logger.warning("brain-daemon DEMO_MODE actif — modules hardware/quant/downloader désactivés")
        logger.info("brain-daemon v%s (DEMO) démarre (port %s)", DAEMON_VERSION, config.get("daemon_port", 4321))
        return
    init_stats(config)
    init_updater(config)
    init_lucebox_updater(config)
    # Downloader (HuggingFace model manager)
    if config.get("downloader", {}).get("enabled", True):
        init_downloader(config, manager)
        logger.info("Downloader module initialized")
    # Audio (STT + TTS local)
    if config.get("audio", {}).get("enabled", False):
        # `omnivoice:` peut être au top-level (cohérent avec downloader/thermal/…)
        # ou imbriqué sous audio:. On normalise vers audio.omnivoice pour que
        # manager.init_models() le trouve toujours au même endroit.
        audio_cfg = dict(config.get("audio", {}))
        if "omnivoice" in config and "omnivoice" not in audio_cfg:
            audio_cfg["omnivoice"] = config["omnivoice"]
        init_audio(audio_cfg)
        logger.info("Audio module initialized")
    # Auto-start thermal si configure
    if config.get("thermal", {}).get("auto_start", False):
        thermal_controller.start()
        logger.info("Thermal controller auto-started")
    # Auto-start memory controller
    if config.get("memory", {}).get("enabled", False):
        memory_controller.start()
        logger.info("Memory controller auto-started")
    # Atlas (extraction de control vectors via transformers, OPT-IN)
    if config.get("atlas", {}).get("enabled", False):
        init_atlas(config, brain_manager=manager)
        logger.info("Atlas module initialized")
    # Quantize : routes read-only + manager async pour les jobs (Phase 2).
    # Activé par défaut ; désactivable via `quant.enabled: false` dans config.yaml.
    # La config quantize/config.yaml (presets + paths) est chargée par init_quant
    # indépendamment de daemon.config.
    await init_quant(config)
    logger.info("Quantize module initialized")
    logger.info("brain-daemon v%s demarre (port %s)", DAEMON_VERSION, config.get("daemon_port", 4321))


@app.on_event("shutdown")
async def shutdown():
    """Cleanup propre des modules au shutdown."""
    try:
        await shutdown_quant()
    except Exception:
        logger.exception("shutdown_quant failed")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _validate_control_vectors(
    control_vectors: Any,
    control_vector_layer_range: Any,
) -> tuple[list[dict], tuple[int, int] | None]:
    """Valide la structure {control_vectors: [{path, scale}], control_vector_layer_range: [s,e]}.

    Retourne (cv_list_normalized, layer_range_tuple_or_None). Raise HTTPException si
    invalide. Vérifie aussi que les paths .gguf existent côté brain.
    """
    cv_resolved: list[dict] = []
    if control_vectors:
        if not isinstance(control_vectors, list):
            raise HTTPException(400, "control_vectors must be a list")
        for idx, cv in enumerate(control_vectors):
            if not isinstance(cv, dict):
                raise HTTPException(400, f"control_vectors[{idx}] must be an object")
            path = cv.get("path")
            scale = cv.get("scale")
            if not path or not isinstance(path, str):
                raise HTTPException(400, f"control_vectors[{idx}].path required (string)")
            if scale is None:
                raise HTTPException(400, f"control_vectors[{idx}].scale required")
            try:
                scale_f = float(scale)
            except (TypeError, ValueError):
                raise HTTPException(400, f"control_vectors[{idx}].scale invalid: {scale!r}")
            if not Path(path).is_file():
                raise HTTPException(404, f"control_vector file not found: {path}")
            if not path.endswith(".gguf"):
                logger.warning("control_vector path doesn't end with .gguf: %s", path)
            cv_resolved.append({"path": path, "scale": scale_f})

    lr_tuple: tuple[int, int] | None = None
    if control_vector_layer_range is not None and control_vector_layer_range != []:
        if (not isinstance(control_vector_layer_range, (list, tuple))
                or len(control_vector_layer_range) != 2):
            raise HTTPException(400, "control_vector_layer_range must be [start, end]")
        try:
            ls = int(control_vector_layer_range[0])
            le = int(control_vector_layer_range[1])
        except (TypeError, ValueError):
            raise HTTPException(400, "control_vector_layer_range entries must be ints")
        if ls < 0 or le < ls:
            raise HTTPException(400, f"control_vector_layer_range invalid: [{ls},{le}]")
        lr_tuple = (ls, le)
    return cv_resolved, lr_tuple


def _build_lora_flags(loras: list[dict] | None, backend_type: str = "") -> list[str]:
    """Traduit la liste loras → flags CLI au boot llama-server.

    Format : `--lora PATH` répété pour chaque adapter (pas de scale au boot).
    Les scales sont gérés per-request dans le body /v1/chat/completions via
    `lora: [{id:i, scale:X}, ...]` — injecté par _inject_lora_default().
    L'`id` de chaque adapter côté llama-server = l'ordre d'apparition (0, 1, 2…),
    donc l'ordre de cette liste est contractuel — ne pas trier.

    Skippé pour vLLM (vllm-toolbox) et Lucebox qui ne supportent pas --lora.
    Les entrées sans `path` ou avec fichier introuvable sont droppées avec warn.
    """
    if not loras:
        return []
    if backend_type == "vllm-toolbox" or backend_type.startswith("vllm"):
        logger.debug("_build_lora_flags: skipped for backend_type=%s (n=%d)", backend_type, len(loras))
        return []
    # IMPORTANT — pas de skip silencieux ici. L'`id` côté llama-server = position
    # dans l'ordre `--lora`, donc skipper l'entry idx=1 ferait que l'entry idx=2
    # prendrait l'id=1, et le client (Mastermind) qui envoie
    # `lora:[{id:2,scale:X}]` appliquerait le scale au mauvais adapter. On raise
    # pour fail-fast au boot/lazy-load — la validation amont (/mgmt/load) déjà
    # check is_file() avant d'arriver ici, donc en pratique on n'attrape que les
    # cas où le fichier a disparu entre persistance et load (rare mais réel).
    flags: list[str] = []
    for idx, lora in enumerate(loras):
        path = (lora or {}).get("path") or ""
        if not path:
            raise ValueError(f"_build_lora_flags: entry #{idx} has empty path (would shift llama-server ids)")
        if not Path(path).is_file():
            raise FileNotFoundError(f"_build_lora_flags: LoRA file not found on brain: {path} (entry #{idx})")
        flags.extend(["--lora", path])
    return flags


def _normalize_loras_input(body: dict, *, fallback: list[dict] | None = None) -> list[dict] | None:
    """Normalise tout format d'entrée LoRA vers list[{path, default_scale}].

    Accepte (par ordre de préférence) :
    - body["loras"] : liste de {path, default_scale} (format multi natif)
    - body["lora"]  : dict {path, default_scale} (legacy singleton)
    - body["lora_path"] (+ body["lora_scale"]) : flat legacy Mercury < refacto

    Si rien fourni, retourne `fallback` (typiquement existing_cfg loras).
    Retourne None si rien à activer (pas la même chose qu'une liste vide :
    None = "pas d'opinion, garder l'existant", [] = "clear explicitement").
    """
    if "loras" in body:
        raw = body.get("loras")
        if raw is None:
            return []  # explicit clear
        if not isinstance(raw, list):
            raise HTTPException(400, "loras must be a list of {path, default_scale}")
        out: list[dict] = []
        for idx, entry in enumerate(raw):
            if not isinstance(entry, dict):
                raise HTTPException(400, f"loras[{idx}] must be a dict")
            p = (entry.get("path") or "").strip()
            if not p:
                # Pas de skip silencieux — décalerait les ids llama-server pour
                # les entries suivantes (cf _build_lora_flags pour le contrat).
                raise HTTPException(400, f"loras[{idx}] has empty path (would shift llama-server ids)")
            out.append({"path": p, "default_scale": float(entry.get("default_scale") or 1.0)})
        return out
    if "lora" in body:
        raw = body.get("lora")
        if raw is None:
            return []
        if not isinstance(raw, dict):
            raise HTTPException(400, "lora (legacy) must be a dict {path, default_scale}")
        p = (raw.get("path") or "").strip()
        return [{"path": p, "default_scale": float(raw.get("default_scale") or 1.0)}] if p else []
    if "lora_path" in body:
        p = (body.get("lora_path") or "").strip()
        return [{"path": p, "default_scale": float(body.get("lora_scale") or 1.0)}] if p else []
    return fallback


def _build_cv_flags(
    control_vectors: list[dict],
    layer_range: tuple[int, int] | None,
) -> list[str]:
    """Translate normalized control_vectors → llama.cpp CLI flags.

    Format colon spécifique au fork atomic-turboquant (cf feedback_llama_cli_subprocess) :
    --control-vector-scaled PATH:SCALE (un seul argument), pas PATH SCALE.

    IMPORTANT — les versions récentes de llama.cpp dépréciaient l'usage de
    plusieurs `--control-vector-scaled` sur la même commande ("only last value
    will be used") : avec un cocktail à N vecteurs, seul le dernier était
    appliqué, les autres droppés silencieusement. On passe donc une seule
    occurrence avec les paires séparées par virgule.
    """
    flags: list[str] = []
    if control_vectors:
        joined = ",".join(f"{cv['path']}:{cv['scale']}" for cv in control_vectors)
        flags.extend(["--control-vector-scaled", joined])
    if layer_range is not None:
        ls, le = layer_range
        flags.extend(["--control-vector-layer-range", str(ls), str(le)])
    return flags


def _merge_extras(
    user_extras: list | None,
    control_vectors: list[dict],
    layer_range: tuple[int, int] | None,
    loras: list[dict] | None = None,
    backend_type: str = "",
) -> list:
    """Concatène user extras + flags CV + flags LoRA. Préserve l'ordre user d'abord."""
    base = list(user_extras) if user_extras else []
    return base + _build_cv_flags(control_vectors, layer_range) + _build_lora_flags(loras, backend_type)


def _loras_from_config(cfg: dict) -> list[dict]:
    """Extrait la liste de LoRAs persistés pour un model_id.

    Retourne toujours une liste (potentiellement vide), jamais None — simplifie
    les callers. Auto-migre les configs legacy `"lora": {path, default_scale}`
    (dict singleton) en `[{path, default_scale}]` ; la nouvelle clé `"loras"`
    prend priorité si les deux coexistent (transition).
    """
    loras_raw = cfg.get("loras")
    if isinstance(loras_raw, list):
        return [l for l in loras_raw if isinstance(l, dict) and l.get("path")]
    legacy = cfg.get("lora")
    if isinstance(legacy, dict) and legacy.get("path"):
        return [{"path": legacy["path"], "default_scale": float(legacy.get("default_scale") or 1.0)}]
    return []


def _inject_lora_default(body_bytes: bytes, model_id: str) -> bytes:
    """Injecte lora: [{id:i, scale:default_scale}, ...] dans le body JSON si absent.

    Brain est source de vérité pour les LoRA actifs sur ce modèle. L'`id` côté
    llama-server = ordre de chargement (0, 1, 2…), donc on enumerate la liste
    persistée (préservée stable depuis le boot).
    - Si le client a déjà fourni `lora: [...]` → on le respecte (override per-turn).
    - Si absent + modèle a des LoRA configurés → on injecte les defaults.
    - Si absent + aucun LoRA configuré → body inchangé.

    Re-encode le JSON (content-length mis à jour dans _forward).
    """
    loras = _loras_from_config(_model_load_configs.get(model_id, {}))
    if not loras:
        return body_bytes
    try:
        data = json.loads(body_bytes)
    except Exception:
        return body_bytes
    if "lora" in data:
        logger.info("_inject_lora_default: client override model=%s lora=%s", model_id, data["lora"])
        return body_bytes
    payload = [
        {"id": idx, "scale": float(l.get("default_scale") or 1.0)}
        for idx, l in enumerate(loras)
    ]
    data["lora"] = payload
    logger.debug("_inject_lora_default: model=%s n=%d payload=%s", model_id, len(payload), payload)
    return json.dumps(data).encode("utf-8")


def _cocktail_from_config(cfg: dict) -> dict | None:
    """Extrait le cocktail control_vector persisté pour un model_id, ou None si absent.

    Format de retour aligné avec ce que /mgmt/status expose, et ce que /mgmt/load
    accepte en entrée (round-trip identique).
    """
    cvs = cfg.get("control_vectors") or []
    if not cvs:
        return None
    lr = cfg.get("control_vector_layer_range")
    return {
        "control_vectors": cvs,
        "control_vector_layer_range": list(lr) if lr else None,
    }


async def _get_or_load(model_ref: str) -> Any:
    if model_ref in manager.instances:
        inst = manager.instances[model_ref]
        if inst.thermal_stopped:
            raise HTTPException(status_code=503, detail=json.dumps({
                "type": "thermal_stopped",
                "message": "Model paused by thermal protection",
            }))
        if inst.is_running:
            return inst
        if 0 < inst.loading_pct < 100:
            raise HTTPException(status_code=503, detail=json.dumps({
                "type": "model_loading",
                "loading_pct": inst.loading_pct,
            }))
    model_id = manager.resolve_model_id(model_ref)
    if not model_id:
        raise HTTPException(status_code=404, detail=f"Model '{model_ref}' not found")
    try:
        cfg = _model_load_configs.get(model_id, {})
        # Restore the full backend the user originally chose (incl. native/lucebox).
        # Before this, the lazy-load path silently fell back to default toolbox even
        # when load_configs.json said otherwise — broke lucebox/native auto-reload.
        cfg_backend = cfg.get("backend")
        backend_type = cfg.get("backend_type", "toolbox")
        native_binary = cfg.get("native_binary")
        backend_extras = _BACKEND_EXTRAS.get(cfg_backend, {}) if cfg_backend else {}
        # Restore control_vector cocktail si persisté : merge dans extra_args avant load.
        # extra_args persisté = celui fourni par l'utilisateur (sans flags CV), control_vectors
        # stocké séparément pour pouvoir l'afficher proprement dans /mgmt/status.
        cv_list = cfg.get("control_vectors") or []
        cv_lr = cfg.get("control_vector_layer_range")
        cv_lr_tuple = tuple(cv_lr) if cv_lr else None
        loras_lazy = _loras_from_config(cfg)
        lazy_backend_type = cfg.get("backend_type", "toolbox")
        merged_extras = _merge_extras(cfg.get("extra_args"), cv_list, cv_lr_tuple, loras_lazy, lazy_backend_type)
        if cv_list:
            logger.info("lazy-load: model=%s cocktail=%d vectors layer_range=%s",
                        model_id, len(cv_list), cv_lr_tuple)
        if loras_lazy:
            logger.info("lazy-load: model=%s LoRAs=%d %s",
                        model_id, len(loras_lazy),
                        [(l.get("path"), l.get("default_scale", 1.0)) for l in loras_lazy])
        inst = await manager.load_model(
            model_id,
            ctx_size=cfg.get("ctx_size"),
            extra_args=merged_extras if merged_extras else None,
            toolbox_name=cfg.get("toolbox_name"),
            backend_type=backend_type,
            native_binary=native_binary,
            env_vars=cfg.get("env_vars"),
            lucebox_draft=cfg.get("lucebox_draft"),
            lucebox_server_script=backend_extras.get("server_script"),
            lucebox_test_bin=backend_extras.get("test_bin"),
        )
        inst.protected = bool(cfg.get("protected", False))
        return inst
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _sse_error(error_type: str, message: str) -> bytes:
    return f'data: {json.dumps({"error": {"type": error_type, "message": message}})}\n\n'.encode()


async def _forward(request: Request, instance: Any, path: str, body: bytes) -> Response:
    instance.last_inference_ts = time.time()
    url = f"{instance.base_url}{path}"
    stream = False
    try:
        stream = json.loads(body).get("stream", False)
    except Exception:
        pass

    headers = {k: v for k, v in request.headers.items() if k.lower() not in ("host", "content-length")}
    headers["content-length"] = str(len(body))

    if stream:
        async def generate():
            cancel_event = asyncio.Event()

            async def watchdog():
                while not cancel_event.is_set():
                    if not instance.is_running or instance.thermal_stopped:
                        cancel_event.set()
                        return
                    await asyncio.sleep(2)

            watcher = asyncio.create_task(watchdog())
            try:
                async with httpx.AsyncClient() as client:
                    async with client.stream("POST", url, content=body, headers=headers,
                                             timeout=httpx.Timeout(timeout=None, connect=5.0)) as resp:
                        async for chunk in resp.aiter_bytes():
                            if cancel_event.is_set():
                                break
                            yield chunk
                if cancel_event.is_set():
                    reason = "thermal_stopped" if instance.thermal_stopped else "process_died"
                    logger.warning("llama.cpp %s during streaming request", reason)
                    yield _sse_error(reason, f"llama.cpp {reason} during request")
            except (httpx.ReadError, httpx.RemoteProtocolError, httpx.ConnectError) as e:
                logger.warning("llama.cpp connection error during streaming: %s", e)
                yield _sse_error("connection_error", str(e))
            finally:
                cancel_event.set()
                watcher.cancel()

        return StreamingResponse(generate(), media_type="text/event-stream")

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, content=body, headers=headers,
                                     timeout=httpx.Timeout(600.0, connect=5.0))
        return Response(content=resp.content, status_code=resp.status_code,
                        media_type=resp.headers.get("content-type", "application/json"))
    except (httpx.ConnectError, httpx.ReadTimeout) as e:
        logger.warning("llama.cpp connection error (non-streaming): %s", e)
        return JSONResponse({"error": {"type": "connection_error", "message": str(e)}}, status_code=502)


# ── OpenAI-compatible proxy (inchange) ────────────────────────────────────────

@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.body()
    if DEMO_MODE:
        return _demo_chat_response(body)
    model_ref = json.loads(body).get("model", "")
    instance = await _get_or_load(model_ref)
    # Injection LoRA per-request : si le modèle a un LoRA chargé et que le client
    # n'a pas fourni de champ `lora`, on injecte lora: [{id: 0, scale: default}].
    body = _inject_lora_default(body, instance.model_id)
    return await _forward(request, instance, "/v1/chat/completions", body)


@app.post("/v1/completions")
async def completions(request: Request):
    body = await request.body()
    if DEMO_MODE:
        return _demo_chat_response(body)
    model_ref = json.loads(body).get("model", "")
    instance = await _get_or_load(model_ref)
    body = _inject_lora_default(body, instance.model_id)
    return await _forward(request, instance, "/v1/completions", body)


@app.post("/v1/embeddings")
async def embeddings(request: Request):
    body = await request.body()
    if DEMO_MODE:
        try:
            parsed = json.loads(body or b"{}")
        except Exception:
            parsed = {}
        inp = parsed.get("input")
        items = inp if isinstance(inp, list) else [inp]
        data = [{"object": "embedding", "index": i,
                 "embedding": [round(((i * 31 + j * 7) % 100) / 100, 4) for j in range(16)]}
                for i in range(len(items))]
        return JSONResponse({"object": "list", "data": data,
                             "model": parsed.get("model") or "demo/embed-demo",
                             "usage": {"prompt_tokens": 0, "total_tokens": 0}})
    model_ref = json.loads(body).get("model", "")
    instance = await _get_or_load(model_ref)
    return await _forward(request, instance, "/v1/embeddings", body)


@app.get("/v1/models")
async def list_models_openai():
    models = _DEMO_MODELS if DEMO_MODE else manager.scan_models()
    return {
        "object": "list",
        "data": [
            {"id": m["id"], "object": "model", "created": 0, "owned_by": "local",
             "running": m["running"], "port": m["port"],
             "kind": m.get("kind", "gguf"), "size_gb": m.get("size_gb", 0)}
            for m in models
        ],
    }


# ── Management API (inchange) ─────────────────────────────────────────────────

@app.get("/mgmt/version")
async def mgmt_version():
    return {
        "version": DAEMON_VERSION,
        "name": "brain-daemon",
        "backends": {k: {"target": v[0], "type": v[1]} for k, v in _BACKEND_MAP.items()},
    }


@app.get("/mgmt/models")
async def mgmt_list_models():
    if DEMO_MODE:
        return _DEMO_MODELS
    models = manager.scan_models()
    for m in models:
        mid = m["id"]
        cfg = _model_load_configs.get(mid, {})
        m["kv_cache_exists"] = manager.kv_cache_exists(mid)
        m["protected"] = bool(cfg.get("protected", False))
        # Preset assigné (persisté dans load_configs.json — survit aux restart
        # et aux unload). Permet au dashboard d'afficher le badge même sur des
        # modèles non chargés (UX "sélectionner un preset puis charger plus tard").
        m["active_preset_id"] = cfg.get("active_preset_id")
        m["active_preset_name"] = cfg.get("active_preset_name")
        # Liste exhaustive des presets cochés (multi-select Mercury). Fallback
        # singleton si seulement active_preset_id est posé (legacy mono-select).
        m["active_preset_ids"] = cfg.get("active_preset_ids") or (
            [cfg.get("active_preset_id")] if cfg.get("active_preset_id") is not None else []
        )
        # LoRA stack persisté [{path, default_scale}, ...]. L'`id` côté llama-server
        # = index dans cette liste (cf _build_lora_flags). Exposé ici (pas seulement
        # dans /mgmt/status) pour que le dashboard affiche l'ordre 0/1/2 même sur un
        # modèle non chargé. Aligné avec ce que _inject_lora_default mappe par turn.
        m["loras"] = _loras_from_config(cfg)
    return models


@app.get("/mgmt/status")
async def mgmt_status():
    return [
        {"model_id": i.model_id, "port": i.port, "ctx_size": i.ctx_size,
         "running": i.is_running, "ready": i.ready, "loading_pct": i.loading_pct,
         "prompt_pct": i.prompt_pct, "thermal_stopped": i.thermal_stopped,
         "protected": i.protected, "vram_delta_mb": round(i.vram_delta_mb, 1),
         "ram_delta_mb": round(i.ram_delta_mb, 1), "ram_estimated_mb": round(i.ram_estimated_mb, 1),
         "ram_rss_mb": round(i.ram_rss_mb, 1),
         "load_order": i.load_order,
         "last_inference_ts": i.last_inference_ts,
         "backend_type": i.backend_type,
         "pid": i.process.pid if i.process else None,
         # Cocktail control_vector actif sur l'instance (None si vanilla).
         # Source = load_configs.json (état désiré → état réel après reboot).
         "cocktail": _cocktail_from_config(_model_load_configs.get(i.model_id, {})),
         # LoRA actifs — liste [{path, default_scale}, ...]. L'`id` côté
         # llama-server = index dans la liste (préservé depuis le boot). Vide si
         # vanilla. Les scales effectifs peuvent différer par turn si le client
         # passe lora: [{id:i, scale:X}, ...] dans le body /v1/chat/completions.
         "loras": _loras_from_config(_model_load_configs.get(i.model_id, {})),
         # Preset AtlasMind actif (source de la cocktail). None si modèle chargé
         # sans preset (CV manuels ou vanilla). Sert au dashboard Mercury à
         # afficher le badge "preset: X" sur la ModelRow.
         "active_preset_id": _model_load_configs.get(i.model_id, {}).get("active_preset_id"),
         "active_preset_name": _model_load_configs.get(i.model_id, {}).get("active_preset_name"),
         # Liste exhaustive des presets cochés (multi-select). Fallback singleton legacy.
         "active_preset_ids": (
             _model_load_configs.get(i.model_id, {}).get("active_preset_ids")
             or ([_model_load_configs.get(i.model_id, {}).get("active_preset_id")]
                 if _model_load_configs.get(i.model_id, {}).get("active_preset_id") is not None
                 else [])
         )}
        for i in manager.instances.values()
    ]


@app.get("/mgmt/loras")
async def mgmt_list_loras():
    """Liste les fichiers .gguf dans le répertoire lora configuré.

    Répertoire par défaut : ~/mercury/lora (override via config.yaml loras_dir).
    Retourne [{name, path, size_mb, mtime_iso}, ...].
    """
    loras_dir = Path(config.get("loras_dir") or (Path.home() / "mercury" / "lora"))
    if not loras_dir.exists() or not loras_dir.is_dir():
        return JSONResponse(content={
            "loras": [],
            "dir": str(loras_dir),
            "info": "répertoire introuvable — crée-le ou configure loras_dir dans config.yaml",
        })
    loras = []
    try:
        for entry in sorted(loras_dir.iterdir()):
            if entry.is_file() and entry.suffix.lower() == ".gguf":
                stat = entry.stat()
                loras.append({
                    "name": entry.name,
                    "path": str(entry.resolve()),
                    "size_mb": round(stat.st_size / (1024 * 1024), 2),
                    "mtime_iso": datetime.datetime.fromtimestamp(stat.st_mtime).isoformat(),
                })
    except Exception as e:
        logger.warning("mgmt_list_loras: erreur scan %s: %s", loras_dir, e)
        return JSONResponse(status_code=500, content={"error": str(e)})
    logger.info("mgmt_list_loras: dir=%s found=%d", loras_dir, len(loras))
    return JSONResponse(content={"loras": loras, "dir": str(loras_dir), "count": len(loras)})


@app.post("/mgmt/set-preset")
async def mgmt_set_preset(body: dict):
    """Assigne un preset cocktail control_vector à un modèle, SANS le charger.

    Pattern UX dashboard Mercury : le user sélectionne un preset depuis le
    kebab d'une row modèle ; on persiste l'assignation dans load_configs.json
    et c'est appliqué au prochain /mgmt/load. Survit aux restart brain et aux
    unload.

    Body :
        - model_id (required)
        - control_vectors: [{path, scale}] | None (None ou [] = clear)
        - control_vector_layer_range: [s, e] | None
        - active_preset_id, active_preset_name : metadata UI

    Si le modèle est déjà running, le cocktail courant n'est PAS modifié
    (l'instance garde son cocktail jusqu'au prochain unload+load).
    """
    model_ref = body.get("model_id") or body.get("model")
    if not model_ref:
        raise HTTPException(status_code=400, detail="model_id required")
    model_id = manager.resolve_model_id(model_ref)
    if not model_id:
        raise HTTPException(status_code=404, detail=f"Model '{model_ref}' not found")
    # Valide les CV pour fail-fast (paths existent etc) avant persistance.
    cv_list, cv_lr_tuple = _validate_control_vectors(
        body.get("control_vectors"),
        body.get("control_vector_layer_range"),
    )
    existing_cfg = _model_load_configs.get(model_id, {})
    # LoRA — accepte `loras: [...]` (multi natif), `lora: {path, default_scale}`
    # (legacy singleton), ou `lora_path`+`lora_scale` (legacy plat Mercury <
    # refactor per-request). _normalize_loras_input retourne toujours une liste
    # (potentiellement vide = clear explicite) ou None si rien mentionné — ici
    # on traite "rien mentionné" comme "clear" pour matcher l'ancienne sémantique
    # (set-preset = override total).
    loras_to_store = _normalize_loras_input(body, fallback=[])
    if loras_to_store is None:
        loras_to_store = []

    # active_preset_ids = liste exhaustive multi-select (Mercury). Fallback
    # singleton si seul active_preset_id est posé (legacy mono-select).
    body_preset_ids = body.get("active_preset_ids")
    if body_preset_ids is None and body.get("active_preset_id") is not None:
        body_preset_ids = [body.get("active_preset_id")]
    new_cfg = {
        **existing_cfg,
        "control_vectors": cv_list,
        "control_vector_layer_range": list(cv_lr_tuple) if cv_lr_tuple else None,
        "active_preset_id": body.get("active_preset_id"),
        "active_preset_ids": body_preset_ids,
        "active_preset_name": body.get("active_preset_name"),
        "loras": loras_to_store,
    }
    # Purge la clé legacy singulière pour éviter ambiguïté avec "loras" lue
    # par _loras_from_config (qui préfère "loras" mais lit "lora" en fallback).
    new_cfg.pop("lora", None)
    _model_load_configs[model_id] = new_cfg
    _save_load_configs()
    logger.info(
        "set-preset: model=%s preset=%s cv=%d layer_range=%s loras=%d %s",
        model_id, body.get("active_preset_id"), len(cv_list), cv_lr_tuple,
        len(loras_to_store),
        [(l["path"], l.get("default_scale", 1.0)) for l in loras_to_store],
    )
    return {
        "set": True,
        "model_id": model_id,
        "active_preset_id": body.get("active_preset_id"),
        "active_preset_ids": body_preset_ids,
        "active_preset_name": body.get("active_preset_name"),
        "running_instance_affected": False,
    }


@app.post("/mgmt/load")
async def mgmt_load(body: dict):
    model_ref = body.get("model_id") or body.get("model")
    if not model_ref:
        raise HTTPException(status_code=400, detail="model_id required")
    model_id = manager.resolve_model_id(model_ref)
    if not model_id:
        logger.error("load: model not found: %r (available: %s)", model_ref, [m["id"] for m in manager.scan_models()])
        raise HTTPException(status_code=404, detail=f"Model '{model_ref}' not found")
    existing_cfg = _model_load_configs.get(model_id, {})
    # Control vector cocktail : si le caller a une opinion (clé present dans
    # body, même vide pour clear), on l'utilise ; sinon on lit le preset
    # assigné dans load_configs (workflow "sélectionner preset puis cliquer
    # Charger" : Mercury POST /mgmt/load avec model_id seul, brain résout
    # depuis le set-preset persisté).
    if "control_vectors" in body:
        cv_list, cv_lr_tuple = _validate_control_vectors(
            body.get("control_vectors"),
            body.get("control_vector_layer_range"),
        )
        body_preset_id = body.get("active_preset_id")
        body_preset_name = body.get("active_preset_name")
        body_preset_ids = body.get("active_preset_ids")
        if body_preset_ids is None and body_preset_id is not None:
            body_preset_ids = [body_preset_id]
    else:
        cv_list, cv_lr_tuple = _validate_control_vectors(
            existing_cfg.get("control_vectors"),
            existing_cfg.get("control_vector_layer_range"),
        )
        body_preset_id = existing_cfg.get("active_preset_id")
        body_preset_name = existing_cfg.get("active_preset_name")
        body_preset_ids = existing_cfg.get("active_preset_ids") or (
            [body_preset_id] if body_preset_id is not None else None
        )
    user_extras = body.get("extra_args") or []
    if not isinstance(user_extras, list):
        raise HTTPException(400, "extra_args must be a list")

    # LoRA adapters — liste [{path, default_scale}, ...]. Au boot, brain pousse
    # `--lora PATH` une fois par entry vers llama-server (l'`id` côté serveur =
    # ordre dans la liste). Les scales se gèrent per-request dans le body de
    # chat completions via `lora: [{id:i, scale:X}, ...]`.
    # Formats acceptés (cf _normalize_loras_input) : `loras: [...]` (préféré),
    # `lora: {path, default_scale}` (legacy singleton), `lora_path`+`lora_scale`
    # (legacy plat). Si rien dans le body → on réutilise les LoRAs persistés
    # (workflow "set-preset puis load" : Mercury POST avec model_id seul,
    # brain résout depuis load_configs.json).
    loras_from_body = _normalize_loras_input(body, fallback=None)
    if loras_from_body is None:
        loras_cfg = _loras_from_config(existing_cfg)
    else:
        loras_cfg = loras_from_body
    # Valide existence des fichiers fail-fast (sinon llama-server crash mid-boot).
    for entry in loras_cfg:
        if not Path(entry["path"]).is_file():
            raise HTTPException(404, f"LoRA file not found on brain: {entry['path']}")
    if loras_cfg:
        logger.info(
            "load: %d LoRA adapter(s): %s",
            len(loras_cfg),
            [(l["path"], l.get("default_scale", 1.0)) for l in loras_cfg],
        )

    # Backend dispatch : champ absent → default `vulkan`, mais champ fourni inconnu → 400 explicite
    # (sinon typo `vllmrocm` chargeait silencieusement en Vulkan, masquant l'erreur opérateur).
    backend = body.get("backend") or "vulkan"
    if backend not in _BACKEND_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown backend '{backend}'. Available: {sorted(_BACKEND_MAP.keys())}",
        )
    resource, backend_type = _BACKEND_MAP[backend]
    backend_extras = _BACKEND_EXTRAS.get(backend, {})

    # _merge_extras après résolution du backend_type (nécessaire pour le guard vLLM dans _build_lora_flags)
    merged_extras = _merge_extras(user_extras, cv_list, cv_lr_tuple, loras_cfg, backend_type)
    logger.info("load: starting model=%s ctx=%s extra=%s cv=%d layer_range=%s loras=%d %s",
                model_id, body.get("ctx_size"), user_extras, len(cv_list), cv_lr_tuple,
                len(loras_cfg), [l["path"] for l in loras_cfg])
    # `resource` is a toolbox container name (toolbox backend) or a native binary path (native/lucebox).
    if backend_type in ("native", "lucebox"):
        native_binary = resource
        toolbox_name = None
    else:
        native_binary = None
        toolbox_name = resource
    # Lucebox: draft path is per-model (the same Lucebox binary serves different
    # target/draft pairs across model rows). Persist alongside ctx_size/extras
    # so reload-on-restart picks the right draft. Required at load time.
    lucebox_draft = body.get("lucebox_draft") or existing_cfg.get("lucebox_draft")
    if backend_type == "lucebox" and not lucebox_draft:
        raise HTTPException(
            status_code=400,
            detail=f"backend '{backend}' requires 'lucebox_draft' in request body or load_configs.json for model {model_id}",
        )
    # Preserve persistent flags (protected, etc.) — merge instead of replace.
    # control_vectors stocké en structuré (pas mélangé dans extra_args) pour que
    # /mgmt/status puisse afficher le cocktail actif sans devoir re-parser des CLI flags.
    # body_preset_id / body_preset_name : résolus en haut (body si fourni,
    # sinon existing_cfg = preset assigné via /mgmt/set-preset).
    new_cfg = {
        **existing_cfg,
        "ctx_size": body.get("ctx_size"),
        "extra_args": user_extras,
        "env_vars": body.get("env_vars"),
        "backend": backend,
        "toolbox_name": toolbox_name,
        "native_binary": native_binary,
        "backend_type": backend_type,
        "lucebox_draft": lucebox_draft,
        "control_vectors": cv_list,
        "control_vector_layer_range": list(cv_lr_tuple) if cv_lr_tuple else None,
        "active_preset_id": body_preset_id,
        "active_preset_ids": body_preset_ids,
        "active_preset_name": body_preset_name,
        # Liste préservée stable depuis le boot — l'id côté llama-server = index ici.
        # Vide si pas de LoRA. Scales injectés per-request via /v1/chat/completions.
        "loras": loras_cfg,
    }
    # Purge la clé legacy singulière pour éviter ambiguïté avec "loras".
    new_cfg.pop("lora", None)
    _model_load_configs[model_id] = new_cfg
    _save_load_configs()
    logger.info("load: backend=%s resource=%s type=%s", backend, resource, backend_type)

    # Pre-load memory check — choisit le path selon backend_type pour ne pas
    # bypass silencieusement la garde UMA sur les modèles HF (vLLM).
    ctx = body.get("ctx_size") or manager.default_ctx
    if memory_controller and memory_controller.running:
        if backend_type == "vllm-toolbox":
            model_path = manager._find_hf_dir(model_id)
        else:
            model_path = manager._find_gguf_path(model_id)
        if model_path:
            can_load, reason = await memory_controller.preload_check(model_id, str(model_path), ctx)
            if not can_load:
                raise HTTPException(status_code=507, detail=reason)
        else:
            logger.warning("preload_check: no path resolved for %s (backend_type=%s) — skipped, OOM possible", model_id, backend_type)

    try:
        from memory import monitor as _mem_monitor
        vram_before = _mem_monitor.read_vram_used_mb()
        ram_before = _mem_monitor.read_ram_status()

        instance = await manager.load_model(
            model_id,
            ctx_size=body.get("ctx_size"),
            extra_args=merged_extras if merged_extras else None,
            toolbox_name=toolbox_name,
            backend_type=backend_type,
            native_binary=native_binary,
            env_vars=body.get("env_vars"),
            lucebox_draft=lucebox_draft,
            lucebox_server_script=backend_extras.get("server_script"),
            lucebox_test_bin=backend_extras.get("test_bin"),
        )

        # Measure VRAM + RAM deltas + set load order
        vram_after = _mem_monitor.read_vram_used_mb()
        ram_after = _mem_monitor.read_ram_status()
        instance.vram_delta_mb = max(0, vram_after - vram_before)
        instance.ram_delta_mb = max(0, ram_after["used_mb"] - ram_before["used_mb"])
        instance.load_order = len([i for i in manager.instances.values() if i.is_running])
        # Restore persisted protected flag
        instance.protected = bool(_model_load_configs.get(model_id, {}).get("protected", False))

        logger.info("load: model=%s ready on port %d (vram=%.0fMB ram=%.0fMB order=%d protected=%s cv=%d)",
                     model_id, instance.port, instance.vram_delta_mb, instance.ram_delta_mb,
                     instance.load_order, instance.protected, len(cv_list))
        return {"status": "loaded", "model_id": instance.model_id, "port": instance.port,
                "vram_delta_mb": round(instance.vram_delta_mb, 1),
                "ram_delta_mb": round(instance.ram_delta_mb, 1),
                "control_vectors": cv_list,
                "control_vector_layer_range": list(cv_lr_tuple) if cv_lr_tuple else None}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("load FAILED model=%s: %s", model_id, e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/mgmt/unload")
async def mgmt_unload(body: dict):
    model_ref = body.get("model_id") or body.get("model")
    if not model_ref:
        raise HTTPException(status_code=400, detail="model_id required")
    model_id = manager.resolve_model_id(model_ref) or model_ref
    await manager.unload_model(model_id)
    return {"status": "unloaded", "model_id": model_id}


@app.get("/mgmt/slots/{model_id:path}")
async def mgmt_slots(model_id: str):
    if model_id not in manager.instances:
        raise HTTPException(status_code=404, detail=f"Model not loaded: {model_id}")
    instance = manager.instances[model_id]
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(f"http://127.0.0.1:{instance.port}/slots", timeout=3.0)
            r.raise_for_status()
            return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/mgmt/logs/{model_id:path}")
async def mgmt_logs(model_id: str, last: int = 100):
    if model_id not in manager.instances:
        raise HTTPException(status_code=404, detail=f"Model not loaded: {model_id}")
    return {"logs": list(manager.instances[model_id].log_buffer)[-last:]}


@app.get("/mgmt/logs-stream/{model_id:path}")
async def mgmt_logs_stream(model_id: str):
    if model_id not in manager.instances:
        raise HTTPException(status_code=404, detail=f"Model not loaded: {model_id}")
    instance = manager.instances[model_id]

    async def generate():
        for line in list(instance.log_buffer):
            yield f"data: {json.dumps({'log': line})}\n\n"
        q = instance.subscribe_logs()
        try:
            while True:
                try:
                    line = await asyncio.wait_for(q.get(), timeout=30.0)
                    yield f"data: {json.dumps({'log': line})}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            instance.unsubscribe_logs(q)

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.get("/mgmt/daemon-logs")
async def mgmt_daemon_logs(last: int = 200):
    return {"logs": list(_daemon_log_buffer)[-last:]}


@app.post("/mgmt/kv-cache/save/{model_id:path}")
async def mgmt_kv_cache_save(model_id: str):
    if model_id not in manager.instances:
        raise HTTPException(status_code=404, detail=f"Model not loaded: {model_id}")
    if not manager.kv_cache_dir:
        raise HTTPException(status_code=400, detail="kv_cache_dir non configure")
    try:
        result = await manager.save_kv_cache(model_id)
        logger.info("kv-cache save: model=%s -> %s", model_id, result.get("path"))
        return result
    except Exception as e:
        err = str(e)
        if "400" in err:
            err = ("llama-server a refuse la sauvegarde (400). "
                   "Le modele doit etre recharge pour activer --slot-save-path.")
        logger.error("kv-cache save FAILED model=%s: %s", model_id, err)
        raise HTTPException(status_code=500, detail=err)


@app.post("/mgmt/kv-cache/restore/{model_id:path}")
async def mgmt_kv_cache_restore(model_id: str):
    if model_id not in manager.instances:
        raise HTTPException(status_code=404, detail=f"Model not loaded: {model_id}")
    if not manager.kv_cache_dir:
        raise HTTPException(status_code=400, detail="kv_cache_dir non configure")
    try:
        result = await manager.restore_kv_cache(model_id)
        logger.info("kv-cache restore: model=%s", model_id)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error("kv-cache restore FAILED model=%s: %s", model_id, e)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/mgmt/kv-cache/status/{model_id:path}")
async def mgmt_kv_cache_status(model_id: str):
    if not manager.kv_cache_dir:
        return {"model_id": model_id, "exists": False, "path": None, "kv_cache_dir_configured": False}
    path = manager.kv_cache_path(model_id)
    exists = path is not None and path.exists()
    return {
        "model_id": model_id,
        "exists": exists,
        "path": str(path) if path else None,
        "kv_cache_dir_configured": True,
    }


@app.delete("/mgmt/kv-cache/{model_id:path}")
async def mgmt_kv_cache_delete(model_id: str):
    if not manager.kv_cache_dir:
        raise HTTPException(status_code=400, detail="kv_cache_dir non configure")
    deleted = manager.delete_kv_cache(model_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Aucun KV cache trouve pour: {model_id}")
    logger.info("kv-cache delete: model=%s", model_id)
    return {"deleted": True, "model_id": model_id}


# ── Health (enrichi) ──────────────────────────────────────────────────────────

@app.post("/reboot")
async def reboot():
    """Redémarre la machine (délai 2s pour renvoyer la réponse)."""
    import subprocess
    logger.warning("Reboot machine demandé — reboot dans 2s")
    subprocess.Popen(
        ["bash", "-c", "sleep 2 && systemctl reboot"],
        start_new_session=True,
    )
    return JSONResponse(content={"status": "rebooting"})


@app.get("/health")
async def health():
    """Health check enrichi : modeles + thermal + stats systeme basiques."""
    if DEMO_MODE:
        return {
            "status": "ok", "version": DAEMON_VERSION, "demo_mode": True,
            "running_models": sum(1 for m in _DEMO_MODELS if m["running"]),
            "thermal": {"level": "nominal", "temp_c": 0, "running": False},
            "memory": {"controller_running": False, "ram_percent": 0, "vram_used_mb": 0,
                       "total_model_rss_mb": 0, "pressure": {}},
            "system": {"cpu_percent": 0, "memory_percent": 0, "gpu_vram_used_mb": 0},
        }
    from stats.system_stats import collect_system_stats
    running = sum(1 for i in manager.instances.values() if i.is_running)
    thermal = thermal_controller.get_status()
    system = collect_system_stats()
    mem_status = memory_controller.get_status() if memory_controller else {}
    return {
        "status": "ok",
        "version": DAEMON_VERSION,
        "running_models": running,
        "thermal": {
            "level": thermal["level"],
            "temp_c": thermal["temp_c"],
            "running": thermal["running"],
        },
        "memory": {
            "controller_running": mem_status.get("running", False),
            "ram_percent": system["memory"]["percent"],
            "vram_used_mb": system["gpu"]["vram_used_mb"],
            "total_model_rss_mb": sum(i.ram_rss_mb for i in manager.instances.values()),
            "pressure": mem_status.get("pressure", {}),
        },
        "system": {
            "cpu_percent": system["cpu_percent"],
            "memory_percent": system["memory"]["percent"],
            "gpu_vram_used_mb": system["gpu"]["vram_used_mb"],
        },
    }
