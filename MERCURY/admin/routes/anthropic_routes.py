"""Routes admin : Anthropic OAuth — statut credentials et liste de modèles connus."""
import json
import logging
import os
import stat
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from routing.router import get_config

logger = logging.getLogger(__name__)
router = APIRouter()

# Modèles Claude disponibles via OAuth (triés du plus récent au plus ancien)
_KNOWN_MODELS = [
    {"id": "claude-opus-4-8", "name": "Claude Opus 4.8"},
    {"id": "claude-opus-4-7", "name": "Claude Opus 4.7"},
    {"id": "claude-opus-4-6", "name": "Claude Opus 4.6"},
    {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6"},
    {"id": "claude-opus-4-5", "name": "Claude Opus 4.5"},
    {"id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5"},
    {"id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5"},
    {"id": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet"},
    {"id": "claude-3-5-haiku-20241022", "name": "Claude 3.5 Haiku"},
    {"id": "claude-3-opus-20240229", "name": "Claude 3 Opus"},
]


def _get_cred_path(config: dict) -> Path:
    cred_file = (config.get("anthropic_credentials_file") or "").strip()
    if cred_file:
        return Path(cred_file).expanduser()
    return Path.home() / ".claude" / ".credentials.json"


def _read_credentials(cred_path: Path) -> dict:
    """Lit le fichier credentials et retourne le dict claudeAiOauth. Lève FileNotFoundError ou ValueError."""
    data = json.loads(cred_path.read_text(encoding="utf-8"))
    oauth = data.get("claudeAiOauth") or {}
    return oauth


@router.get("/anthropic/models")
async def get_anthropic_models():
    """
    Retourne la liste des modèles Claude disponibles via OAuth.
    Vérifie d'abord que le fichier credentials existe et contient un accessToken valide.
    """
    config = get_config()
    if not config.get("anthropic_enabled", False):
        return JSONResponse(
            status_code=400,
            content={
                "detail": "Anthropic est désactivé (anthropic_enabled: false dans la config).",
                "models": [],
            },
        )
    cred_path = _get_cred_path(config)
    try:
        oauth = _read_credentials(cred_path)
        if not (oauth.get("accessToken") or "").strip():
            return JSONResponse(
                status_code=400,
                content={
                    "detail": "Credentials OAuth manquants ou expirés. Lancez 'claude login' ou renseignez le token depuis l'UI.",
                    "models": [],
                },
            )
    except FileNotFoundError:
        return JSONResponse(
            status_code=400,
            content={
                "detail": f"Fichier credentials introuvable : {cred_path}. Lancez 'claude login' ou collez le token manuellement.",
                "models": [],
            },
        )
    except Exception as e:
        logger.warning("Anthropic GET /models: erreur lecture credentials %s: %s", cred_path, e)
        return JSONResponse(
            status_code=400,
            content={"detail": f"Erreur lecture credentials : {e}", "models": []},
        )
    return JSONResponse(content={"models": _KNOWN_MODELS})


class AnthropicCredentialsBody(BaseModel):
    access_token: str
    refresh_token: str = ""
    expires_at: int = 0  # timestamp ms UTC (0 = inconnu)


@router.post("/anthropic/credentials")
async def set_anthropic_credentials(body: AnthropicCredentialsBody):
    """
    Enregistre les credentials OAuth Claude Code dans le fichier credentials.
    Permet de coller les tokens depuis l'extension VS Code ou depuis 'claude login'.
    Le fichier est créé s'il n'existe pas (chmod 600).
    """
    config = get_config()
    access_token = (body.access_token or "").strip()
    if not access_token:
        return JSONResponse(
            status_code=400,
            content={"detail": "access_token est requis."},
        )
    cred_path = _get_cred_path(config)
    try:
        # Lire l'existant pour ne pas écraser d'autres clés
        existing: dict = {}
        if cred_path.exists():
            try:
                existing = json.loads(cred_path.read_text(encoding="utf-8"))
            except Exception:
                existing = {}

        # Construire le bloc claudeAiOauth
        oauth_block: dict = dict(existing.get("claudeAiOauth") or {})
        oauth_block["accessToken"] = access_token
        if body.refresh_token.strip():
            oauth_block["refreshToken"] = body.refresh_token.strip()
        if body.expires_at:
            oauth_block["expiresAt"] = body.expires_at

        existing["claudeAiOauth"] = oauth_block

        # Écrire avec chmod 600
        cred_path.parent.mkdir(parents=True, exist_ok=True)
        cred_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
        try:
            os.chmod(cred_path, stat.S_IRUSR | stat.S_IWUSR)
        except Exception:
            pass  # Windows: chmod non supporté, pas critique

        logger.info("Anthropic credentials enregistrés dans %s", cred_path)
        return JSONResponse(content={"ok": True, "path": str(cred_path)})
    except Exception as e:
        logger.exception("Anthropic POST /credentials: %s", e)
        return JSONResponse(
            status_code=500,
            content={"detail": f"Erreur écriture credentials : {e}"},
        )
