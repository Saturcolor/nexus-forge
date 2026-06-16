"""Backend audio Groq : STT uniquement (whisper-large-v3-turbo, ultra rapide)."""
from providers.audio.base import AudioBackendBase

STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions"


class GroqAudioBackend(AudioBackendBase):
    def __init__(self, api_key: str, timeout: float = 60.0):
        self.api_key = api_key
        self.timeout = timeout

    async def transcribe(self, body: bytes, content_type: str) -> dict:
        # STT pass-through mutualisé (cf. base._passthrough_transcribe).
        return await self._passthrough_transcribe(
            client_key="audio_groq",
            url=STT_URL,
            label="Groq STT",
            body=body,
            content_type=content_type,
            api_key=self.api_key,
        )

    async def speech(self, text: str, model: str, voice: str, speed: float = 1.0, response_format: str = "mp3", **_extras) -> bytes:
        raise NotImplementedError("Groq ne supporte pas le TTS")
