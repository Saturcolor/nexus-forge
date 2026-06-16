"""
Helpers pour POST /v1/responses (stateful, reasoning, extraction usage/input).
LM Studio /v1/responses attend reasoning en objet. Doc : effort "low"|"medium"|"high" ou "on".
"""
import logging
from typing import Optional

from providers.lm_studio.handler import norm_reasoning as _norm_reasoning

logger = logging.getLogger(__name__)

REASONING_EFFORT_ON = "on"


def extract_usage_from_chunk(obj: dict) -> Optional[dict]:
    """
    Extrait un dict usage depuis un chunk JSON du stream (LM Studio / OpenAI Responses API).
    Chemins possibles : usage, response.usage, output.usage.
    """
    if not isinstance(obj, dict):
        return None

    def _has_tokens(u):
        return isinstance(u, dict) and (
            u.get("input_tokens") is not None
            or u.get("output_tokens") is not None
            or u.get("prompt_tokens") is not None
            or u.get("completion_tokens") is not None
        )

    u = obj.get("usage")
    if _has_tokens(u):
        return u
    for key in ("response", "output"):
        inner = obj.get(key)
        if isinstance(inner, dict):
            u = inner.get("usage")
            if _has_tokens(u):
                return u
    return None


def extract_last_user_input(body: dict) -> Optional[dict]:
    """
    Extrait le dernier message user du body (input ou messages) pour stateful previous_response_id.
    Retourne None si on ne peut pas extraire, sinon le fragment "input" à envoyer (string ou list).
    """
    inp = body.get("input")
    if isinstance(inp, list) and len(inp) > 0:
        for i in range(len(inp) - 1, -1, -1):
            item = inp[i]
            if isinstance(item, dict) and (item.get("role") or "").lower() == "user":
                content = item.get("content")
                if content is not None:
                    return content if isinstance(content, (str, list)) else str(content)
        return None
    if isinstance(inp, str) and inp.strip():
        return inp.strip()
    messages = body.get("messages")
    if isinstance(messages, list) and len(messages) > 0:
        for i in range(len(messages) - 1, -1, -1):
            msg = messages[i]
            if isinstance(msg, dict) and (msg.get("role") or "").lower() == "user":
                content = msg.get("content")
                if content is not None:
                    if isinstance(content, str):
                        return content.strip() if content.strip() else None
                    if isinstance(content, list):
                        texts = [
                            p.get("text") for p in content
                            if isinstance(p, dict) and p.get("type") == "text" and p.get("text")
                        ]
                        if texts:
                            return "\n".join(str(t) for t in texts)
                break
    return None


def input_to_string_for_lm_studio(new_input) -> str:
    """LM Studio attend input comme string pour le suivi stateful. Convertit list/obj en string."""
    if isinstance(new_input, str):
        return new_input
    if isinstance(new_input, list):
        parts = []
        for p in new_input:
            if isinstance(p, dict):
                if p.get("type") in ("input_text", "text") and p.get("text"):
                    parts.append(str(p["text"]))
        return "\n".join(parts) if parts else ""
    return str(new_input) if new_input is not None else ""


def normalize_reasoning_for_responses(
    body: dict,
    backend_model_id: str,
    model_in: str,
    config: dict,
) -> Optional[dict]:
    """
    Normalise le champ reasoning pour LM Studio /v1/responses.
    LM Studio attend un objet { "effort": "low"|"medium"|"high" }, pas une string.
    L'option "Forcer le reasoning" prime sur le body. Retourne None pour omettre la clé (off).
    """
    raw = None
    forced = config.get("lm_studio_reasoning")
    if forced is not None and str(forced).strip():
        raw = str(forced).strip()
    if raw is None:
        raw = body.get("reasoning")
    if raw is None:
        return None
    if isinstance(raw, dict) and "effort" in raw:
        raw = raw.get("effort")
    value = _norm_reasoning(raw)
    if value is None or value == "off":
        return None
    if value not in ("low", "medium", "high", REASONING_EFFORT_ON):
        return None
    return {"effort": value}


def build_stateful_body(body: dict, previous_response_id: str, new_input) -> dict:
    """Construit le body pour LM Studio avec previous_response_id et le nouvel input uniquement."""
    out = {
        "model": body.get("model"),
        "previous_response_id": previous_response_id,
        "input": input_to_string_for_lm_studio(new_input),
        "stream": body.get("stream", False),
    }
    # body["reasoning"] est déjà au format objet { "effort": "..." } après normalize_reasoning_for_responses
    if body.get("reasoning") is not None:
        out["reasoning"] = body["reasoning"] if isinstance(body["reasoning"], dict) else {"effort": "medium"}
    if body.get("tools") is not None:
        out["tools"] = body["tools"]
    for k in ("temperature", "max_tokens", "store"):
        if body.get(k) is not None:
            out[k] = body[k]
    return out


_LM_STUDIO_UNSUPPORTED_FIELDS = frozenset({"promptcache_key", "prompt_cache_key"})


