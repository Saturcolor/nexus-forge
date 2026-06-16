"""Backend audio Local : proxy vers le daemon brain (Kokoro TTS + Faster Whisper STT)."""
from providers.audio.base import AudioBackendBase
from providers.http_client import get_client


class LocalAudioBackend(AudioBackendBase):
    # Default 180s aligns with the rest of the voice chain
    # (Mastermind client → NCM AudioClient → here → brain).
    # OmniVoice clone TTS observed ~70 ms/char on Strix Halo CPU; a 4000-char
    # NCM-capped reply can take up to ~280s worst case but 180s covers ~95th
    # percentile. Mismatch with the upstream caps would silently truncate
    # successful brain responses (incident 2026-05-19: 65s TTS dropped at 60s).
    def __init__(self, base_url: str, timeout: float = 180.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def transcribe(self, body: bytes, content_type: str) -> dict:
        # STT pass-through mutualisé (cf. base._passthrough_transcribe).
        # Local n'a pas d'auth → api_key=None (aucun header Authorization).
        return await self._passthrough_transcribe(
            client_key="audio_local",
            url=f"{self.base_url}/audio/transcriptions",
            label="Local STT",
            body=body,
            content_type=content_type,
            api_key=None,
        )

    async def speech(
        self,
        text: str,
        model: str,
        voice: str,
        speed: float = 1.0,
        response_format: str = "mp3",
        **extras,
    ) -> bytes:
        client = get_client("audio_local", timeout=self.timeout)
        body: dict = {
            "model": model,
            "input": text,
            "voice": voice,
            "speed": speed,
            "response_format": response_format,
        }
        # OmniVoice + Voice Studio extras — passe-plat vers le daemon brain
        # (master_chain est une liste, les autres sont scalaires).
        for k in (
            "master", "language",
            "num_step", "guidance_scale", "pitch_semitones",
            "master_chain", "master_peak_dbfs",
        ):
            v = extras.get(k)
            if v is None or v == "":
                continue
            body[k] = v
        resp = await client.post(
            f"{self.base_url}/audio/speech",
            headers={"Content-Type": "application/json"},
            json=body,
        )
        self._check_audio_resp(resp, "Local TTS")
        return resp.content
