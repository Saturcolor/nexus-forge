"""Backend audio OpenAI : STT (whisper) + TTS (tts-1 / tts-1-hd)."""
from providers.audio.base import AudioBackendBase
from providers.http_client import get_client

STT_URL = "https://api.openai.com/v1/audio/transcriptions"
TTS_URL = "https://api.openai.com/v1/audio/speech"


class OpenAIAudioBackend(AudioBackendBase):
    def __init__(self, api_key: str, timeout: float = 120.0):
        self.api_key = api_key
        self.timeout = timeout

    async def transcribe(self, body: bytes, content_type: str) -> dict:
        # STT pass-through mutualisé (cf. base._passthrough_transcribe).
        return await self._passthrough_transcribe(
            client_key="audio_openai",
            url=STT_URL,
            label="OpenAI STT",
            body=body,
            content_type=content_type,
            api_key=self.api_key,
        )

    async def speech(
        self,
        text: str,
        model: str,
        voice: str,
        speed: float = 1.0,
        response_format: str = "mp3",
        **_extras,
    ) -> bytes:
        client = get_client("audio_openai", timeout=self.timeout)
        body = {
            "model": model,
            "input": text,
            "voice": voice,
            "speed": speed,
            "response_format": response_format,
        }
        resp = await client.post(
            TTS_URL,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json=body,
        )
        self._check_audio_resp(resp, "OpenAI TTS")
        return resp.content
