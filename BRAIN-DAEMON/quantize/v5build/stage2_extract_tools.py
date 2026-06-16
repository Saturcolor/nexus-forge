#!/usr/bin/env python3
"""
stage2_extract_tools.py — persoV5 pipeline, étape 2 (déterministe).

Parse mercury.log, reconstruit des ÉPISODES de tool-calling self-contained
(contexte → <tool_call> → <tool_response> → réponse) au format que le modèle
local GÉNÈRE réellement, plus quelques blocs de schéma <tools>. Dédup + cap.

Sortie: tools_traces.txt (blocs séparés par ligne vide), + stats.
But: donner à l'imatrix de vraies activations sur les tokens d'appel d'outil
avec les VRAIS noms de skills Mastermind (skill_*, board_write, ...).
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

HERE = Path(__file__).resolve().parent
LOG = HERE.parent.parent.parent / "mercury.log"   # racine repo

MAX_CTX = 600        # tronque le contexte prose
MAX_TOOLRES = 600    # tronque le contenu d'un tool_response
MAX_FINAL = 600      # tronque la réponse finale
MAX_SCHEMA_BLOCKS = 6


def trunc(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[:n].rstrip() + " […]"


def render_args(raw: str) -> str:
    try:
        return json.dumps(json.loads(raw), ensure_ascii=False)
    except Exception:
        return raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)


def render_tool_call(tc: dict) -> str:
    fn = tc.get("function", {})
    name = fn.get("name", "")
    args = render_args(fn.get("arguments", "{}"))
    return '<tool_call>\n{"name": "%s", "arguments": %s}\n</tool_call>' % (name, args)


RE_THINK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def text_of(content) -> str:
    """content peut être str ou liste de parts (multimodal). Strippe <think>."""
    if isinstance(content, str):
        s = content
    elif isinstance(content, list):
        s = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    else:
        return ""
    return RE_THINK.sub("", s).strip()


def main() -> None:
    if not LOG.exists():
        print(f"mercury.log introuvable: {LOG}"); sys.exit(1)

    payloads = []
    for line in LOG.open(encoding="utf-8", errors="replace"):
        m = re.search(r"reçu:\s*(\{.*\})\s*$", line)
        if not m:
            continue
        try:
            payloads.append(json.loads(m.group(1)))
        except Exception:
            pass

    episodes: dict[str, str] = {}     # hash -> bloc texte
    schemas: dict[str, str] = {}      # hash set de tools -> bloc
    reasons: Counter = Counter()

    for obj in payloads:
        # ── schéma <tools> (dédup par ensemble de noms) ──
        tools = obj.get("tools") or []
        if tools and len(schemas) < MAX_SCHEMA_BLOCKS:
            names = sorted(t.get("function", {}).get("name", "") for t in tools)
            key = hashlib.sha1("|".join(names).encode()).hexdigest()
            if key not in schemas:
                defs = [t.get("function", {}) for t in tools]
                body = "\n".join(json.dumps(d, ensure_ascii=False) for d in defs)
                schemas[key] = "<tools>\n" + body + "\n</tools>"

        msgs = obj.get("messages", [])
        # index des résultats par tool_call_id
        results_by_id = {}
        for msg in msgs:
            if msg.get("role") == "tool" and msg.get("tool_call_id"):
                results_by_id[msg["tool_call_id"]] = text_of(msg.get("content"))

        for i, msg in enumerate(msgs):
            if msg.get("role") != "assistant" or not msg.get("tool_calls"):
                continue
            tcs = msg["tool_calls"]
            # contexte amont : dernier user/assistant-text avant ce tour
            ctx = ""
            for j in range(i - 1, -1, -1):
                pm = msgs[j]
                if pm.get("role") in ("user", "assistant"):
                    t = text_of(pm.get("content"))
                    if t.strip():
                        ctx = t
                        break
            parts = []
            if ctx.strip():
                parts.append(trunc(ctx, MAX_CTX))
            # texte éventuel de l'assistant avant ses tool_calls
            asst_pre = text_of(msg.get("content"))
            if asst_pre.strip():
                parts.append(trunc(asst_pre, MAX_CTX))
            for tc in tcs:
                parts.append(render_tool_call(tc))
                rid = tc.get("id")
                if rid and rid in results_by_id:
                    parts.append("<tool_response>\n" + trunc(results_by_id[rid], MAX_TOOLRES) + "\n</tool_response>")
            # réponse finale de l'assistant (msg suivant en role assistant avec content)
            for k in range(i + 1, len(msgs)):
                nm = msgs[k]
                if nm.get("role") == "assistant" and not nm.get("tool_calls"):
                    t = text_of(nm.get("content"))
                    if t.strip():
                        parts.append(trunc(t, MAX_FINAL))
                    break
                if nm.get("role") == "user":
                    break
            block = "\n".join(parts).strip()
            # Bloc ATOMIQUE : pas de ligne vide interne, sinon le split \n\n en aval
            # fragmenterait l'épisode (le contexte deviendrait un bloc orphelin).
            block = re.sub(r"\n{2,}", "\n", block).strip()
            if len(block) < 40:
                reasons["too_short"] += 1
                continue
            h = hashlib.sha1(re.sub(r"\s+", " ", block).encode()).hexdigest()
            if h in episodes:
                reasons["dup"] += 1
                continue
            episodes[h] = block
            reasons["kept"] += 1

    out_blocks = list(schemas.values()) + list(episodes.values())
    text = "\n\n".join(out_blocks) + "\n"
    (HERE / "tools_traces.txt").write_text(text, encoding="utf-8")

    nbytes = len(text.encode())
    print(f"payloads parsés : {len(payloads)}")
    print(f"schémas <tools> : {len(schemas)}")
    print(f"épisodes        : kept={reasons['kept']} dup={reasons['dup']} too_short={reasons['too_short']}")
    print(f"sortie          : tools_traces.txt — {nbytes/1024:.0f} Ko, ~{int(nbytes/3.8/1000)}k tok")


if __name__ == "__main__":
    main()
