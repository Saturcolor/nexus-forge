"""Wrappers fins autour de huggingface_hub : search, list files, download, token."""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from huggingface_hub import HfApi, hf_hub_download  # type: ignore[import-untyped]
from huggingface_hub.errors import GatedRepoError, RepositoryNotFoundError  # type: ignore[import-untyped]

logger = logging.getLogger("brain-daemon")

# Configure par configure_token_path() appele depuis init_downloader() : le daemon
# tourne en root (systemd) mais le token doit vivre dans le home du run_as_user
# pour etre coherent avec le CLI huggingface-cli cote user. Fallback = ~/.cache/...
_HF_TOKEN_PATH: Path = Path.home() / ".cache" / "huggingface" / "token"
_TOKEN_OWNER_UID: Optional[int] = None
_TOKEN_OWNER_GID: Optional[int] = None

_QUANT_RE = re.compile(r"[._-](Q\d+_[A-Z_0-9]+|F16|BF16|F32|IQ\d+_[A-Z_0-9]+)", re.IGNORECASE)
_SHARD_RE = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$", re.IGNORECASE)


def configure_token_path(run_as_user: str = "") -> None:
    """Resout le chemin du token selon run_as_user (utile quand le daemon tourne en root).

    Fixe aussi l'uid/gid cibles pour chown du fichier et des parents crees.
    """
    global _HF_TOKEN_PATH, _TOKEN_OWNER_UID, _TOKEN_OWNER_GID
    if run_as_user:
        try:
            import pwd
            pw = pwd.getpwnam(run_as_user)
            _HF_TOKEN_PATH = Path(pw.pw_dir) / ".cache" / "huggingface" / "token"
            _TOKEN_OWNER_UID = pw.pw_uid
            _TOKEN_OWNER_GID = pw.pw_gid
            logger.info("downloader: HF token path -> %s (owner %s:%s)",
                        _HF_TOKEN_PATH, pw.pw_uid, pw.pw_gid)
            return
        except KeyError:
            logger.warning("downloader: run_as_user=%r not found, using current home", run_as_user)
    # Fallback : current user home
    _HF_TOKEN_PATH = Path.home() / ".cache" / "huggingface" / "token"
    _TOKEN_OWNER_UID = None
    _TOKEN_OWNER_GID = None


def get_token_path() -> Path:
    return _HF_TOKEN_PATH


def _chown_to_target_user(path: Path) -> None:
    """chown path vers run_as_user si configure (no-op sinon ou si pas root)."""
    if _TOKEN_OWNER_UID is None or _TOKEN_OWNER_GID is None:
        return
    try:
        os.chown(path, _TOKEN_OWNER_UID, _TOKEN_OWNER_GID)
    except PermissionError:
        # Pas root ou filesystem read-only — pas grave
        pass
    except OSError as e:
        logger.warning("downloader: chown %s failed: %s", path, e)


@dataclass
class HFModelSummary:
    repo_id: str
    downloads: int
    likes: int
    last_modified: Optional[str]
    tags: list[str]
    gated: bool


@dataclass
class HFFile:
    path: str
    size: int
    quant: Optional[str]
    is_shard: bool


def read_token() -> Optional[str]:
    try:
        return _HF_TOKEN_PATH.read_text(encoding="utf-8").strip() or None
    except FileNotFoundError:
        return None
    except Exception:
        return None


def write_token(token: Optional[str]) -> bool:
    parent = _HF_TOKEN_PATH.parent
    # Tracker les dirs crees pour les chown (si daemon tourne en root vers run_as_user)
    created_dirs: list[Path] = []
    cur = parent
    while not cur.exists() and cur != cur.parent:
        created_dirs.append(cur)
        cur = cur.parent
    parent.mkdir(parents=True, exist_ok=True)
    # chown les dirs remontes vers le user cible (huggingface_hub CLI en aura besoin)
    for d in reversed(created_dirs):
        _chown_to_target_user(d)

    if token is None or not token.strip():
        try:
            _HF_TOKEN_PATH.unlink()
        except FileNotFoundError:
            pass
        return False
    _HF_TOKEN_PATH.write_text(token.strip(), encoding="utf-8")
    try:
        os.chmod(_HF_TOKEN_PATH, 0o600)
    except Exception:
        pass
    _chown_to_target_user(_HF_TOKEN_PATH)
    return True


