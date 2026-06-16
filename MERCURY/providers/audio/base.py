"""Interface commune pour les backends audio (STT / TTS).

Contient aussi les helpers partagés extraits de la duplication relevée à l'audit
(transcribe() pass-through + bloc de gestion d'erreur 4xx copié-collé dans les 4
providers). Cf. AUDIT-mercury.md : `_check_audio_resp` + `_passthrough_transcribe`.
"""
import logging
from abc import ABC, abstractmethod

import httpx

from providers.http_client import get_client

logger = logging.getLogger("mercury")


class AudioBackendBase(ABC):
    """ABC pour les providers audio. Chaque provider implémente transcribe et/ou speech."""

    @abstractmethod
    async def transcribe(self, body: bytes, content_type: str) -> dict:
        """STT : proxy le body multipart brut vers le provider upstream.
        Retourne un dict compatible OpenAI (ex. {"text": "..."}).
        """

    @abstractmethod
    async def speech(
        self,
        text: str,
        model: str,
        voice: str,
        speed: float = 1.0,
        response_format: str = "mp3",
        **extras,
    ) -> bytes:
        """TTS : retourne les audio bytes.

        extras : champs optionnels propagés par /v1/audio/speech (ex: 'master',
        'language' pour les backends locaux qui supportent OmniVoice). Les
        backends qui ne les comprennent pas les ignorent silencieusement.
        """

    # ── Helpers partagés ────────────────────────────────────────────────────

    @staticmethod
    def _check_audio_resp(resp: httpx.Response, label: str) -> None:
        """Bloc 4xx/5xx commun à TOUS les appels audio (STT + TTS, tous providers).

        `label` est le préfixe humain exact, ex. "Groq STT", "OpenAI TTS",
        "ElevenLabs STT". On reproduit à l'octet près le log + le message de
        l'erreur historiques :
            log  : "<label> <code>: <detail>"
            raise: RuntimeError("<label> error <code>: <detail>")

        IMPORTANT : on lève bien un RuntimeError (et pas un autre type). Le caller
        (core/routes_audio.py) attrape RuntimeError via `except Exception` →
        HTTP 502 ; changer le type changerait le code HTTP renvoyé au client.
        detail est tronqué à 500 chars comme avant.
        """
        if resp.status_code >= 400:
            detail = resp.text[:500]
            logger.warning("%s %s: %s", label, resp.status_code, detail)
            raise RuntimeError(f"{label} error {resp.status_code}: {detail}")

    async def _passthrough_transcribe(
        self,
        client_key: str,
        url: str,
        label: str,
        body: bytes,
        content_type: str,
        api_key: str | None = None,
    ) -> dict:
        """STT « pass-through » : reposte le multipart brut tel quel vers l'upstream.

        Mutualise le transcribe() STRICTEMENT identique de Groq / OpenAI / Local
        (le seul qui varie : client_key, url, label, et la présence d'un header
        Authorization). ElevenLabs N'utilise PAS ce helper (il parse/reconstruit
        le multipart) mais réutilise `_check_audio_resp`.

        - client_key : clé du pool httpx partagé (ex. "audio_groq").
        - url        : endpoint STT upstream.
        - label      : préfixe d'erreur, ex. "Groq STT".
        - body/content_type : multipart OpenAI brut transmis tel quel.
        - api_key    : si fourni → header "Authorization: Bearer <key>" ajouté.
                       Local n'envoie pas d'auth (api_key=None).

        Retourne resp.json() (format OpenAI {"text": ...}) comme l'historique.
        """
        client = get_client(client_key, timeout=self.timeout)
        headers = {"Content-Type": content_type}
        if api_key is not None:
            headers["Authorization"] = f"Bearer {api_key}"
        resp = await client.post(url, headers=headers, content=body)
        self._check_audio_resp(resp, label)
        return resp.json()
