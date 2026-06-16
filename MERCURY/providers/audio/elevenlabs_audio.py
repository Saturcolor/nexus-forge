"""Backend audio ElevenLabs : TTS + STT (Scribe). Adapte le format OpenAI -> ElevenLabs."""
import re

from providers.audio.base import AudioBackendBase
from providers.http_client import get_client

TTS_BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech"
STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"

# ── Mapping model OpenAI → model_id ElevenLabs ──────────────────────────────
# NCM envoie model="scribe_v2" ou model="scribe_v1" directement.
# On accepte aussi "whisper-1" comme alias → scribe_v2 (fallback par défaut).
_STT_MODEL_MAP = {
    "scribe_v2": "scribe_v2",
    "scribe_v1": "scribe_v1",
    "whisper-1": "scribe_v2",
}

# Regex pour extraire les champs d'un multipart brut
_MULTIPART_FIELD_RE = re.compile(
    rb'Content-Disposition: form-data; name="(\w+)"\r\n\r\n([^\r]*)\r\n',
)
_MULTIPART_FILE_RE = re.compile(
    rb'Content-Disposition: form-data; name="file"; filename="([^"]*)"'
    rb'\r\nContent-Type: ([^\r]*)\r\n\r\n',
)


def _parse_multipart_for_elevenlabs(raw_body: bytes, content_type: str) -> tuple[dict, bytes, str, str]:
    """Parse le multipart brut pour extraire les champs texte et le fichier audio.
    Retourne (fields_dict, file_bytes, filename, file_content_type)."""
    # Extraire le boundary du Content-Type
    boundary_match = re.search(rb'boundary=([^\s;]+)', content_type.encode())
    if not boundary_match:
        raise ValueError("Missing multipart boundary")
    boundary = b"--" + boundary_match.group(1)

    # Champs texte
    fields = {}
    for m in _MULTIPART_FIELD_RE.finditer(raw_body):
        fields[m.group(1).decode()] = m.group(2).decode().strip()

    # Fichier audio
    file_match = _MULTIPART_FILE_RE.search(raw_body)
    if not file_match:
        raise ValueError("No 'file' field in multipart body")
    filename = file_match.group(1).decode()
    file_ct = file_match.group(2).decode().strip()
    # Le contenu du fichier est entre la fin des headers et le prochain boundary
    data_start = file_match.end()
    next_boundary = raw_body.find(boundary, data_start)
    if next_boundary == -1:
        file_bytes = raw_body[data_start:]
    else:
        file_bytes = raw_body[data_start:next_boundary]
        # Supprimer exactement UN délimiteur CRLF de fin (ajouté par le multipart encoder)
        # sans sur-stripper les octets audio qui pourraient légitimement se terminer par 0x0D/0x0A.
        if file_bytes.endswith(b"\r\n"):
            file_bytes = file_bytes[:-2]

    return fields, file_bytes, filename, file_ct


class ElevenLabsAudioBackend(AudioBackendBase):
    def __init__(self, api_key: str, voice_map: dict | None = None, timeout: float = 120.0):
        self.api_key = api_key
        self.voice_map = voice_map or {}
        self.timeout = timeout

    async def transcribe(self, body: bytes, content_type: str) -> dict:
        """STT via ElevenLabs Scribe. Parse le multipart OpenAI et reconstruit pour ElevenLabs."""
        fields, file_bytes, filename, file_ct = _parse_multipart_for_elevenlabs(body, content_type)

        # Résoudre le model_id
        model_name = fields.get("model", "scribe_v2")
        model_id = _STT_MODEL_MAP.get(model_name, "scribe_v2")

        client = get_client("audio_elevenlabs", timeout=self.timeout)

        # Construire le multipart pour ElevenLabs (file + model_id + language_code optionnel)
        files = {"file": (filename, file_bytes, file_ct)}
        data: dict = {"model_id": model_id}
        language = fields.get("language")
        if language:
            data["language_code"] = language

        resp = await client.post(
            STT_URL,
            headers={"xi-api-key": self.api_key},
            files=files,
            data=data,
        )
        self._check_audio_resp(resp, "ElevenLabs STT")

        result = resp.json()
        # Normaliser la réponse au format OpenAI ({"text": "..."})
        text = result.get("text", "")
        return {"text": text}

    async def speech(
        self,
        text: str,
        model: str,
        voice: str,
        speed: float = 1.0,
        response_format: str = "mp3",
        **_extras,
    ) -> bytes:
        # Résolution voice name -> voice_id (fallback: utiliser le nom tel quel)
        voice_id = self.voice_map.get(voice, voice)
        url = f"{TTS_BASE_URL}/{voice_id}"

        client = get_client("audio_elevenlabs", timeout=self.timeout)
        body_json = {
            "text": text,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.5,
            },
        }
        resp = await client.post(
            url,
            headers={
                "xi-api-key": self.api_key,
                "Content-Type": "application/json",
            },
            json=body_json,
        )
        self._check_audio_resp(resp, "ElevenLabs TTS")
        return resp.content
