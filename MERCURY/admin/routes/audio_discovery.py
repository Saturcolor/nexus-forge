"""Routes admin : découverte des modèles/voix pour les providers audio (OpenAI, Groq, ElevenLabs).
Cache in-memory avec TTL 5 min pour éviter de re-fetcher l'API à chaque clic dashboard."""
import logging
import time

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from routing.router import get_config

logger = logging.getLogger("mercury")
router = APIRouter()

# ── Cache in-memory ──────────────────────────────────────────────────────────
_CACHE_TTL = 300.0  # 5 minutes

_openai_cache: dict = {"data": None, "updated_at": 0.0}
_groq_cache: dict = {"data": None, "updated_at": 0.0}
_elevenlabs_cache: dict = {"data": None, "updated_at": 0.0}


def _is_fresh(cache: dict) -> bool:
    return cache["data"] is not None and (time.monotonic() - cache["updated_at"]) < _CACHE_TTL


# ── Données hardcoded (fallback) ─────────────────────────────────────────────

_OPENAI_STT_FALLBACK = [
    {"id": "whisper-1", "name": "Whisper"},
]
_OPENAI_TTS_FALLBACK = [
    {"id": "tts-1", "name": "TTS-1"},
    {"id": "tts-1-hd", "name": "TTS-1 HD"},
]
_OPENAI_VOICES = [
    {"id": "alloy", "name": "Alloy"},
    {"id": "ash", "name": "Ash"},
    {"id": "ballad", "name": "Ballad"},
    {"id": "coral", "name": "Coral"},
    {"id": "echo", "name": "Echo"},
    {"id": "fable", "name": "Fable"},
    {"id": "nova", "name": "Nova"},
    {"id": "onyx", "name": "Onyx"},
    {"id": "sage", "name": "Sage"},
    {"id": "shimmer", "name": "Shimmer"},
    {"id": "verse", "name": "Verse"},
]

_GROQ_STT_FALLBACK = [
    {"id": "whisper-large-v3-turbo", "name": "Whisper Large V3 Turbo"},
    {"id": "distil-whisper-large-v3-en", "name": "Distil Whisper Large V3 EN"},
    {"id": "whisper-large-v3", "name": "Whisper Large V3"},
]

_ELEVENLABS_STT_MODELS = [
    {"id": "scribe_v2", "name": "Scribe V2"},
    {"id": "scribe_v1", "name": "Scribe V1"},
]

_ELEVENLABS_MODELS = [
    {"id": "eleven_multilingual_v2", "name": "Eleven Multilingual V2"},
    {"id": "eleven_turbo_v2_5", "name": "Eleven Turbo V2.5"},
    {"id": "eleven_turbo_v2", "name": "Eleven Turbo V2"},
    {"id": "eleven_monolingual_v1", "name": "Eleven Monolingual V1"},
]


# ── OpenAI Audio ─────────────────────────────────────────────────────────────

@router.get("/audio/openai/models")
async def get_openai_audio_models():
    """Découverte des modèles audio OpenAI (STT/TTS) + voix TTS."""
    config = get_config()
    api_key = (config.get("audio_openai_api_key") or "").strip()
    if not api_key:
        return JSONResponse(
            status_code=400,
            content={"detail": "Clé API OpenAI Audio manquante (audio_openai_api_key).",
                      "stt_models": [], "tts_models": [], "voices": []},
        )

    if _is_fresh(_openai_cache):
        return JSONResponse(content=_openai_cache["data"])

    stt_models = list(_OPENAI_STT_FALLBACK)
    tts_models = list(_OPENAI_TTS_FALLBACK)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if resp.status_code == 200:
            models = resp.json().get("data", [])
            api_stt = [{"id": m["id"], "name": m.get("id", "")} for m in models if "whisper" in m.get("id", "").lower()]
            api_tts = [{"id": m["id"], "name": m.get("id", "")} for m in models if "tts" in m.get("id", "").lower()]
            if api_stt:
                stt_models = api_stt
            if api_tts:
                tts_models = api_tts
        else:
            logger.warning("OpenAI GET /models: %s %s", resp.status_code, resp.text[:200])
    except Exception as e:
        logger.warning("OpenAI audio discovery fallback (API error): %s", e)

    result = {"stt_models": stt_models, "tts_models": tts_models, "voices": _OPENAI_VOICES}
    _openai_cache["data"] = result
    _openai_cache["updated_at"] = time.monotonic()
    return JSONResponse(content=result)


# ── Groq Audio ───────────────────────────────────────────────────────────────

