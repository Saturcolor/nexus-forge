"""Factory pour les backends audio (STT / TTS)."""
from providers.audio.base import AudioBackendBase
from providers.audio.openai_audio import OpenAIAudioBackend
from providers.audio.groq_audio import GroqAudioBackend
from providers.audio.elevenlabs_audio import ElevenLabsAudioBackend
from providers.audio.local_audio import LocalAudioBackend


def get_audio_backend(name: str, config: dict) -> AudioBackendBase:
    """Retourne le backend audio pour le provider demandé. Lève ValueError si non configuré."""
    if name == "openai":
        api_key = (config.get("audio_openai_api_key") or "").strip()
        if not api_key:
            raise ValueError("Audio provider openai : clé API (audio_openai_api_key) manquante")
        return OpenAIAudioBackend(api_key=api_key)
    if name == "groq":
        api_key = (config.get("audio_groq_api_key") or "").strip()
        if not api_key:
            raise ValueError("Audio provider groq : clé API (audio_groq_api_key) manquante")
        return GroqAudioBackend(api_key=api_key)
    if name == "elevenlabs":
        api_key = (config.get("audio_elevenlabs_api_key") or "").strip()
        if not api_key:
            raise ValueError("Audio provider elevenlabs : clé API (audio_elevenlabs_api_key) manquante")
        voice_map = config.get("audio_elevenlabs_voice_map") or {}
        return ElevenLabsAudioBackend(api_key=api_key, voice_map=voice_map)
    if name == "local":
        url = (config.get("audio_local_url") or "").strip()
        if not url:
            raise ValueError("Audio provider local : URL manquante (audio_local_url)")
        return LocalAudioBackend(base_url=url)
    raise ValueError(f"Audio provider inconnu : {name}")


__all__ = [
    "AudioBackendBase",
    "OpenAIAudioBackend",
    "GroqAudioBackend",
    "ElevenLabsAudioBackend",
    "LocalAudioBackend",
    "get_audio_backend",
]
