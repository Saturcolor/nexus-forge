"""FastAPI routes pour brain-daemon /atlas/*.

Montées dans daemon.py via :
    from atlas.routes import router as atlas_router, init_atlas
    app.include_router(atlas_router, prefix="/atlas")
    # puis dans startup: init_atlas(config, manager)
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from atlas.manager import AtlasManager

log = logging.getLogger("brain.atlas.routes")
router = APIRouter()

# Détecte les tags de quantification GGUF dans le path/nom : Q8_0, Q4_K_M,
# IQ2_XXS, MXFP4, F16, BF16, FP16... Capture aussi les suffixes composites
# du quant pipeline brain (ex: Q_8C_BRAIN, Q_C6v2_BRAIN).
_QUANT_RE = re.compile(
    r"(?:^|[-_.\s/\\])"
    r"(F16|BF16|FP16|MXFP4|IQ\d[_A-Z0-9]*|Q\d[_A-Z0-9]*|Q_[A-Z0-9+]+_BRAIN)"
    r"(?:[-_.\s/\\]|\.gguf$|$)",
    re.IGNORECASE,
)

# Préfixes de famille — substring case-insensitive, ordre = priorité (premier match
# gagne pour les noms ambigus genre "Qwen-Mistral-merge").
_FAMILY_PATTERNS: list[tuple[str, str]] = [
    ("gemma", "Gemma"),
    ("qwen", "Qwen"),
    ("deepseek", "DeepSeek"),
    ("nemotron", "Nemotron"),
    ("gpt-oss", "GPT-OSS"),
    ("llama", "Llama"),
    ("mistral", "Mistral"),
    ("phi", "Phi"),
    ("yi", "Yi"),
]


def _detect_quant(model_id: str, path: str | None) -> str | None:
    for blob in (model_id, path or ""):
        m = _QUANT_RE.search(blob)
        if m:
            tag = m.group(1).upper()
            if tag == "FP16":
                tag = "F16"
            return tag
    return None


def _detect_family(model_id: str) -> str | None:
    low = model_id.lower()
    for needle, label in _FAMILY_PATTERNS:
        if needle in low:
            return label
    return None

_manager: AtlasManager | None = None


def init_atlas(config: dict, brain_manager: Any | None = None) -> AtlasManager:
    """Appelé depuis daemon.py startup."""
    global _manager
    _manager = AtlasManager(config, brain_manager=brain_manager)
    log.info(f"atlas routes initialized — enabled={_manager.is_enabled()}")
    return _manager


def _require_enabled():
    if _manager is None or not _manager.is_enabled():
        raise HTTPException(
            503,
            "atlas module disabled. Enable via config.yaml: "
            "atlas:\\n  enabled: true",
        )


@router.get("/health")
async def health():
    if _manager is None:
        return {"enabled": False, "initialized": False}
    return {
        "enabled": _manager.is_enabled(),
        "initialized": True,
        "current_job": _manager.current_job(),
    }


@router.get("/models")
async def list_models():
    """Liste les modèles GGUF disponibles côté brain pour extraction.

    Réutilise brain_manager.scan_models() (même source que /mgmt/models utilisée
    par Mercury) — pas de nouveau scan, source de vérité unique. On filtre
    `kind=gguf` car le binaire `llama-extract-vector` ne mange que du GGUF.
    """
    _require_enabled()
    bm = _manager.brain_manager  # type: ignore[union-attr]
    if bm is None or not hasattr(bm, "scan_models"):
        return {
            "models": [],
            "note": "brain_manager not wired; pass via init_atlas(config, brain_manager=manager)",
        }
    raw = bm.scan_models()
    models = []
    for m in raw:
        if m.get("kind", "gguf") != "gguf":
            continue
        mid = m.get("id") or m.get("model_id") or ""
        path = m.get("path")
        models.append(
            {
                "model_id": mid,
                "path": path,
                "size_gb": m.get("size_gb"),
                "family": m.get("family") or _detect_family(mid),
                "quantization": (
                    m.get("quantization") or m.get("quant") or _detect_quant(mid, path)
                ),
                "kind": m.get("kind", "gguf"),
            }
        )
    return {"models": models, "count": len(models)}


@router.post("/extract")
async def extract_sync(request: Request):
    """Variante synchrone : exécute extract_stream et retourne le résultat final.

    Body JSON :
        {
          "model": "<hf_id_or_path>",
          "dataset": {"name": "...", "pairs": [{"pos":..., "neg":...}, ...]},
          "layer": 25,
          "dtype": "bf16",
          "device": "auto",
          "method": "diff_of_means",
          "probe_eval": true
        }

    Retourne :
        {"vector_bytes_b64": "...", "metadata": {...}}

    Pour les longues extractions, préférer /extract/stream qui pousse du progress.
    """
    _require_enabled()
    payload = await request.json()
    final = None
    error = None
    async for ev in _manager.extract_stream(payload):  # type: ignore[union-attr]
        if ev.get("event") == "result":
            final = ev
        elif ev.get("event") == "error":
            error = ev.get("message")
    if error:
        raise HTTPException(500, error)
    if not final:
        raise HTTPException(500, "no result produced")
    return {
        "vector_bytes_b64": final["vector_bytes_b64"],
        "metadata": final["metadata"],
        "size_bytes": final.get("size_bytes"),
    }


@router.post("/extract/stream")
async def extract_stream(request: Request):
    """Streaming NDJSON — chaque ligne = un événement JSON.

    Côté client (atlasmind), parser ligne par ligne.
    """
    _require_enabled()
    payload = await request.json()

    async def gen():
        async for ev in _manager.extract_stream(payload):  # type: ignore[union-attr]
            yield (json.dumps(ev) + "\n").encode("utf-8")

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@router.get("/backends")
async def list_backends():
    """Liste les binaires llama-cli candidats pour /atlas/test sur la machine brain,
    avec leur disponibilité. Le client (atlasmind) utilise ça pour peupler un
    dropdown et passer un `binary` explicite au /atlas/test."""
    _require_enabled()
    from pathlib import Path as _P

    cfg_test_binary = _manager.cfg.test_binary  # type: ignore[union-attr]
    cfg_extractor = _manager.cfg.extractor_binary  # type: ignore[union-attr]

    candidates: list[tuple[str, str]] = []
    if cfg_test_binary:
        candidates.append(("config (atlas.test_binary)", cfg_test_binary))
    # llama-completion d'abord (non-interactif, stdout = texte pur), llama-cli
    # en fallback (besoin de --single-turn et stdout pollué bannière/spinner).
    candidates += [
        ("native-turboquant (completion)", "/opt/llama-native-turboquant/bin/llama-completion"),
        ("native (completion)", "/opt/llama-native/bin/llama-completion"),
        ("atlas-build (completion)", "/opt/llamacpp-atlas/build/bin/llama-completion"),
        ("native-turboquant (cli)", "/opt/llama-native-turboquant/bin/llama-cli"),
        ("native (cli)", "/opt/llama-native/bin/llama-cli"),
        ("atlas-build (cli)", "/opt/llamacpp-atlas/build/bin/llama-cli"),
    ]
    if cfg_extractor:
        ext_parent = _P(cfg_extractor).parent
        candidates.append(("extractor-sibling (completion)", str(ext_parent / "llama-completion")))
        candidates.append(("extractor-sibling (cli)", str(ext_parent / "llama-cli")))

    backends = []
    seen: set[str] = set()
    for label, path in candidates:
        if path in seen:
            continue
        seen.add(path)
        backends.append(
            {"label": label, "path": path, "available": _P(path).exists()}
        )
    return {"backends": backends, "count": len(backends)}


@router.post("/test")
async def test_steering(request: Request):
    """Test interactif : génère une réponse avec des control vectors appliqués.

    Body :
        {
          "model": "...",
          "prompt": "...",
          "vectors": [{"path": "/path/to/vec.gguf", "alpha": 2.5, "layer": 25}, ...],
          "max_tokens": 256,
          "binary": "/opt/llama-native/bin/llama-cli"  # optional, sinon auto-discovery
        }
    """
    _require_enabled()
    payload = await request.json()
    return await _manager.test_steering(payload)  # type: ignore[union-attr]
