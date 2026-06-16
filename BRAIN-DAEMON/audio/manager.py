"""
AudioManager — Gère le lifecycle des modèles audio.
  • Faster Whisper (STT)
  • Kokoro (TTS preset voices, 24kHz, rapide CPU)
  • OmniVoice (TTS clone zero-shot, 24kHz, GPU recommandé, 646 langues)

Les moteurs sont chargés au démarrage et restent en mémoire. OmniVoice est
opt-in via config (omnivoice.enabled = true) car ~2-4 GB GPU et torch.compile.
"""
import io
import logging
import time
from pathlib import Path
from typing import Optional

from audio.omnivoice_engine import OmniVoiceEngine
from audio.voice_profiles import VoiceProfileStore
from audio import dsp

logger = logging.getLogger("brain-daemon")

# Voix Kokoro connues avec métadonnées (id → display name)
# Préfixe : a=american, b=british, f=french, j=japanese
# Deuxième lettre : f=female, m=male
_KOKORO_VOICES = {
    # American English
    "af_heart": "Heart (F, US)",
    "af_alloy": "Alloy (F, US)",
    "af_aoede": "Aoede (F, US)",
    "af_bella": "Bella (F, US)",
    "af_jessica": "Jessica (F, US)",
    "af_kore": "Kore (F, US)",
    "af_nicole": "Nicole (F, US)",
    "af_nova": "Nova (F, US)",
    "af_river": "River (F, US)",
    "af_sarah": "Sarah (F, US)",
    "af_sky": "Sky (F, US)",
    "am_adam": "Adam (M, US)",
    "am_echo": "Echo (M, US)",
    "am_eric": "Eric (M, US)",
    "am_fenrir": "Fenrir (M, US)",
    "am_liam": "Liam (M, US)",
    "am_michael": "Michael (M, US)",
    "am_onyx": "Onyx (M, US)",
    # British English
    "bf_alice": "Alice (F, UK)",
    "bf_emma": "Emma (F, UK)",
    "bf_isabella": "Isabella (F, UK)",
    "bf_lily": "Lily (F, UK)",
    "bm_daniel": "Daniel (M, UK)",
    "bm_fable": "Fable (M, UK)",
    "bm_george": "George (M, UK)",
    "bm_lewis": "Lewis (M, UK)",
    # French
    "ff_siwis": "Siwis (F, FR)",
    # Japanese
    "jf_alpha": "Alpha (F, JP)",
    "jf_gongitsune": "Gongitsune (F, JP)",
    "jm_kumo": "Kumo (M, JP)",
}


