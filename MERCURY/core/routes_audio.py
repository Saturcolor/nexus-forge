"""
Routes audio : POST /v1/audio/transcriptions (STT), POST /v1/audio/speech (TTS), GET /api/voices.
Même flow que les cloud backends : dispatch direct, tracking in-progress, logs dashboard.

Auto-routing : si le header X-Audio-Provider est absent, Mercury déduit le provider
depuis le model name (whisper-1 → openai, whisper-large-v3-turbo → groq, etc.).

Note : la route STT proxy le body multipart brut vers le provider upstream (pas de parsing
côté Mercury). Cela évite la dépendance python-multipart tout en étant plus correct pour un proxy.
"""
import asyncio
import logging
import re
import time
import uuid

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, Response

from auth import resolve_user
from routing.router import get_config
import httpx
from providers.audio import get_audio_backend
from app_queue.request_queue import (
    log_api_request,
    register_api_request_in_progress,
    unregister_api_request_in_progress,
)

logger = logging.getLogger("mercury")

# ── Content-Type par format audio (pour la réponse TTS) ──────────────────────
_AUDIO_CONTENT_TYPES = {
    "mp3": "audio/mpeg",
    "opus": "audio/opus",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "wav": "audio/wav",
    "pcm": "audio/pcm",
}

# ── Auto-routing : model name → provider ─────────────────────────────────────
_MODEL_TO_PROVIDER = {
    # OpenAI STT
    "whisper-1": "openai",
    # OpenAI TTS
    "tts-1": "openai",
    "tts-1-hd": "openai",
    # Groq STT
    "whisper-large-v3-turbo": "groq",
    "whisper-large-v3": "groq",
    "distil-whisper-large-v3-en": "groq",
    # ElevenLabs TTS
    "eleven_multilingual_v2": "elevenlabs",
    "eleven_turbo_v2_5": "elevenlabs",
    "eleven_turbo_v2": "elevenlabs",
    "eleven_monolingual_v1": "elevenlabs",
    # ElevenLabs STT (Scribe)
    "scribe_v2": "elevenlabs",
    "scribe_v1": "elevenlabs",
    # Local (Kokoro TTS + Faster Whisper STT)
    "kokoro": "local",
    "local/whisper": "local",
    "local/kokoro": "local",
}

# ── Données statiques pour GET /api/voices ───────────────────────────────────
_OPENAI_STT = [{"name": "whisper-1", "provider": "openai"}]
_OPENAI_TTS = [
    {"name": "tts-1", "provider": "openai"},
    {"name": "tts-1-hd", "provider": "openai"},
]
_OPENAI_VOICES = [
    {"name": n, "provider": "openai"}
    for n in ("alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse")
]
_GROQ_STT = [
    {"name": "whisper-large-v3-turbo", "provider": "groq"},
    {"name": "distil-whisper-large-v3-en", "provider": "groq"},
    {"name": "whisper-large-v3", "provider": "groq"},
]
_ELEVENLABS_STT = [
    {"name": "scribe_v2", "provider": "elevenlabs"},
    {"name": "scribe_v1", "provider": "elevenlabs"},
]
_ELEVENLABS_TTS = [
    {"name": "eleven_multilingual_v2", "provider": "elevenlabs"},
    {"name": "eleven_turbo_v2_5", "provider": "elevenlabs"},
    {"name": "eleven_turbo_v2", "provider": "elevenlabs"},
    {"name": "eleven_monolingual_v1", "provider": "elevenlabs"},
]

# ── Realtime models discovery (consommé par NCM via /api/voices) ────────────
# Liste filtrée GA-only : preview models (`gpt-4o-realtime-preview-*`) requièrent
# le header beta qu'on ne pose pas → non joignables → on les expose pas.
_REALTIME_FALLBACK = [
    {"name": "gpt-realtime-translate", "provider": "openai"},
    {"name": "gpt-realtime-2", "provider": "openai"},
    {"name": "gpt-realtime-1.5", "provider": "openai"},
    {"name": "gpt-realtime", "provider": "openai"},
    {"name": "gpt-realtime-mini", "provider": "openai"},
    {"name": "gpt-realtime-whisper", "provider": "openai"},
]
_REALTIME_CACHE: dict = {"data": None, "updated_at": 0.0}
_REALTIME_CACHE_TTL = 300.0  # 5 min, aligné sur audio_discovery.py
_REALTIME_CACHE_LOCK = asyncio.Lock()