def mask_token(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    tail = token[-4:] if len(token) >= 4 else token
    return f"hf_****{tail}"


def _parse_quant(filename: str) -> Optional[str]:
    m = _QUANT_RE.search(filename)
    return m.group(1).upper() if m else None


def _is_shard(filename: str) -> bool:
    return bool(_SHARD_RE.search(filename))


_ALLOWED_SORTS = {"downloads", "likes", "last_modified"}


def search_models(
    query: str,
    limit: int = 50,
    gguf_only: bool = True,
    author: Optional[str] = None,
    sort: str = "downloads",
) -> list[HFModelSummary]:
    """Cherche des modeles sur HuggingFace Hub.

    - `query` : recherche texte (fuzzy sur repo_id + tags + readme).
    - `author` : filtre strict par auteur (ex: "DavidAU") — combinable avec query.
    - `sort` : "downloads" | "likes" | "last_modified" (recent).
    - `gguf_only` : restreint au library tag GGUF.

    Note : les filtres "size" et "tags contenu" (uncensored, thinking, etc.) sont
    appliques cote frontend car l'API HF n'expose pas la taille, et les tags
    texte comme "uncensored" sont pas systematiquement pousses en library tags.

    Note HF API : le parametre `direction` a ete supprime dans huggingface_hub
    >=0.25 — le sens de tri est maintenant infere du `sort` key (desc par defaut
    pour downloads/likes/last_modified).
    """
    if sort not in _ALLOWED_SORTS:
        sort = "downloads"
    api = HfApi(token=read_token())
    kwargs: dict = {"limit": limit, "sort": sort}
    if query and query.strip():
        kwargs["search"] = query.strip()
    if author and author.strip():
        kwargs["author"] = author.strip()
    if gguf_only:
        kwargs["filter"] = "gguf"
    results = []
    for m in api.list_models(**kwargs):
        tags = list(getattr(m, "tags", []) or [])
        gated = bool(getattr(m, "gated", False))
        lm = getattr(m, "last_modified", None)
        results.append(HFModelSummary(
            repo_id=m.id,
            downloads=int(getattr(m, "downloads", 0) or 0),
            likes=int(getattr(m, "likes", 0) or 0),
            last_modified=lm.isoformat() if lm and hasattr(lm, "isoformat") else (str(lm) if lm else None),
            tags=tags,
            gated=gated,
        ))
    return results


def list_repo_gguf_files(repo_id: str) -> list[HFFile]:
    api = HfApi(token=read_token())
    info = api.model_info(repo_id, files_metadata=True)
    out: list[HFFile] = []
    for sib in getattr(info, "siblings", []) or []:
        path = getattr(sib, "rfilename", None) or getattr(sib, "filename", None)
        if not path or not path.lower().endswith(".gguf"):
            continue
        # filter mmproj/projector/clip bruit si present
        low = path.lower()
        if any(x in low for x in ("mmproj", "projector", "clip")):
            # on les inclut quand meme mais sans quant
            size = int(getattr(sib, "size", 0) or 0)
            out.append(HFFile(path=path, size=size, quant=None, is_shard=False))
            continue
        size = int(getattr(sib, "size", 0) or 0)
        out.append(HFFile(
            path=path,
            size=size,
            quant=_parse_quant(path),
            is_shard=_is_shard(path),
        ))
    return out


def download_file(
    repo_id: str,
    filename: str,
    local_dir: Path,
    revision: Optional[str] = None,
) -> str:
    """Telecharge un fichier dans local_dir/repo_id/filename. Retourne le path local final."""
    target_dir = local_dir / repo_id
    target_dir.mkdir(parents=True, exist_ok=True)
    path = hf_hub_download(
        repo_id=repo_id,
        filename=filename,
        local_dir=str(target_dir),
        revision=revision,
        token=read_token(),
    )
    return str(path)


def _download_subprocess_target(
    repo_id: str,
    filename: str,
    target_dir_str: str,
    revision: Optional[str],
    token: Optional[str],
    result_queue,
) -> None:
    """Cible du sous-process : telecharge et pousse le resultat dans la queue.

    Tourne dans un process isole pour pouvoir etre kill-9 proprement par
    le parent si cancel. DOIT etre top-level pour pickling multiprocessing.
    """
    try:
        from huggingface_hub import hf_hub_download as _dl  # import dans le subprocess
        path = _dl(
            repo_id=repo_id,
            filename=filename,
            local_dir=target_dir_str,
            revision=revision,
            token=token,
        )
        result_queue.put(("ok", str(path)))
    except Exception as e:
        result_queue.put(("error", f"{type(e).__name__}: {e}"))


# Re-exports pour attraper les exceptions dans jobs.py
__all__ = [
    "HFModelSummary",
    "HFFile",
    "read_token",
    "write_token",
    "mask_token",
    "search_models",
    "list_repo_gguf_files",
    "download_file",
    "GatedRepoError",
    "RepositoryNotFoundError",
]
