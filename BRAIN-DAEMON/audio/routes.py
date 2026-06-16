"""
Routes audio du daemon.

  /audio/health             status général (whisper + kokoro + omnivoice)
  /audio/voices             liste voix (Kokoro presets + OmniVoice clones)
  /audio/masters            liste presets DSP mastering
  /audio/transcriptions     STT (OpenAI compat)
  /audio/speech             TTS (OpenAI compat + master + language)
  /audio/profiles           CRUD voice profiles (OmniVoice clones)
    GET    /audio/profiles
    POST   /audio/profiles                multipart: name, ref_audio, ref_text, ...
    GET    /audio/profiles/{id}
    PATCH  /audio/profiles/{id}           JSON partial update
    DELETE /audio/profiles/{id}
  /audio/libs/*             gestion des libs Python audio (versions, upgrade)
"""
import asyncio
import json
import logging
import re

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse, Response

from audio.manager import AudioManager

logger = logging.getLogger("brain-daemon")
router = APIRouter()

_manager: AudioManager | None = None

# Regex pour extraire un champ texte d'un multipart brut
_MULTIPART_FIELD_RE = re.compile(
    rb'Content-Disposition: form-data; name="(\w+)"\r\n\r\n([^\r]*)\r\n',
)
_MULTIPART_FILE_RE = re.compile(
    rb'Content-Disposition: form-data; name="file"; filename="([^"]*)"'
    rb'\r\nContent-Type: ([^\r]*)\r\n\r\n',
)


def init_audio(config: dict) -> None:
    """Initialise le manager audio. Appelé au démarrage du daemon."""
    global _manager
    _manager = AudioManager()
    _manager.init_models(config)
    logger.info("Module audio initialisé (whisper=%s, kokoro=%s)",
                _manager._whisper_loaded, _manager._kokoro_loaded)


def _get_manager() -> AudioManager:
    if _manager is None or not _manager.loaded:
        raise HTTPException(status_code=503, detail="Audio module not loaded")
    return _manager


def _extract_multipart_field(body: bytes, field_name: str) -> str | None:
    """Extrait un champ texte simple d'un body multipart."""
    for m in _MULTIPART_FIELD_RE.finditer(body):
        if m.group(1).decode("utf-8", errors="replace") == field_name:
            return m.group(2).decode("utf-8", errors="replace").strip()
    return None


def _extract_multipart_file(body: bytes, content_type: str) -> bytes:
    """Extrait les bytes du champ fichier 'file' d'un body multipart."""
    return _extract_multipart_file_named(body, content_type, "file")


def _extract_multipart_file_named(body: bytes, content_type: str, field_name: str) -> bytes:
    """Extrait les bytes d'un fichier multipart pour un champ nommé."""
    boundary_match = re.search(rb'boundary=([^\s;]+)', content_type.encode())
    if not boundary_match:
        raise HTTPException(status_code=400, detail="Missing multipart boundary")
    boundary = b"--" + boundary_match.group(1)

    pattern = re.compile(
        rb'Content-Disposition: form-data; name="' + re.escape(field_name.encode())
        + rb'"; filename="([^"]*)"\r\nContent-Type: ([^\r]*)\r\n\r\n',
    )
    file_match = pattern.search(body)
    if not file_match:
        raise HTTPException(status_code=400, detail=f"No '{field_name}' field in multipart body")

    data_start = file_match.end()
    next_boundary = body.find(boundary, data_start)
    if next_boundary == -1:
        return body[data_start:]
    return body[data_start:next_boundary].rstrip(b"\r\n")


@router.get("/health")
async def audio_health():
    """Status des modèles audio chargés."""
    if _manager is None:
        return JSONResponse(content={"loaded": False, "detail": "Audio module not initialized"})
    return JSONResponse(content=_manager.status())


@router.get("/voices")
async def audio_voices():
    """Liste des voix Kokoro disponibles."""
    mgr = _get_manager()
    return JSONResponse(content={"voices": mgr.list_voices()})