async def _fetch_realtime_models(api_key: str) -> list[dict]:
    """Liste les modèles realtime GA via OpenAI /v1/models. Fallback hardcodé si l'appel échoue.

    Le Lock garantit qu'un seul appel HTTP part en cas d'appels concurrents sur un cache vide
    (double-check pattern : vérif rapide hors lock → lock → re-check avant appel réseau).
    """
    now = time.monotonic()
    # Double-check hors lock (cas chaud : cache valide)
    if _REALTIME_CACHE["data"] is not None and now - _REALTIME_CACHE["updated_at"] < _REALTIME_CACHE_TTL:
        return _REALTIME_CACHE["data"]
    async with _REALTIME_CACHE_LOCK:
        # Re-check à l'intérieur du lock : un autre coroutine a pu remplir le cache
        # pendant qu'on attendait l'acquisition.
        now = time.monotonic()
        if _REALTIME_CACHE["data"] is not None and now - _REALTIME_CACHE["updated_at"] < _REALTIME_CACHE_TTL:
            return _REALTIME_CACHE["data"]
        out: list[dict] = []
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(
                    "https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
            if r.status_code == 200:
                for m in r.json().get("data", []):
                    mid = m.get("id", "")
                    # GA-only: `gpt-realtime*`. Preview (`gpt-4o-realtime-preview-*`) exclu.
                    if mid.lower().startswith("gpt-realtime"):
                        out.append({"name": mid, "provider": "openai"})
                out.sort(key=lambda x: x["name"])
            else:
                logger.warning("Realtime models discovery: OpenAI /v1/models HTTP %s", r.status_code)
        except Exception as e:
            logger.warning("Realtime models discovery error: %s", e)
        if not out:
            out = list(_REALTIME_FALLBACK)
        _REALTIME_CACHE["data"] = out
        _REALTIME_CACHE["updated_at"] = now
        return out

# ── Regex pour extraire un champ texte d'un body multipart ───────────────────
_MULTIPART_FIELD_RE = re.compile(
    rb'Content-Disposition: form-data; name="(\w+)"\r\n\r\n([^\r]*)\r\n',
)


def _extract_multipart_field(body: bytes, field_name: str) -> str | None:
    """Extrait un champ texte simple d'un body multipart sans dépendance externe."""
    for m in _MULTIPART_FIELD_RE.finditer(body):
        if m.group(1).decode("utf-8", errors="replace") == field_name:
            return m.group(2).decode("utf-8", errors="replace").strip()
    return None


def _resolve_provider_with_model(
    request: Request,
    header_name: str,
    config_key: str,
    config: dict,
    model: str | None = None,
    voice: str | None = None,
) -> str:
    """Résout le provider audio : header > voice prefix > model name > default config.

    Le voice prefix `clone:*` ou `omnivoice:*` force le provider `local`
    (brain-daemon expose OmniVoice TTS clone zero-shot).
    """
    # 1. Header explicite
    provider = (request.headers.get(header_name) or "").strip().lower()
    if provider:
        return provider
    # 2. Voice prefix (clone:* / omnivoice:* → local)
    if voice:
        v = voice.strip().lower()
        if v.startswith("clone:") or v.startswith("omnivoice:"):
            return "local"
    # 3. Auto-routing par model name
    if model:
        m = model.strip().lower()
        if m in _MODEL_TO_PROVIDER:
            return _MODEL_TO_PROVIDER[m]
        if m == "omnivoice":
            return "local"
    # 4. Fallback config
    return (config.get(config_key) or "openai").strip().lower()


def _check_enabled(provider: str, config: dict) -> None:
    """Vérifie que le provider audio est activé. Lève HTTPException 503 sinon."""
    key = f"audio_{provider}_enabled"
    if not config.get(key, False):
        raise HTTPException(status_code=503, detail=f"Audio provider '{provider}' is not enabled")


def register(app: FastAPI):
    """Enregistre les routes audio sur l'app."""

    # ── GET /api/voices ──────────────────────────────────────────────────
    @app.get("/api/voices")
    async def api_voices():
        """Retourne les modèles STT/TTS et voix disponibles depuis les providers audio activés."""
        config = get_config()
        stt_models = []
        tts_models = []
        voices = []

        if config.get("audio_openai_enabled"):
            stt_models.extend(_OPENAI_STT)
            tts_models.extend(_OPENAI_TTS)
            voices.extend(_OPENAI_VOICES)

        if config.get("audio_groq_enabled"):
            stt_models.extend(_GROQ_STT)

        if config.get("audio_elevenlabs_enabled"):
            stt_models.extend(_ELEVENLABS_STT)
            tts_models.extend(_ELEVENLABS_TTS)
            # Voix depuis le voice_map config
            voice_map = config.get("audio_elevenlabs_voice_map") or {}
            for name, voice_id in voice_map.items():
                voices.append({"name": name, "provider": "elevenlabs", "voice_id": voice_id})

        # Local (daemon brain — Kokoro TTS + Faster Whisper STT + OmniVoice TTS clone)
        if config.get("audio_local_enabled"):
            audio_local_url = (config.get("audio_local_url") or "").strip().rstrip("/")
            stt_models.append({"name": "local/whisper", "provider": "local"})
            tts_models.append({"name": "kokoro", "provider": "local"})
            # Voix + détection OmniVoice depuis le daemon
            if audio_local_url:
                try:
                    async with httpx.AsyncClient(timeout=5.0) as client:
                        resp = await client.get(f"{audio_local_url}/audio/voices")
                    if resp.status_code == 200:
                        daemon_voices = resp.json().get("voices", []) or []
                        # OmniVoice est exposé en tant que modèle TTS dès qu'au moins
                        # un voice profile (clone:*) ou la liste auto-voice est servie.
                        if any(v.get("engine") == "omnivoice" for v in daemon_voices):
                            tts_models.append({"name": "omnivoice", "provider": "local"})
                        for v in daemon_voices:
                            voice_entry = {
                                "name": v.get("id", ""),
                                "provider": "local",
                                "display_name": v.get("name", ""),
                            }
                            # Préserver le champ `engine` ('kokoro' / 'omnivoice') pour
                            # que les UIs puissent grouper Kokoro presets vs OmniVoice clones.
                            if v.get("engine"):
                                voice_entry["engine"] = v["engine"]
                            voices.append(voice_entry)
                except Exception:
                    pass  # Daemon down — on retourne les modèles sans les voix

        # Realtime models (additif, non-breaking pour les clients qui ne lisent pas le champ).
        # Gating: clé OpenAI configurée (`realtime_enabled` peut être off — on liste quand même
        # pour qu'NCM puisse afficher le choix avant que le toggle admin soit flippé).
        realtime_models: list[dict] = []
        openai_key = (config.get("audio_openai_api_key") or "").strip()
        if openai_key:
            realtime_models = await _fetch_realtime_models(openai_key)

        return {
            "stt_models": stt_models,
            "tts_models": tts_models,
            "voices": voices,
            "realtime_models": realtime_models,
        }

    # ── POST /v1/audio/transcriptions (STT) ──────────────────────────────
    @app.post("/v1/audio/transcriptions")
    async def audio_transcriptions(request: Request):
        config = get_config()

        # Auth
        authorization = request.headers.get("Authorization")
        user_id, _priority, _threshold = resolve_user(authorization)
        if config.get("require_api_key") and user_id in ("anonymous", "unknown"):
            raise HTTPException(status_code=401, detail="Token API invalide ou manquant")

        # Slot guard (F1 rapport fonctionnel)
        from scheduler import state as slot_state
        rej = slot_state.build_slot_rejection(user_id)
        if rej is not None:
            return JSONResponse(**rej["response"])

        # Lire le body brut et le Content-Type (contient le boundary multipart)
        content_type = request.headers.get("content-type", "")
        if "multipart/form-data" not in content_type:
            raise HTTPException(status_code=400, detail="Content-Type must be multipart/form-data")
        body = await request.body()
        if not body:
            raise HTTPException(status_code=400, detail="Empty body")

        # Extraire le model pour l'auto-routing et le logging
        model = _extract_multipart_field(body, "model") or "whisper-1"

        # Provider (auto-routing par model name si pas de header)
        provider = _resolve_provider_with_model(request, "X-Audio-Provider", "audio_default_stt_provider", config, model)
        _check_enabled(provider, config)
        backend_name = f"audio_{provider}"
        request_id = str(uuid.uuid4())[:8]

        logger.info("Audio STT: provider=%s model=%s user=%s (request %s)", provider, model, user_id, request_id)

        await register_api_request_in_progress(request_id, model, user_id, backend_name)
        try:
            backend = get_audio_backend(provider, config)
            t0 = time.perf_counter()
            result = await backend.transcribe(body=body, content_type=content_type)
            duration_ms = (time.perf_counter() - t0) * 1000
            log_api_request(request_id, user_id, model, backend_name, "ok", duration_ms)
            return JSONResponse(content=result)
        except (ValueError, NotImplementedError) as e:
            log_api_request(request_id, user_id, model, backend_name, "error", error_detail=str(e)[:500])
            status = 400 if isinstance(e, NotImplementedError) else 503
            raise HTTPException(status_code=status, detail=str(e))
        except Exception as e:
            log_api_request(request_id, user_id, model, backend_name, "error", error_detail=str(e)[:500])
            raise HTTPException(status_code=502, detail=str(e))
        finally:
            await unregister_api_request_in_progress(request_id)

    # ── POST /v1/audio/speech (TTS) ──────────────────────────────────────
    @app.post("/v1/audio/speech")
    async def audio_speech(request: Request):
        config = get_config()

        # Auth
        authorization = request.headers.get("Authorization")
        user_id, _priority, _threshold = resolve_user(authorization)
        if config.get("require_api_key") and user_id in ("anonymous", "unknown"):
            raise HTTPException(status_code=401, detail="Token API invalide ou manquant")

        # Slot guard (F1 rapport fonctionnel)
        from scheduler import state as slot_state
        rej = slot_state.build_slot_rejection(user_id)
        if rej is not None:
            return JSONResponse(**rej["response"])

        # Body JSON
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="JSON invalide")
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Le body doit être un objet JSON")

        text = body.get("input") or ""
        if not text:
            raise HTTPException(status_code=400, detail="Champ 'input' requis (texte à synthétiser)")
        model = body.get("model", "tts-1")
        voice = body.get("voice", "nova")
        try:
            speed = float(body.get("speed") or 1.0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Paramètre 'speed' invalide — doit être un nombre flottant")
        response_format = body.get("response_format", "mp3")

        # Extras OmniVoice / Voice Studio (passthrough vers le local backend si présents)
        master = body.get("master")
        language = body.get("language")
        studio_extras = {
            k: body.get(k)
            for k in ("num_step", "guidance_scale", "pitch_semitones", "master_chain", "master_peak_dbfs")
            if body.get(k) is not None
        }

        # Provider (header > voice prefix clone:/omnivoice: > model name > default)
        provider = _resolve_provider_with_model(
            request, "X-Audio-Provider", "audio_default_tts_provider",
            config, model=model, voice=voice,
        )
        _check_enabled(provider, config)
        backend_name = f"audio_{provider}"
        request_id = str(uuid.uuid4())[:8]

        logger.info("Audio TTS: provider=%s model=%s voice=%s user=%s (request %s)", provider, model, voice, user_id, request_id)

        await register_api_request_in_progress(request_id, model, user_id, backend_name)
        try:
            backend = get_audio_backend(provider, config)
            t0 = time.perf_counter()
            speech_kwargs: dict = dict(
                text=text,
                model=model,
                voice=voice,
                speed=speed,
                response_format=response_format,
            )
            # Champs OmniVoice : seuls les backends qui les acceptent les utilisent,
            # les autres ignorent via **extras dans leur signature ou un filtrage côté backend.
            if master is not None:
                speech_kwargs["master"] = master
            if language is not None:
                speech_kwargs["language"] = language
            speech_kwargs.update(studio_extras)
            audio_bytes = await backend.speech(**speech_kwargs)
            duration_ms = (time.perf_counter() - t0) * 1000
            log_api_request(request_id, user_id, model, backend_name, "ok", duration_ms)

            content_type = _AUDIO_CONTENT_TYPES.get(response_format, "audio/mpeg")
            return Response(content=audio_bytes, media_type=content_type)
        except (ValueError, NotImplementedError) as e:
            log_api_request(request_id, user_id, model, backend_name, "error", error_detail=str(e)[:500])
            status = 400 if isinstance(e, NotImplementedError) else 503
            raise HTTPException(status_code=status, detail=str(e))
        except Exception as e:
            log_api_request(request_id, user_id, model, backend_name, "error", error_detail=str(e)[:500])
            raise HTTPException(status_code=502, detail=str(e))
        finally:
            await unregister_api_request_in_progress(request_id)

    # ── Voice profiles proxy (OmniVoice clones via local backend) ──────────
    @app.get("/api/voices/profiles")
    async def voice_profiles_list():
        config = get_config()
        if not config.get("audio_local_enabled"):
            return {"profiles": []}
        audio_local_url = (config.get("audio_local_url") or "").strip().rstrip("/")
        if not audio_local_url:
            return {"profiles": []}
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{audio_local_url}/audio/profiles")
            if resp.status_code == 200:
                return resp.json()
            raise HTTPException(status_code=resp.status_code, detail=resp.text[:500])
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"daemon unreachable: {e}")

    @app.post("/api/voices/profiles")
    async def voice_profiles_create(request: Request):
        """Proxy le multipart vers le daemon brain (champs : name, ref_audio, ref_text, ...)."""
        config = get_config()
        if not config.get("audio_local_enabled"):
            raise HTTPException(status_code=503, detail="Local audio provider not enabled")
        audio_local_url = (config.get("audio_local_url") or "").strip().rstrip("/")
        if not audio_local_url:
            raise HTTPException(status_code=503, detail="audio_local_url not configured")

        ct = request.headers.get("content-type", "")
        if "multipart/form-data" not in ct:
            raise HTTPException(status_code=400, detail="Content-Type must be multipart/form-data")
        body = await request.body()
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{audio_local_url}/audio/profiles",
                    headers={"Content-Type": ct},
                    content=body,
                )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"daemon unreachable: {e}")
        return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type", "application/json"))

    @app.patch("/api/voices/profiles/{profile_id:path}")
    async def voice_profiles_patch(profile_id: str, request: Request):
        """Édite les meta d'un profil (name, ref_text, language, instruct, description, master, tags, locked).
        Pas de modification du ref_audio — ça demanderait un re-upload via POST.
        """
        config = get_config()
        if not config.get("audio_local_enabled"):
            raise HTTPException(status_code=503, detail="Local audio provider not enabled")
        audio_local_url = (config.get("audio_local_url") or "").strip().rstrip("/")
        if not audio_local_url:
            raise HTTPException(status_code=503, detail="audio_local_url not configured")
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="JSON invalide")
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body must be an object")
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.patch(
                    f"{audio_local_url}/audio/profiles/{profile_id}",
                    json=body,
                )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"daemon unreachable: {e}")
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text[:500])
        return resp.json()

    @app.delete("/api/voices/profiles/{profile_id:path}")
    async def voice_profiles_delete(profile_id: str):
        config = get_config()
        if not config.get("audio_local_enabled"):
            raise HTTPException(status_code=503, detail="Local audio provider not enabled")
        audio_local_url = (config.get("audio_local_url") or "").strip().rstrip("/")
        if not audio_local_url:
            raise HTTPException(status_code=503, detail="audio_local_url not configured")
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.delete(f"{audio_local_url}/audio/profiles/{profile_id}")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"daemon unreachable: {e}")
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text[:500])
        return resp.json()