@router.get("/audio/groq/models")
async def get_groq_audio_models():
    """Découverte des modèles STT Groq."""
    config = get_config()
    api_key = (config.get("audio_groq_api_key") or "").strip()
    if not api_key:
        return JSONResponse(
            status_code=400,
            content={"detail": "Clé API Groq Audio manquante (audio_groq_api_key).",
                      "stt_models": []},
        )

    if _is_fresh(_groq_cache):
        return JSONResponse(content=_groq_cache["data"])

    stt_models = list(_GROQ_STT_FALLBACK)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                "https://api.groq.com/openai/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if resp.status_code == 200:
            models = resp.json().get("data", [])
            api_stt = [{"id": m["id"], "name": m.get("id", "")} for m in models if "whisper" in m.get("id", "").lower()]
            if api_stt:
                stt_models = api_stt
        else:
            logger.warning("Groq GET /models: %s %s", resp.status_code, resp.text[:200])
    except Exception as e:
        logger.warning("Groq audio discovery fallback (API error): %s", e)

    result = {"stt_models": stt_models}
    _groq_cache["data"] = result
    _groq_cache["updated_at"] = time.monotonic()
    return JSONResponse(content=result)


# ── ElevenLabs ───────────────────────────────────────────────────────────────

@router.get("/audio/elevenlabs/voices")
async def get_elevenlabs_voices():
    """Découverte des voix ElevenLabs (dynamique, user-specific) + modèles TTS."""
    config = get_config()
    api_key = (config.get("audio_elevenlabs_api_key") or "").strip()
    if not api_key:
        return JSONResponse(
            status_code=400,
            content={"detail": "Clé API ElevenLabs manquante (audio_elevenlabs_api_key).",
                      "voices": [], "models": [], "stt_models": []},
        )

    if _is_fresh(_elevenlabs_cache):
        return JSONResponse(content=_elevenlabs_cache["data"])

    voices = []
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                "https://api.elevenlabs.io/v1/voices",
                headers={"xi-api-key": api_key},
            )
        if resp.status_code == 200:
            raw_voices = resp.json().get("voices", [])
            voices = [
                {
                    "voice_id": v.get("voice_id", ""),
                    "name": v.get("name", ""),
                    "category": v.get("category", ""),
                    "labels": v.get("labels") or {},
                }
                for v in raw_voices
                if v.get("voice_id")
            ]
        else:
            text = (resp.text or "")[:300]
            logger.warning("ElevenLabs GET /voices: %s %s", resp.status_code, text)
            return JSONResponse(
                status_code=resp.status_code,
                content={"detail": f"ElevenLabs API: {resp.status_code}", "voices": [], "models": _ELEVENLABS_MODELS, "stt_models": _ELEVENLABS_STT_MODELS},
            )
    except Exception as e:
        logger.warning("ElevenLabs voice discovery error: %s", e)
        return JSONResponse(
            status_code=500,
            content={"detail": str(e), "voices": [], "models": _ELEVENLABS_MODELS, "stt_models": _ELEVENLABS_STT_MODELS},
        )

    result = {"voices": voices, "models": _ELEVENLABS_MODELS, "stt_models": _ELEVENLABS_STT_MODELS}
    _elevenlabs_cache["data"] = result
    _elevenlabs_cache["updated_at"] = time.monotonic()
    return JSONResponse(content=result)


# ── Audio Local (daemon brain) — proxy routes pour le frontend ───────────────
# Le frontend ne peut pas appeler le brain directement (Tailscale),
# donc Mercury proxy les appels via ces routes admin.

def _audio_local_url() -> str | None:
    config = get_config()
    if not config.get("audio_local_enabled"):
        return None
    return (config.get("audio_local_url") or "").strip().rstrip("/") or None


@router.get("/audio/local/health")
async def get_audio_local_health():
    """Proxy vers GET {daemon}/audio/health."""
    base = _audio_local_url()
    if not base:
        return JSONResponse(content={"configured": False})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/audio/health")
        return JSONResponse(content=r.json() if r.status_code == 200 else {"error": f"HTTP {r.status_code}"})
    except Exception as e:
        return JSONResponse(content={"configured": True, "error": str(e)})


@router.get("/audio/local/voices")
async def get_audio_local_voices():
    """Proxy vers GET {daemon}/audio/voices."""
    base = _audio_local_url()
    if not base:
        return JSONResponse(content={"voices": []})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/audio/voices")
        return JSONResponse(content=r.json() if r.status_code == 200 else {"voices": []})
    except Exception as e:
        return JSONResponse(content={"voices": [], "error": str(e)})


@router.get("/audio/local/libs/status")
async def get_audio_local_libs_status():
    """Proxy vers GET {daemon}/audio/libs/status."""
    base = _audio_local_url()
    if not base:
        return JSONResponse(content={"libs": {}, "configured": False})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/audio/libs/status")
        return JSONResponse(content=r.json() if r.status_code == 200 else {"libs": {}, "error": f"HTTP {r.status_code}"})
    except Exception as e:
        return JSONResponse(content={"libs": {}, "error": str(e)})