class AudioManager:
    """Gestionnaire audio : charge Whisper + Kokoro + OmniVoice et expose STT/TTS."""

    def __init__(self):
        self.whisper_model = None
        self.kokoro_pipeline = None
        self.whisper_model_name: str = ""
        self.kokoro_lang: str = "a"
        self.default_voice: str = "af_heart"
        self._whisper_loaded = False
        self._kokoro_loaded = False
        self.omnivoice = OmniVoiceEngine()
        self.profiles: Optional[VoiceProfileStore] = None

    @property
    def loaded(self) -> bool:
        return self._whisper_loaded or self._kokoro_loaded or self.omnivoice.loaded

    def init_models(self, config: dict) -> None:
        """Charge les modèles en mémoire. Appelé une seule fois au démarrage."""
        # ── Faster Whisper (STT) ──
        whisper_model_name = config.get("whisper_model", "large-v3-turbo")
        whisper_device = config.get("whisper_device", "auto")
        whisper_compute = config.get("whisper_compute_type", "int8")
        try:
            from faster_whisper import WhisperModel
            logger.info("Chargement Whisper '%s' (device=%s, compute=%s)...", whisper_model_name, whisper_device, whisper_compute)
            t0 = time.monotonic()
            self.whisper_model = WhisperModel(
                whisper_model_name,
                device=whisper_device,
                compute_type=whisper_compute,
            )
            dt = time.monotonic() - t0
            self.whisper_model_name = whisper_model_name
            self._whisper_loaded = True
            logger.info("Whisper '%s' chargé en %.1fs", whisper_model_name, dt)
        except Exception as e:
            logger.error("Erreur chargement Whisper: %s", e)
            self._whisper_loaded = False

        # ── Kokoro (TTS) ──
        self.kokoro_lang = config.get("kokoro_lang", "a")
        self.default_voice = config.get("default_voice", "af_heart")
        try:
            from kokoro import KPipeline
            logger.info("Chargement Kokoro (lang=%s)...", self.kokoro_lang)
            t0 = time.monotonic()
            self.kokoro_pipeline = KPipeline(lang_code=self.kokoro_lang)
            dt = time.monotonic() - t0
            self._kokoro_loaded = True
            logger.info("Kokoro chargé en %.1fs (voix par défaut: %s)", dt, self.default_voice)
        except Exception as e:
            logger.error("Erreur chargement Kokoro: %s", e)
            self._kokoro_loaded = False

        # ── OmniVoice (TTS clone zero-shot) — opt-in ──
        ov_cfg = config.get("omnivoice", {}) or {}
        voices_dir = ov_cfg.get("voices_dir") or "~/.local/share/brain-daemon/voices"
        try:
            self.profiles = VoiceProfileStore(voices_dir)
        except Exception as e:
            logger.error("VoiceProfileStore init failed: %s", e)
            self.profiles = None

        if ov_cfg.get("enabled", False):
            self.omnivoice.configure(ov_cfg)
            try:
                self.omnivoice.load()
            except Exception as e:
                logger.error("OmniVoice load raised: %s", e)
        else:
            logger.info("OmniVoice désactivé (omnivoice.enabled=false)")

    def transcribe(self, audio_bytes: bytes, language: Optional[str] = None) -> dict:
        """STT : audio bytes → {"text": "..."}"""
        if not self._whisper_loaded or self.whisper_model is None:
            raise RuntimeError("Whisper non chargé")

        audio_file = io.BytesIO(audio_bytes)
        segments, info = self.whisper_model.transcribe(
            audio_file,
            language=language,
            beam_size=5,
            vad_filter=True,
        )
        text = " ".join(seg.text.strip() for seg in segments)
        return {
            "text": text,
            "language": info.language,
            "duration": round(info.duration, 2),
        }

    def synthesize(
        self,
        text: str,
        voice: Optional[str] = None,
        speed: Optional[float] = None,
        *,
        master: Optional[str] = None,
        language: Optional[str] = None,
        # Studio params : overrides per-call. None = use profile/config default.
        num_step: Optional[int] = None,
        guidance_scale: Optional[float] = None,
        pitch_semitones: Optional[float] = None,
        master_chain: Optional[list] = None,
        master_peak_dbfs: Optional[float] = None,
    ) -> bytes:
        """TTS : texte → audio bytes (WAV).

        Routing :
          • voice startswith 'clone:' → OmniVoice avec voice_profile (clone/design)
          • voice startswith 'omnivoice:' ou vide avec language non-EN → OmniVoice auto
          • sinon → Kokoro (preset US/UK/FR/JP)

        speed = None → utilise profile.speed (pour les clones) ou 1.0 (sinon).
        master = id preset DSP appliqué post-synth (None = pas de master, 'raw' aussi).
        master_chain = liste d'effets DSP custom (override preset si fourni).
        pitch_semitones = décalage de hauteur en demi-tons (±12 typique), post-DSP.
        num_step / guidance_scale = override des defaults OmniVoice (ignorés Kokoro).
        master_peak_dbfs = target peak normalize après DSP (default -2.0).
        """
        voice = (voice or "").strip() or self.default_voice

        kw_extra = {
            "num_step": num_step,
            "guidance_scale": guidance_scale,
            "pitch_semitones": pitch_semitones,
            "master_chain": master_chain,
            "master_peak_dbfs": master_peak_dbfs,
        }

        # ── Route 1 : voice clone OmniVoice ──
        if voice.startswith("clone:"):
            return self._synth_omnivoice_clone(voice, text, speed=speed, master=master, language=language, **kw_extra)

        # ── Route 2 : OmniVoice "auto voice" (sans ref) ──
        if voice.startswith("omnivoice:"):
            return self._synth_omnivoice_design(voice, text, speed=speed, master=master, language=language, **kw_extra)

        # ── Route 3 : Kokoro (default) — num_step/guidance_scale ignorés ──
        return self._synth_kokoro(
            text, voice=voice, speed=speed if speed is not None else 1.0,
            master=master,
            pitch_semitones=pitch_semitones,
            master_chain=master_chain,
            master_peak_dbfs=master_peak_dbfs,
        )

    def _synth_kokoro(
        self, text: str, *,
        voice: str, speed: float,
        master: Optional[str],
        pitch_semitones: Optional[float] = None,
        master_chain: Optional[list] = None,
        master_peak_dbfs: Optional[float] = None,
    ) -> bytes:
        if not self._kokoro_loaded or self.kokoro_pipeline is None:
            raise RuntimeError("Kokoro non chargé")
        import numpy as np
        import soundfile as sf

        audio_segments = []
        for _, _, audio in self.kokoro_pipeline(text, voice=voice, speed=speed):
            audio_segments.append(audio)
        if not audio_segments:
            raise RuntimeError("Kokoro n'a produit aucun audio")
        full_audio = np.concatenate(audio_segments)

        # DSP : custom chain > preset, puis pitch shift, puis normalize.
        if master_chain:
            full_audio = dsp.apply_chain(full_audio, 24000, master_chain)
        elif master and master != "raw":
            full_audio = dsp.apply_preset(full_audio, 24000, master)
        if pitch_semitones:
            full_audio = dsp.shift_pitch(full_audio, 24000, pitch_semitones)
        if master_chain or (master and master != "raw") or pitch_semitones:
            full_audio = dsp.normalize_peak(full_audio, target_dbfs=master_peak_dbfs if master_peak_dbfs is not None else -2.0)

        buf = io.BytesIO()
        sf.write(buf, full_audio, 24000, format="WAV")
        buf.seek(0)
        return buf.read()

    def _synth_omnivoice_clone(
        self, voice: str, text: str, *,
        speed: Optional[float], master: Optional[str], language: Optional[str],
        num_step: Optional[int] = None,
        guidance_scale: Optional[float] = None,
        pitch_semitones: Optional[float] = None,
        master_chain: Optional[list] = None,
        master_peak_dbfs: Optional[float] = None,
    ) -> bytes:
        if not self.omnivoice.loaded:
            raise RuntimeError("OmniVoice non chargé (omnivoice.enabled=false ou erreur de chargement)")
        if self.profiles is None:
            raise RuntimeError("VoiceProfileStore non initialisé")
        profile = self.profiles.get(voice)
        if not profile:
            raise RuntimeError(f"Voice profile inconnu : {voice}")
        if not profile.get("ref_path"):
            raise RuntimeError(f"Voice profile {voice} sans ref_audio — ne peut pas cloner")

        # speed: explicit request value > profile.speed > 1.0
        effective_speed = speed if speed is not None else float(profile.get("speed") or 1.0)

        wav, sr = self.omnivoice.synthesize(
            text,
            ref_audio=profile["ref_path"],
            ref_text=profile.get("ref_text"),
            instruct=profile.get("instruct"),
            description=profile.get("description"),
            language=language or profile.get("language"),
            speed=effective_speed,
            num_step=num_step,
            guidance_scale=guidance_scale,
        )
        return self._post_master(
            wav, sr,
            master or profile.get("master") or "raw",
            master_chain=master_chain,
            pitch_semitones=pitch_semitones,
            master_peak_dbfs=master_peak_dbfs,
        )

    def _synth_omnivoice_design(
        self, voice: str, text: str, *,
        speed: Optional[float], master: Optional[str], language: Optional[str],
        num_step: Optional[int] = None,
        guidance_scale: Optional[float] = None,
        pitch_semitones: Optional[float] = None,
        master_chain: Optional[list] = None,
        master_peak_dbfs: Optional[float] = None,
    ) -> bytes:
        if not self.omnivoice.loaded:
            raise RuntimeError("OmniVoice non chargé")
        # voice = 'omnivoice:<instruct>' où instruct est libre. Vide → auto voice.
        instruct = voice.split(":", 1)[1].strip() or None
        wav, sr = self.omnivoice.synthesize(
            text,
            instruct=instruct,
            language=language,
            speed=speed if speed is not None else 1.0,
            num_step=num_step,
            guidance_scale=guidance_scale,
        )
        return self._post_master(
            wav, sr,
            master or "raw",
            master_chain=master_chain,
            pitch_semitones=pitch_semitones,
            master_peak_dbfs=master_peak_dbfs,
        )

    def _post_master(
        self, wav_bytes: bytes, sr: int, preset: str,
        *,
        master_chain: Optional[list] = None,
        pitch_semitones: Optional[float] = None,
        master_peak_dbfs: Optional[float] = None,
    ) -> bytes:
        """Decode WAV → apply DSP chain/preset → pitch shift → normalize → re-encode."""
        needs_dsp = bool(master_chain) or (preset and preset != "raw") or bool(pitch_semitones)
        if not needs_dsp:
            return wav_bytes
        import numpy as np  # noqa: F401 — kept for future numpy ops
        import soundfile as sf
        buf = io.BytesIO(wav_bytes)
        arr, sr_read = sf.read(buf, dtype="float32", always_2d=False)
        if arr.ndim > 1:
            arr = arr.mean(axis=1)
        # 1) Custom chain (overrides preset) > preset
        if master_chain:
            arr = dsp.apply_chain(arr, sr_read, master_chain)
        elif preset and preset != "raw":
            arr = dsp.apply_preset(arr, sr_read, preset)
        # 2) Pitch shift
        if pitch_semitones:
            arr = dsp.shift_pitch(arr, sr_read, pitch_semitones)
        # 3) Normalize to target peak
        arr = dsp.normalize_peak(arr, target_dbfs=master_peak_dbfs if master_peak_dbfs is not None else -2.0)
        out = io.BytesIO()
        sf.write(out, arr, sr_read, format="WAV", subtype="PCM_16")
        out.seek(0)
        return out.read()

    def list_voices(self) -> list[dict]:
        """Retourne la liste des voix disponibles (Kokoro presets + OmniVoice clones)."""
        voices: list[dict] = []
        for voice_id, display_name in _KOKORO_VOICES.items():
            voices.append({
                "id": voice_id,
                "name": display_name,
                "engine": "kokoro",
                "provider": "local",
            })
        if self.profiles is not None and self.omnivoice.loaded:
            for p in self.profiles.list():
                voices.append({
                    "id": p["id"],
                    "name": p["name"],
                    "engine": "omnivoice",
                    "provider": "local",
                    "language": p.get("language"),
                    "tags": p.get("tags") or [],
                    "locked": p.get("locked", False),
                    "has_ref": bool(p.get("ref_path")),
                    "master": p.get("master") or "raw",
                })
        return voices

    def list_masters(self) -> list[dict]:
        return dsp.list_presets()

    def status(self) -> dict:
        """Status des modèles audio."""
        return {
            "whisper_loaded": self._whisper_loaded,
            "whisper_model": self.whisper_model_name if self._whisper_loaded else None,
            "kokoro_loaded": self._kokoro_loaded,
            "kokoro_lang": self.kokoro_lang if self._kokoro_loaded else None,
            "default_voice": self.default_voice,
            "voices_count": len(_KOKORO_VOICES),
            "omnivoice": self.omnivoice.status(),
            "profiles_count": len(self.profiles.list()) if self.profiles else 0,
        }