@router.post("/transcriptions")
async def audio_transcriptions(request: Request):
    """STT : audio file → texte. Format compatible OpenAI (multipart: file + model + language)."""
    mgr = _get_manager()
    if not mgr._whisper_loaded:
        raise HTTPException(status_code=503, detail="Whisper not loaded")

    ct = request.headers.get("content-type", "")
    if "multipart/form-data" not in ct:
        raise HTTPException(status_code=400, detail="Content-Type must be multipart/form-data")

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")

    # Extraire le fichier audio et les champs optionnels
    audio_bytes = _extract_multipart_file(body, ct)
    language = _extract_multipart_field(body, "language")

    try:
        result = mgr.transcribe(audio_bytes, language=language)
        return JSONResponse(content=result)
    except Exception as e:
        logger.exception("STT error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/speech")
async def audio_speech(request: Request):
    """TTS : texte → audio. Format compatible OpenAI étendu.

    JSON body :
      input        str   (requis) — texte à synthétiser
      voice        str   — id de voix (Kokoro preset, ou 'clone:<slug>' OmniVoice, ou 'omnivoice:<instruct>')
      speed        float — 1.0 par défaut
      master       str   — preset DSP ('raw', 'warm', 'broadcast', 'cinematic', 'podcast', 'bright')
      language     str   — ISO code ('fr', 'en', ...) pour OmniVoice ; ignoré pour Kokoro
      response_format str — 'wav' (default) — accepté pour compat OpenAI, ignoré sinon
    """
    mgr = _get_manager()

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="JSON invalide")

    text = body.get("input") or ""
    if not text:
        raise HTTPException(status_code=400, detail="Champ 'input' requis")

    voice = body.get("voice") or mgr.default_voice
    speed_raw = body.get("speed")
    try:
        speed = float(speed_raw) if speed_raw is not None else None  # None = use profile default
    except (TypeError, ValueError):
        speed = None
    master = body.get("master")
    language = body.get("language")

    # Studio params (optional, all None = use defaults).
    def _maybe_float(v):
        try: return float(v) if v is not None else None
        except (TypeError, ValueError): return None
    def _maybe_int(v):
        try: return int(v) if v is not None else None
        except (TypeError, ValueError): return None

    num_step = _maybe_int(body.get("num_step"))
    guidance_scale = _maybe_float(body.get("guidance_scale"))
    pitch_semitones = _maybe_float(body.get("pitch_semitones"))
    master_peak_dbfs = _maybe_float(body.get("master_peak_dbfs"))
    master_chain = body.get("master_chain")
    if master_chain is not None and not isinstance(master_chain, list):
        master_chain = None

    # Garde-fous moteur
    is_clone = isinstance(voice, str) and voice.startswith(("clone:", "omnivoice:"))
    if is_clone and not mgr.omnivoice.loaded:
        raise HTTPException(status_code=503, detail="OmniVoice not loaded")
    if not is_clone and not mgr._kokoro_loaded:
        raise HTTPException(status_code=503, detail="Kokoro not loaded")

    try:
        audio_bytes = mgr.synthesize(
            text=text, voice=voice, speed=speed,
            master=master, language=language,
            num_step=num_step,
            guidance_scale=guidance_scale,
            pitch_semitones=pitch_semitones,
            master_chain=master_chain,
            master_peak_dbfs=master_peak_dbfs,
        )
        return Response(content=audio_bytes, media_type="audio/wav")
    except RuntimeError as e:
        # Erreur métier (profil inconnu, moteur down) — 400/503 plutôt que 500
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("TTS error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/masters")
async def audio_masters():
    """Liste des presets DSP mastering."""
    mgr = _get_manager()
    return JSONResponse(content={"masters": mgr.list_masters()})


# ── OmniVoice toggle (load/unload at runtime, no config.yaml write) ─────────


@router.get("/omnivoice/status")
async def omnivoice_status():
    """Status détaillé du moteur OmniVoice + nombre de profils."""
    mgr = _get_manager()
    return JSONResponse(content={
        **mgr.omnivoice.status(),
        "profiles_count": len(mgr.profiles.list()) if mgr.profiles else 0,
    })