def sanitize_input_roles(body: dict) -> None:
    """Convertit les rôles non supportés par LM Studio dans input (developer → system)."""
    inp = body.get("input")
    if not isinstance(inp, list):
        return
    for item in inp:
        if isinstance(item, dict):
            role = (item.get("role") or "").strip().lower()
            if role == "developer":
                item["role"] = "system"


def _flush_content_parts(parts: list) -> dict:
    """Convertit une liste de content parts Responses API (input_text, etc.) en un message user chat."""
    if len(parts) == 1 and (parts[0].get("type") or "") == "input_text":
        return {"role": "user", "content": parts[0].get("text", "")}
    # Multiple parts → content array
    content = []
    for p in parts:
        if (p.get("type") or "") == "input_text":
            content.append({"type": "text", "text": p.get("text", "")})
        else:
            content.append(p)
    return {"role": "user", "content": content}


def normalize_input_items(body: dict) -> None:
    """Convertit les items Responses API (input_text, input_image…) en messages chat.

    Les items {"type": "input_text", "text": "..."} sont des content parts user
    dans le format Responses API. LM Studio attend des messages avec role explicite.
    Regroupe les input_text/input_image consécutifs en un seul message user.
    Modifie body en place.
    """
    inp = body.get("input")
    if not isinstance(inp, list):
        return

    has_content_parts = False
    for item in inp:
        if isinstance(item, dict) and (item.get("type") or "").strip().lower() in (
            "input_text", "input_image", "input_file",
        ):
            has_content_parts = True
            break
    if not has_content_parts:
        return

    new_input = []
    pending_parts = []

    for item in inp:
        if not isinstance(item, dict):
            if pending_parts:
                new_input.append(_flush_content_parts(pending_parts))
                pending_parts = []
            new_input.append(item)
            continue

        item_type = (item.get("type") or "").strip().lower()

        if item_type in ("input_text", "input_image", "input_file"):
            pending_parts.append(item)
        else:
            if pending_parts:
                new_input.append(_flush_content_parts(pending_parts))
                pending_parts = []
            new_input.append(item)

    if pending_parts:
        new_input.append(_flush_content_parts(pending_parts))

    body["input"] = new_input
    logger.debug(
        "normalize_input_items: converti %d content parts en messages user (total items: %d → %d)",
        sum(1 for i in inp if isinstance(i, dict) and (i.get("type") or "").strip().lower() in ("input_text", "input_image", "input_file")),
        len(inp),
        len(new_input),
    )


def strip_unsupported_fields(body: dict) -> None:
    """Retire les champs non supportés par LM Studio pour éviter les warnings."""
    for field in _LM_STUDIO_UNSUPPORTED_FIELDS:
        body.pop(field, None)


def _input_has_user_message(inp) -> bool:
    """True si input (list) contient au moins un item avec role user."""
    if not isinstance(inp, list):
        return False
    for item in inp:
        if not isinstance(item, dict):
            continue
        role = (item.get("role") or item.get("type") or "").strip().lower()
        if role == "user":
            return True
        if item.get("type") == "message" and (item.get("role") or "").strip().lower() == "user":
            return True
    return False


_USER_PLACEHOLDER = {"role": "user", "content": "."}


def ensure_input_has_user_message(body: dict) -> None:
    """
    LM Studio (template Jinja) exige au moins un message avec role "user" dans input.
    En nouvelle session le client peut n'envoyer que developer/system → erreur "No user query found".
    Le placeholder doit être non-whitespace (le template Jinja fait strip() sur le contenu).
    Modifie body en place.
    """
    inp = body.get("input")
    if inp is None:
        body["input"] = [dict(_USER_PLACEHOLDER)]
        return
    if isinstance(inp, str):
        body["input"] = [{"role": "user", "content": inp.strip() or "."}]
        return
    if not isinstance(inp, list):
        body["input"] = [dict(_USER_PLACEHOLDER)]
        return
    if len(inp) == 0:
        body["input"] = [dict(_USER_PLACEHOLDER)]
        return
    if _input_has_user_message(inp):
        return
    roles = [str((i.get("role") or i.get("type") or "")) for i in inp if isinstance(i, dict)]
    logger.info(
        "ensure_input_has_user_message: aucun message user dans input (roles=%s), ajout placeholder user",
        roles[:20],
    )
    body["input"] = list(inp) + [dict(_USER_PLACEHOLDER)]


def sanitize_include_for_lm_studio(include: list) -> list:
    """
    Retire les valeurs d'include non supportées par LM Studio (ex. reasoning.encrypted_content)
    pour éviter les warnings dans les logs.
    """
    if not isinstance(include, list):
        return include
    unsupported = frozenset({"reasoning.encrypted_content"})
    return [x for x in include if isinstance(x, str) and x not in unsupported]


def is_previous_response_not_found(data: dict) -> bool:
    """Détecte l'erreur LM Studio previous_response_not_found (historique purgé)."""
    err = data.get("error") if isinstance(data, dict) else None
    if not isinstance(err, dict):
        return False
    if err.get("code") == "previous_response_not_found":
        return True
    msg = (err.get("message") or "")
    return "previous_response_not_found" in msg or "Prediction history node" in msg


