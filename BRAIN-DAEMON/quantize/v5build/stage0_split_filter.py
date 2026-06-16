#!/usr/bin/env python3
"""
stage0_split_filter.py — persoV5 pipeline, étape 0 (déterministe).

Split persoV4 en paragraphes, applique un filtre de bruit SÉMANTIQUE que les
regex de build-calibration.py ratent (logs emoji, fuites system-prompt, JSON
runtime), et SÉPARE :
  - clean_kept.txt   : paragraphes gardés VERBATIM (prose propre, sûre)
  - suspicious.jsonl : paragraphes douteux à faire juger par un LLM (GARDE/JETTE)
  - hard_dropped.jsonl : déchet certain (audit)

Aucune réécriture. On garde le texte mot pour mot ; on ne fait que TRIER.
Max de log partout (counts par catégorie + sha + sanity).
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
CALIB = HERE.parent / "calibration"
SRC = CALIB / "persoV4.txt"
OUT = HERE  # outputs à côté du script

# ── HARD DROP : déchet certain, retrait verbatim ────────────────────────────
# Lignes de log agent emoji-timestamp / flèches tool / dumps runtime.
RE_EMOJI_LOG = re.compile(r"[🔧🤖👤🦅]\s*\[\d{1,2}:\d{2}\]")
RE_TOOL_ARROW = re.compile(r"\[(?:→|↩)\s")
# Fuites de system-prompt connu (agent harness).
SYSPROMPT_LEAKS = (
    "When you call",
    "dispatch_sandbox_run",
    "escalate_to_agent",
    "their summary describes their intent",
    "Verify the artifact",
)
# Signatures JSON runtime (orchestration agents).
RE_RUNTIME_JSON = re.compile(r'"(?:runId|sessionKey|sessionKey|agentId|requester|allowAny)"\s*:')

# ── SUSPECT : douteux, à juger par LLM ──────────────────────────────────────
# Glyphe de log isolé (sans match hard), fragments JSON, alnum bas, queue coupée.
RE_ANY_LOG_GLYPH = re.compile(r"[🔧🤖👤🦅↩→]")
RE_JSON_FRAGMENT = re.compile(r'[{}]\s*"|"\s*:\s*"|\}\s*,?\s*$')
# Termine en plein mot : finit par lettre minuscule + (optionnel) guillemet/virgule
# collés, paragraphe long → probable troncature ("...fonctionner mainte", agentId).
RE_TRUNCATED_TAIL = re.compile(r'[a-zà-ÿ]["”]?\s*,?\s*\w*$')
TERMINAL_PUNCT = tuple(".!?…:)»\"”'`*]》】")


def alnum_ratio(s: str) -> float:
    if not s:
        return 0.0
    return sum(1 for c in s if c.isalnum() or c.isspace()) / len(s)


def classify(p: str) -> tuple[str, str]:
    """Retourne (verdict, raison). verdict ∈ {keep, suspect, drop}."""
    # HARD DROP
    if RE_EMOJI_LOG.search(p):
        return "drop", "emoji_log"
    if RE_TOOL_ARROW.search(p):
        return "drop", "tool_arrow"
    for leak in SYSPROMPT_LEAKS:
        if leak in p:
            return "drop", "sysprompt_leak"
    if RE_RUNTIME_JSON.search(p):
        return "drop", "runtime_json"

    # SUSPECT
    if RE_ANY_LOG_GLYPH.search(p):
        return "suspect", "stray_glyph"
    if alnum_ratio(p) < 0.50:
        return "suspect", "low_alnum"
    # fragments JSON nombreux
    if len(RE_JSON_FRAGMENT.findall(p)) >= 2:
        return "suspect", "json_fragment"
    # troncature : long, ne finit pas par ponctuation terminale, finit en plein mot
    stripped = p.rstrip()
    if (
        len(stripped) > 200
        and not stripped.endswith(TERMINAL_PUNCT)
        and RE_TRUNCATED_TAIL.search(stripped[-40:])
    ):
        return "suspect", "truncated_tail"

    return "keep", "clean"


def main() -> None:
    raw = SRC.read_text(encoding="utf-8", errors="replace")
    paras = [p.strip() for p in re.split(r"\n\s*\n", raw) if p.strip()]
    print(f"persoV4: {len(paras)} paragraphes, sha={hashlib.sha1(raw.encode()).hexdigest()[:12]}")

    kept: list[str] = []
    suspects: list[dict] = []
    dropped: list[dict] = []
    reasons: Counter = Counter()

    for i, p in enumerate(paras):
        verdict, reason = classify(p)
        reasons[f"{verdict}:{reason}"] += 1
        if verdict == "keep":
            kept.append(p)
        elif verdict == "suspect":
            suspects.append({"idx": i, "reason": reason, "text": p})
        else:
            dropped.append({"idx": i, "reason": reason, "text": p[:300]})

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "clean_kept.txt").write_text("\n\n".join(kept) + "\n", encoding="utf-8")
    with (OUT / "suspicious.jsonl").open("w", encoding="utf-8") as f:
        for s in suspects:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    with (OUT / "hard_dropped.jsonl").open("w", encoding="utf-8") as f:
        for d in dropped:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")

    kept_bytes = sum(len(p.encode()) for p in kept)
    susp_bytes = sum(len(s["text"].encode()) for s in suspects)
    print("\n── Verdicts ──")
    for k, v in sorted(reasons.items(), key=lambda x: -x[1]):
        print(f"  {k:28s} {v:6d}")
    print("\n── Bilan ──")
    print(f"  keep     : {len(kept):6d} paragraphes  ({kept_bytes/1e6:.2f} Mo, ~{int(kept_bytes/3.8/1000)}k tok)")
    print(f"  suspect  : {len(suspects):6d} paragraphes  ({susp_bytes/1e6:.2f} Mo, ~{int(susp_bytes/3.8/1000)}k tok)")
    print(f"  drop     : {len(dropped):6d} paragraphes")


if __name__ == "__main__":
    main()