@router.post("/omnivoice/load")
async def omnivoice_load(request: Request):
    """Charge le modèle OmniVoice à chaud (sans modifier config.yaml).

    Optionnel JSON body : { "num_step": 16, "guidance_scale": 2.0, "device": "auto" }
    Réutilise la dernière config si vide. Retourne le status final.
    """
    mgr = _get_manager()
    try:
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
    except Exception:
        body = {}

    # Override partiel
    cfg_override: dict = {}
    for k in ("num_step", "guidance_scale", "device", "model_path"):
        if k in body and body[k] is not None:
            cfg_override[k] = body[k]
    if cfg_override:
        # Patch en mémoire (seulement les champs fournis ; on conserve le reste)
        current_cfg = {
            "num_step": mgr.omnivoice._num_step,
            "guidance_scale": mgr.omnivoice._guidance_scale,
            "device": getattr(mgr.omnivoice, "_device_pref", "auto"),
            "model_path": getattr(mgr.omnivoice, "_model_path", ""),
        }
        current_cfg.update(cfg_override)
        mgr.omnivoice.configure(current_cfg)

    ok = mgr.omnivoice.load()
    if not ok:
        raise HTTPException(status_code=502, detail=mgr.omnivoice._load_error or "load failed")
    return JSONResponse(content=mgr.omnivoice.status())


@router.post("/omnivoice/unload")
async def omnivoice_unload():
    """Décharge le modèle OmniVoice (libère RAM/GPU). Kokoro+Whisper intacts."""
    mgr = _get_manager()
    changed = mgr.omnivoice.unload()
    return JSONResponse(content={"changed": changed, **mgr.omnivoice.status()})


# ── Voice profiles CRUD (OmniVoice clones) ───────────────────────────────────


def _require_profiles(mgr: AudioManager):
    if mgr.profiles is None:
        raise HTTPException(status_code=503, detail="VoiceProfileStore not initialised")
    return mgr.profiles


@router.get("/profiles")
async def profiles_list():
    mgr = _get_manager()
    store = _require_profiles(mgr)
    return JSONResponse(content={"profiles": store.list()})


@router.get("/profiles/{profile_id:path}")
async def profile_get(profile_id: str):
    mgr = _get_manager()
    store = _require_profiles(mgr)
    p = store.get(profile_id)
    if not p:
        raise HTTPException(status_code=404, detail="Profile not found")
    return JSONResponse(content=p)


@router.post("/profiles")
async def profile_create(request: Request):
    """Create a voice profile.

    Multipart form fields:
      name        (required)   — display name
      ref_audio   (file, opt)  — WAV/MP3/FLAC reference, 5-15s recommended
      ref_text    (str, opt)   — transcript of the reference audio
      language    (str, opt)   — ISO ('fr', 'en', ...); default 'auto'
      instruct    (str, opt)   — voice-design instruct
      description (str, opt)   — free-form description (used in voice design)
      master      (str, opt)   — default DSP preset id; 'raw' if omitted
      tags        (str, opt)   — JSON array of tags
    """
    mgr = _get_manager()
    store = _require_profiles(mgr)

    ct = request.headers.get("content-type", "")
    if "multipart/form-data" not in ct:
        raise HTTPException(status_code=400, detail="Content-Type must be multipart/form-data")

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")

    name = _extract_multipart_field(body, "name") or ""
    if not name:
        raise HTTPException(status_code=400, detail="'name' field is required")

    ref_text = _extract_multipart_field(body, "ref_text")
    language = _extract_multipart_field(body, "language") or "auto"
    instruct = _extract_multipart_field(body, "instruct")
    description = _extract_multipart_field(body, "description")
    master = _extract_multipart_field(body, "master") or "raw"
    speed_raw = _extract_multipart_field(body, "speed")
    try:
        speed = float(speed_raw) if speed_raw else 1.0
    except ValueError:
        speed = 1.0
    tags_raw = _extract_multipart_field(body, "tags")
    try:
        tags = json.loads(tags_raw) if tags_raw else []
        if not isinstance(tags, list):
            tags = []
    except Exception:
        tags = []

    ref_bytes: bytes | None = None
    if b'name="ref_audio"' in body:
        try:
            ref_bytes = _extract_multipart_file_named(body, ct, "ref_audio")
        except HTTPException:
            ref_bytes = None

    try:
        profile = store.create(
            name=name,
            ref_wav_bytes=ref_bytes,
            ref_text=ref_text,
            language=language,
            instruct=instruct,
            description=description,
            master=master,
            speed=speed,
            tags=tags,
        )
        return JSONResponse(content=profile, status_code=201)
    except Exception as e:
        logger.exception("profile create error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/profiles/{profile_id:path}")
