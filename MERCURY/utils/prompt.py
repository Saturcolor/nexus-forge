"""Parsing de la section Runtime / Reasoning d'un system prompt côté client."""
import re


def parse_runtime_from_system_prompt(system_prompt: str | None) -> dict[str, str] | None:
    """
    Parse la section ## Runtime du system prompt envoyé par le client.
    - Ligne "Runtime: key1=val1 | key2=val2 | ..." → tous les key=value (agent, host, os, model, default_model, shell, channel, capabilities, thinking, etc.)
    - Ligne "Reasoning: on" ou "Reasoning: off" (souvent juste après) → clé "Reasoning"
    Retourne un dict de paramètres (valeurs str) ou None si pas de section Runtime trouvée.
    """
    if not system_prompt or not isinstance(system_prompt, str):
        return None
    text = system_prompt
    out: dict[str, str] = {}
    m = re.search(r"Runtime:\s*([^\n]+)", text)
    if m:
        line = m.group(1).strip()
        for part in re.split(r"\s*\|\s*", line):
            part = part.strip()
            if "=" in part:
                key, _, val = part.partition("=")
                key, val = key.strip().lower(), val.strip()
                if key:
                    out[key] = val
    m = re.search(r"Reasoning:\s*(on|off|stream)\b", text)
    if m:
        out["reasoning"] = m.group(1).lower()
    return out if out else None


def reasoning_from_system_prompt(system_prompt: str | None) -> str | None:
    """
    Le client peut injecter l'état dans le system prompt (section Runtime).
    Retourne la valeur pour LM Studio: "off" | "low" | "medium" | "high" | "on".
    """
    runtime = parse_runtime_from_system_prompt(system_prompt)
    if not runtime:
        return None
    thinking = runtime.get("thinking", "").lower()
    _THINKING_OFF = ("off", "minimal")
    if thinking in _THINKING_OFF:
        return "off"
    if thinking == "low":
        return "low"
    if thinking == "medium":
        return "medium"
    if thinking in ("high", "xhigh"):
        return "high"
    if thinking in ("on", "stream", "adaptive"):
        return "on"
    if "reasoning" in runtime:
        r = runtime["reasoning"].lower()
        return "on" if r == "stream" else r
    return None
