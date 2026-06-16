"""
Agrégation des crédits / usage des providers (OpenRouter, OpenAI, Anthropic).
Aligné sur la structure OPENBILL : fetchedAt, providers, errors.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

import httpx

PROVIDER_IDS = ["openrouter", "openai", "anthropic", "elevenlabs"]


def _get_credits_config() -> dict:
    from routing.router import get_config
    return get_config().get("credits") or {}


async def fetch_openrouter_credits(timeout_ms: int) -> dict[str, Any]:
    c = _get_credits_config()
    key = (c.get("openrouter_key") or "").strip()
    if not key:
        return {"ok": False, "error": "openrouter_key manquant"}
    url = "https://openrouter.ai/api/v1/credits"
    try:
        async with httpx.AsyncClient(timeout=timeout_ms / 1000.0) as client:
            r = await client.get(url, headers={"Authorization": f"Bearer {key}"})
        if r.status_code != 200:
            return {"ok": False, "error": f"HTTP {r.status_code}: {(r.text or '')[:200]}"}
        data = r.json()
        inner = data.get("data") or {}
        total_credits = inner.get("total_credits")
        total_usage = inner.get("total_usage")
        if total_credits is not None and total_usage is not None:
            remaining = float(total_credits) - float(total_usage)
        else:
            remaining = None
        return {
            "ok": True,
            "totalCredits": total_credits if total_credits is not None else None,
            "totalUsage": total_usage if total_usage is not None else None,
            "remaining": remaining if remaining is not None else None,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def fetch_openai_credits(timeout_ms: int) -> dict[str, Any]:
    c = _get_credits_config()
    key = (c.get("openai_key") or "").strip()
    if not key:
        return {"ok": False, "error": "openai_key manquant (clé Admin requise)"}
    import time
    end = int(time.time())
    start = end - 30 * 24 * 3600
    snapshot_date = (c.get("openai_balance_snapshot_date") or "").strip()
    snapshot_balance_str = (c.get("openai_balance_snapshot") or "").strip()
    use_snapshot = False
    snapshot_balance = 0.0
    if snapshot_date and snapshot_balance_str:
        try:
            sb = float(snapshot_balance_str)
            if sb >= 0:
                from datetime import datetime as dt
                d = dt.fromisoformat(snapshot_date.replace("Z", "+00:00") if "T" in snapshot_date else snapshot_date + "T00:00:00+00:00")
                start = int(d.timestamp())
                use_snapshot = True
                snapshot_balance = round(sb * 100) / 100
        except Exception:
            pass
    min_end = start + 86400
    end_final = max(end, min_end) if end > start else min_end
    limit = min(60, max(1, (end_final - start) // 86400 + 1))
    url = f"https://api.openai.com/v1/organization/costs?start_time={start}&end_time={end_final}&bucket_width=1d&limit={limit}"
    try:
        async with httpx.AsyncClient(timeout=timeout_ms / 1000.0) as client:
            r = await client.get(url, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        if r.status_code != 200:
            return {"ok": False, "error": f"HTTP {r.status_code}: {(r.text or '')[:200]}"}
        cost_data = r.json()
        buckets = cost_data.get("data") or []
        period_spend = 0.0
        currency = "USD"
        for bucket in buckets:
            for res in (bucket.get("results") or []):
                am = res.get("amount")
                if am is None:
                    continue
                if isinstance(am, dict) and "value" in am:
                    val = am.get("value")
                else:
                    val = am
                v = float(val) if val is not None else 0
                if "currency" in (am or {}):
                    currency = (am or {}).get("currency") or currency
                period_spend += v
        period_spend = round(period_spend * 100) / 100
        result = {"ok": True, "periodSpend": period_spend, "currency": currency}
        if use_snapshot:
            result["remaining"] = max(0, round((snapshot_balance - period_spend) * 100) / 100)
            result["creditBalance"] = snapshot_balance
        else:
            balance_str = (c.get("openai_credit_balance") or "").strip()
            if balance_str:
                try:
                    bal = round(float(balance_str) * 100) / 100
                    result["creditBalance"] = bal
                    result["remaining"] = bal
                except ValueError:
                    pass
        return result
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def fetch_anthropic_credits(timeout_ms: int) -> dict[str, Any]:
    c = _get_credits_config()
    key = (c.get("anthropic_key") or "").strip()
    if not key:
        return {"ok": False, "error": "anthropic_key manquant (clé Admin requise)"}
    from datetime import datetime as dt, timezone
    now = dt.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    default_start = today_start.timestamp() - 30 * 86400
    ending_at = (today_start.timestamp() + 86400)
    starting_at = default_start
    snapshot_date = (c.get("anthropic_balance_snapshot_date") or "").strip()
    snapshot_balance_str = (c.get("anthropic_balance_snapshot") or "").strip()
    use_snapshot = False
    snapshot_balance = 0.0
    snapshot_start_ms = None
    if snapshot_date and snapshot_balance_str:
        try:
            sb = float(snapshot_balance_str)
            if sb >= 0:
                d = dt.fromisoformat(snapshot_date.replace("Z", "+00:00") if "T" in snapshot_date else snapshot_date + "T00:00:00+00:00")
                snapshot_start_ms = d.timestamp()
                use_snapshot = True
                snapshot_balance = round(sb * 100) / 100
        except Exception:
            pass
    starting_at_str = dt.fromtimestamp(starting_at, tz=timezone.utc).strftime("%Y-%m-%dT00:00:00Z")
    ending_at_str = dt.fromtimestamp(ending_at, tz=timezone.utc).strftime("%Y-%m-%dT00:00:00Z")
    base_url = "https://api.anthropic.com/v1/organizations/cost_report"
    headers = {"anthropic-version": "2023-06-01", "x-api-key": key, "Content-Type": "application/json"}
    # amount.value de /v1/organizations/cost_report est un montant en USD (string décimale),
    # PAS en cents. L'ancien nom + formule "round((cents/100)*100)/100" écrasait toute valeur
    # < 1 USD à 0.0 ; on cumule en USD et on arrondit à 2 décimales.
    period_spend_usd = 0.0
    currency = "USD"
    next_page = None
    # Plafond de pages : 31 pages × 31 jours/page largement suffisant pour 1 an glissant.
    # Évite une boucle infinie si l'API renvoie has_more=True indéfiniment (bug API ou
    # réponse adversariale). Au-delà on coupe proprement et on log un warning.
    _MAX_PAGES = 31
    _page_count = 0
    try:
        async with httpx.AsyncClient(timeout=timeout_ms / 1000.0) as client:
            while True:
                _page_count += 1
                if _page_count > _MAX_PAGES:
                    import logging as _log
                    _log.getLogger("mercury").warning(
                        "[credits/anthropic] pagination cap atteint (%d pages) — arrêt préventif", _MAX_PAGES
                    )
                    break
                params = {"starting_at": starting_at_str, "ending_at": ending_at_str, "bucket_width": "1d", "limit": "31"}
                if next_page:
                    params["page"] = next_page
                r = await client.get(base_url, params=params, headers=headers)
                if r.status_code != 200:
                    return {"ok": False, "error": f"HTTP {r.status_code}: {(r.text or '')[:200]}"}
                json_data = r.json()
                buckets = json_data.get("data") or []
                for bucket in buckets:
                    bucket_start = bucket.get("starting_at")
                    bucket_start_ms = dt.fromisoformat(bucket_start.replace("Z", "+00:00")).timestamp() if bucket_start else 0
                    if use_snapshot and snapshot_start_ms is not None and bucket_start_ms < snapshot_start_ms:
                        continue
                    for res in (bucket.get("results") or bucket.get("result") or []):
                        am = res.get("amount")
                        if am is None:
                            continue
                        raw = am.get("value") if isinstance(am, dict) else am
                        try:
                            period_spend_usd += float(raw or 0)
                        except (TypeError, ValueError):
                            pass
                        if res.get("currency"):
                            currency = res["currency"]
                next_page = json_data.get("next_page") if json_data.get("has_more") else None
                if not next_page:
                    break
        period_spend = round(period_spend_usd * 100) / 100
        result = {"ok": True, "periodSpend": period_spend, "currency": currency}
        if use_snapshot:
            result["remaining"] = max(0, round((snapshot_balance - period_spend) * 100) / 100)
            result["creditBalance"] = snapshot_balance
        else:
            balance_str = (c.get("anthropic_credit_balance") or "").strip()
            if balance_str:
                try:
                    bal = round(float(balance_str) * 100) / 100
                    result["creditBalance"] = bal
                    result["remaining"] = bal
                except ValueError:
                    pass
        return result
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def fetch_elevenlabs_credits(timeout_ms: int) -> dict[str, Any]:
    """Crédits ElevenLabs via GET /v1/user/subscription (character_count / character_limit)."""
    c = _get_credits_config()
    key = (c.get("elevenlabs_key") or "").strip()
    if not key:
        # Fallback : réutiliser la clé audio (même clé chez ElevenLabs, pas de clé admin séparée)
        from routing.router import get_config
        key = (get_config().get("audio_elevenlabs_api_key") or "").strip()
    if not key:
        return {"ok": False, "error": "elevenlabs_key manquant (credits ou audio_elevenlabs_api_key)"}
    url = "https://api.elevenlabs.io/v1/user/subscription"
    try:
        async with httpx.AsyncClient(timeout=timeout_ms / 1000.0) as client:
            r = await client.get(url, headers={"xi-api-key": key})
        if r.status_code != 200:
            return {"ok": False, "error": f"HTTP {r.status_code}: {(r.text or '')[:200]}"}
        data = r.json()
        char_count = data.get("character_count")
        char_limit = data.get("character_limit")
        tier = data.get("tier", "")
        status = data.get("status", "")
        remaining = None
        if char_limit is not None and char_count is not None:
            remaining = max(0, int(char_limit) - int(char_count))
        return {
            "ok": True,
            "remaining": remaining,
            "characterCount": char_count,
            "characterLimit": char_limit,
            "tier": tier,
            "status": status,
            "currency": "characters",
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def fetch_all_credits(
    providers: list[str] | None = None,
    timeout_ms: int = 30000,
) -> dict[str, Any]:
    """
    Rapport de crédits pour les providers demandés.
    Structure : fetchedAt, providers: { openrouter?, openai?, anthropic? }, errors: list[str].
    """
    config = _get_credits_config()
    if not config.get("enabled", False):
        return {
            "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "providers": {},
            "errors": ["Crédits désactivés (credits.enabled dans config)"],
        }
    timeout_ms = min(120000, max(5000, int(timeout_ms)))
    providers = providers or PROVIDER_IDS
    results = {}
    errors = []
    tasks = []
    names = []
    for name in PROVIDER_IDS:
        if name not in providers:
            continue
        if name == "openrouter":
            tasks.append(fetch_openrouter_credits(timeout_ms))
        elif name == "openai":
            tasks.append(fetch_openai_credits(timeout_ms))
        elif name == "anthropic":
            tasks.append(fetch_anthropic_credits(timeout_ms))
        elif name == "elevenlabs":
            tasks.append(fetch_elevenlabs_credits(timeout_ms))
        else:
            continue
        names.append(name)
    if not tasks:
        return {
            "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "providers": {},
            "errors": [],
        }
    out = await asyncio.gather(*tasks, return_exceptions=True)
    for i, name in enumerate(names):
        if i >= len(out):
            break
        val = out[i]
        if isinstance(val, Exception):
            results[name] = {"ok": False, "error": str(val)}
            errors.append(f"{name}: {val}")
        else:
            results[name] = val
            if not val.get("ok") and val.get("error"):
                errors.append(f"{name}: {val['error']}")
    return {
        "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "providers": results,
        "errors": errors,
    }