async def profile_patch(profile_id: str, request: Request):
    mgr = _get_manager()
    store = _require_profiles(mgr)
    if not store.get(profile_id):
        raise HTTPException(status_code=404, detail="Profile not found")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="JSON invalide")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be an object")
    profile = store.update(profile_id, **body)
    return JSONResponse(content=profile)


@router.delete("/profiles/{profile_id:path}")
async def profile_delete(profile_id: str):
    mgr = _get_manager()
    store = _require_profiles(mgr)
    ok = store.delete(profile_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Profile not found")
    return JSONResponse(content={"ok": True})


# ── Libs management (versions + upgrade) ─────────────────────────────────────

_AUDIO_LIBS = ["faster-whisper", "kokoro", "soundfile", "numpy"]
_upgrade_in_progress = False
_upgrade_log: list[str] = []


def _get_lib_version(name: str) -> str | None:
    """Retourne la version installée d'un package pip, ou None."""
    try:
        from importlib.metadata import version
        return version(name)
    except Exception:
        return None


@router.get("/libs/status")
async def audio_libs_status():
    """Versions des libs audio installées."""
    libs = {}
    for name in _AUDIO_LIBS:
        libs[name] = _get_lib_version(name)
    return JSONResponse(content={
        "libs": libs,
        "upgrade_in_progress": _upgrade_in_progress,
    })


@router.post("/libs/upgrade")
async def audio_libs_upgrade():
    """Upgrade les libs audio via pip. Non-bloquant, retourne immédiatement."""
    global _upgrade_in_progress, _upgrade_log
    if _upgrade_in_progress:
        return JSONResponse(status_code=409, content={"detail": "Upgrade déjà en cours", "log": _upgrade_log})

    _upgrade_in_progress = True
    _upgrade_log = []

    async def _do_upgrade():
        global _upgrade_in_progress, _upgrade_log
        try:
            import sys
            pip_cmd = [sys.executable, "-m", "pip", "install", "--upgrade"] + _AUDIO_LIBS
            _upgrade_log.append(f"$ {' '.join(pip_cmd)}")
            logger.info("Audio libs upgrade: %s", " ".join(pip_cmd))

            proc = await asyncio.create_subprocess_exec(
                *pip_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
            output = stdout.decode("utf-8", errors="replace") if stdout else ""
            for line in output.splitlines():
                _upgrade_log.append(line)

            if proc.returncode == 0:
                _upgrade_log.append("Upgrade OK.")
                logger.info("Audio libs upgrade OK")
            else:
                _upgrade_log.append(f"Upgrade failed (exit {proc.returncode})")
                logger.warning("Audio libs upgrade failed (exit %s)", proc.returncode)
        except asyncio.TimeoutError:
            _upgrade_log.append("Upgrade timeout (300s)")
            logger.warning("Audio libs upgrade timeout")
        except Exception as e:
            _upgrade_log.append(f"Erreur: {e}")
            logger.exception("Audio libs upgrade error: %s", e)
        finally:
            _upgrade_in_progress = False

    asyncio.create_task(_do_upgrade())
    return JSONResponse(content={"ok": True, "detail": "Upgrade lancé en arrière-plan"})


@router.get("/libs/log")
async def audio_libs_log():
    """Retourne le log du dernier upgrade."""
    return JSONResponse(content={"log": _upgrade_log, "in_progress": _upgrade_in_progress})
