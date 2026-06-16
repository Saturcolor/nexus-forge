"""Routes admin : users (CRUD). Persistance en DB (data/db.json)."""
import logging
import secrets

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from routing.router import get_config, apply_db_overrides
from data.db import set_users
from admin.common import mask_key

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/users")
def get_users():
    """Liste des users avec user_id, priority, clé masquée (jamais la clé en clair)."""
    try:
        config = get_config()
        users = config.get("users") or []
        out = []
        for u in users:
            if not isinstance(u, dict):
                continue
            out.append({
                "user_id": u.get("user_id", ""),
                "priority": int(u.get("priority", 99)),
                "threshold": bool(u.get("threshold", False)),
                "key_prefix": mask_key(u.get("api_key", "")),
            })
        return JSONResponse(content=out)
    except Exception as e:
        logger.exception("GET /admin/users: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.post("/users")
async def post_users(request: Request):
    """Création d'un user : body { user_id, priority }. Génère api_key, sauvegarde en DB, retourne la clé une seule fois."""
    try:
        body = await request.json()
        user_id = (body.get("user_id") or "").strip()
        priority = int(body.get("priority", 99))
        threshold = bool(body.get("threshold", False))
        if not user_id:
            raise HTTPException(status_code=400, detail="user_id required")
        config = get_config()
        users = list(config.get("users") or [])
        if any(isinstance(u, dict) and u.get("user_id") == user_id for u in users):
            raise HTTPException(status_code=400, detail="user_id already exists")
        api_key = secrets.token_urlsafe(32)
        users.append({"user_id": user_id, "priority": priority, "threshold": threshold, "api_key": api_key})
        set_users(users)
        apply_db_overrides()
        return JSONResponse(content={
            "user_id": user_id,
            "priority": priority,
            "api_key": api_key,
        })
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("POST /admin/users: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.patch("/users")
async def patch_users(request: Request):
    """Mise à jour : body { user_id, priority? } (identifier par user_id existant)."""
    try:
        body = await request.json()
        user_id = (body.get("user_id") or "").strip()
        if not user_id:
            raise HTTPException(status_code=400, detail="user_id required")
        new_priority = body.get("priority")
        new_threshold = body.get("threshold")
        new_user_id = (body.get("new_user_id") or "").strip() or None
        config = get_config()
        users = list(config.get("users") or [])
        for i, u in enumerate(users):
            if isinstance(u, dict) and u.get("user_id") == user_id:
                copy = dict(u)
                if new_priority is not None:
                    copy["priority"] = int(new_priority)
                if new_threshold is not None:
                    copy["threshold"] = bool(new_threshold)
                if new_user_id is not None:
                    copy["user_id"] = new_user_id
                users[i] = copy
                set_users(users)
                apply_db_overrides()
                return JSONResponse(content={"ok": True, "user_id": copy.get("user_id"), "priority": copy.get("priority")})
        raise HTTPException(status_code=404, detail="user_id not found")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("PATCH /admin/users: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})


@router.delete("/users")
def delete_users(user_id: str = Query(..., description="user_id à supprimer")):
    try:
        config = get_config()
        current = config.get("users") or []
        users = [u for u in current if isinstance(u, dict) and u.get("user_id") != user_id]
        if len(users) == len(current):
            raise HTTPException(status_code=404, detail="user_id not found")
        set_users(users)
        apply_db_overrides()
        return JSONResponse(content={"ok": True})
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("DELETE /admin/users: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e), "type": type(e).__name__})