@router.post("/audio/local/libs/upgrade")
async def post_audio_local_libs_upgrade():
    """Proxy vers POST {daemon}/audio/libs/upgrade."""
    base = _audio_local_url()
    if not base:
        return JSONResponse(status_code=503, content={"detail": "Audio local non configuré"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(f"{base}/audio/libs/upgrade")
        return JSONResponse(content=r.json(), status_code=r.status_code)
    except Exception as e:
        return JSONResponse(status_code=502, content={"detail": str(e)})


@router.get("/audio/local/libs/log")
async def get_audio_local_libs_log():
    """Proxy vers GET {daemon}/audio/libs/log."""
    base = _audio_local_url()
    if not base:
        return JSONResponse(content={"log": [], "in_progress": False})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/audio/libs/log")
        return JSONResponse(content=r.json() if r.status_code == 200 else {"log": [], "in_progress": False})
    except Exception as e:
        return JSONResponse(content={"log": [], "in_progress": False, "error": str(e)})


# ── OmniVoice (TTS clone zero-shot, opt-in côté daemon) ─────────────────────


@router.get("/audio/omnivoice/status")
async def get_audio_omnivoice_status():
    """Status OmniVoice + profiles_count. Proxy vers GET {daemon}/audio/omnivoice/status."""
    base = _audio_local_url()
    if not base:
        return JSONResponse(content={"configured": False, "loaded": False, "profiles_count": 0})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/audio/omnivoice/status")
        if r.status_code == 200:
            return JSONResponse(content={"configured": True, **r.json()})
        return JSONResponse(content={"configured": True, "loaded": False, "error": f"HTTP {r.status_code}"})
    except Exception as e:
        return JSONResponse(content={"configured": True, "loaded": False, "error": str(e)})


@router.post("/audio/omnivoice/load")
async def post_audio_omnivoice_load(payload: dict | None = None):
    """Charge OmniVoice à chaud. Body optionnel : { num_step, guidance_scale, device }."""
    base = _audio_local_url()
    if not base:
        return JSONResponse(status_code=503, content={"detail": "Audio local non configuré"})
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(f"{base}/audio/omnivoice/load", json=payload or {})
        return JSONResponse(content=r.json() if r.headers.get("content-type", "").startswith("application/json") else {"detail": r.text[:500]}, status_code=r.status_code)
    except Exception as e:
        return JSONResponse(status_code=502, content={"detail": str(e)})


@router.post("/audio/omnivoice/unload")
async def post_audio_omnivoice_unload():
    """Décharge OmniVoice (libère RAM/GPU)."""
    base = _audio_local_url()
    if not base:
        return JSONResponse(status_code=503, content={"detail": "Audio local non configuré"})
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(f"{base}/audio/omnivoice/unload")
        return JSONResponse(content=r.json(), status_code=r.status_code)
    except Exception as e:
        return JSONResponse(status_code=502, content={"detail": str(e)})


@router.get("/audio/omnivoice/profiles")
async def get_audio_omnivoice_profiles():
    """Liste les voice profiles enregistrés sur le daemon."""
    base = _audio_local_url()
    if not base:
        return JSONResponse(content={"profiles": []})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/audio/profiles")
        return JSONResponse(content=r.json() if r.status_code == 200 else {"profiles": []})
    except Exception as e:
        return JSONResponse(content={"profiles": [], "error": str(e)})


@router.delete("/audio/omnivoice/profiles/{profile_id:path}")
async def delete_audio_omnivoice_profile(profile_id: str):
    """Supprime un voice profile."""
    base = _audio_local_url()
    if not base:
        return JSONResponse(status_code=503, content={"detail": "Audio local non configuré"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.delete(f"{base}/audio/profiles/{profile_id}")
        return JSONResponse(content=r.json() if r.status_code < 400 else {"detail": r.text[:500]}, status_code=r.status_code)
    except Exception as e:
        return JSONResponse(status_code=502, content={"detail": str(e)})


@router.patch("/audio/omnivoice/profiles/{profile_id:path}")
async def patch_audio_omnivoice_profile(profile_id: str, payload: dict | None = None):
    """Édite les meta d'un voice profile (name, ref_text, language, instruct, description, master, tags, locked)."""
    base = _audio_local_url()
    if not base:
        return JSONResponse(status_code=503, content={"detail": "Audio local non configuré"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.patch(f"{base}/audio/profiles/{profile_id}", json=payload or {})
        return JSONResponse(content=r.json() if r.status_code < 400 else {"detail": r.text[:500]}, status_code=r.status_code)
    except Exception as e:
        return JSONResponse(status_code=502, content={"detail": str(e)})
