#!/usr/bin/env python3
"""
stage3_assemble.py — persoV5 pipeline, étape 3 (déterministe).

Assemble persoV5 = prose propre (clean_kept + suspects gardés par le LLM,
VERBATIM) + traces tool-calling, dédup exact, downsample au budget token cible,
dose les tools à la fraction voulue, shuffle (seed), écrit persoV5.txt + manifest.

Re-scanne le bruit en sortie (doit être ~0) comme sanity check.

Params:
  --total-tok 1300000   budget total approx (bytes/3.8)
  --tool-frac 0.15      fraction cible de tokens = traces tool
  --tool-repeat-max 4   plafond de duplication des traces tool (data limitée)
  --seed 42
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

HERE = Path(__file__).resolve().parent
CALIB = HERE.parent / "calibration"

# Panels machine résiduels que les juges LLM ont pu rater (appliqué à la PROSE
# seulement, pas aux blocs tool intentionnels). Drop verbatim.
PROSE_PANEL_NOISE = re.compile(
    r"\[MEMORY CONTEXT\]|\[BOARD\b|\[SCHEDULED_TASK\]|untrusted metadata"
    r"|<relevant-memories>|Conversation info \(untrusted",
    re.IGNORECASE,
)

# Re-scan final — signatures de VRAI bruit. Le leak harness = la phrase complète
# (pas les noms d'outils nus, qui sont légitimes dans les blocs <tools>).
RE_EMOJI_LOG = re.compile(r"[🔧🤖👤🦅]\s*\[\d{1,2}:\d{2}\]")
RE_TOOL_ARROW = re.compile(r"\[(?:→|↩)\s")
SYSPROMPT_LEAKS = ("their summary describes their intent", "untrusted metadata",
                   "[SCHEDULED_TASK]", "[MEMORY CONTEXT]")
# Blocs tool intentionnels (schéma + épisodes) — exclus du re-scan bruit prose.
# Un épisode commence par du contexte puis contient un <tool_call>; on exclut
# tout bloc qui porte un tag tool n'importe où.
RE_TOOL_BLOCK = re.compile(r"<(tools|tool_call|tool_response)>")


def toks(b: int) -> int:
    return int(b / 3.8)


def noise_scan(paras: list[str]) -> dict:
    hits = {"emoji_log": 0, "tool_arrow": 0, "sysprompt_leak": 0}
    for p in paras:
        if RE_TOOL_BLOCK.search(p):   # blocs tool voulus → pas du bruit prose
            continue
        if RE_EMOJI_LOG.search(p):
            hits["emoji_log"] += 1
        if RE_TOOL_ARROW.search(p):
            hits["tool_arrow"] += 1
        if any(s in p for s in SYSPROMPT_LEAKS):
            hits["sysprompt_leak"] += 1
    return hits


def dedup_exact(paras: list[str]) -> tuple[list[str], int]:
    seen, out, dups = set(), [], 0
    for p in paras:
        k = hashlib.sha1(re.sub(r"\s+", " ", p.lower()).encode()).hexdigest()
        if k in seen:
            dups += 1
            continue
        seen.add(k)
        out.append(p)
    return out, dups


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--total-tok", type=int, default=1_300_000)
    ap.add_argument("--tool-frac", type=float, default=0.15)
    ap.add_argument("--tool-repeat-max", type=int, default=4)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=str(CALIB / "persoV5.txt"))
    args = ap.parse_args()
    rng = random.Random(args.seed)

    # ── 1. prose : clean_kept + suspects gardés (drops.json = idx à jeter) ──
    clean = [p.strip() for p in (HERE / "clean_kept.txt").read_text(encoding="utf-8").split("\n\n") if p.strip()]
    drop_set = set(json.loads((HERE / "drops.json").read_text(encoding="utf-8")))
    susp_kept = []
    for line in (HERE / "suspicious.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        o = json.loads(line)
        if o["idx"] not in drop_set:
            susp_kept.append(o["text"].strip())
    prose_pool = clean + susp_kept
    # passe finale : drop panels machine résiduels ratés par les juges
    before_panel = len(prose_pool)
    prose_pool = [p for p in prose_pool if not PROSE_PANEL_NOISE.search(p)]
    panel_dropped = before_panel - len(prose_pool)
    prose_pool, prose_dups = dedup_exact(prose_pool)

    # ── 2. tools ──
    tool_blocks = [b.strip() for b in (HERE / "tools_traces.txt").read_text(encoding="utf-8").split("\n\n") if b.strip()]
    tool_bytes_unit = sum(len(b.encode()) for b in tool_blocks)

    # ── 3. budgets ──
    tool_tok_target = int(args.total_tok * args.tool_frac)
    unit_tok = toks(tool_bytes_unit)
    repeat = max(1, min(args.tool_repeat_max, round(tool_tok_target / max(1, unit_tok))))
    tools_final = tool_blocks * repeat
    tools_tok = toks(tool_bytes_unit) * repeat

    prose_tok_budget = max(0, args.total_tok - tools_tok)
    # downsample prose au budget (shuffle puis prend jusqu'au budget)
    rng.shuffle(prose_pool)
    prose_final, acc = [], 0
    for p in prose_pool:
        pb = len(p.encode())
        if acc + pb > prose_tok_budget * 3.8 and prose_final:
            break
        prose_final.append(p)
        acc += pb
    prose_tok = toks(acc)

    # ── 4. mélange final ──
    allb = prose_final + tools_final
    rng.shuffle(allb)
    text = "\n\n".join(allb) + "\n"
    nbytes = len(text.encode())
    sha = hashlib.sha1(text.encode()).hexdigest()

    out = Path(args.out)
    out.write_text(text, encoding="utf-8")

    # ── 5. sanity : re-scan bruit ──
    noise = noise_scan(allb)

    manifest = {
        "script": "stage3_assemble.py", "source": "persoV4.txt + mercury.log",
        "seed": args.seed,
        "prose_pool_after_dedup": len(prose_pool), "prose_exact_dups": prose_dups,
        "panel_noise_dropped": panel_dropped,
        "prose_final_paras": len(prose_final), "prose_tok_est": prose_tok,
        "suspects_kept": len(susp_kept), "suspects_dropped_by_llm": len(drop_set),
        "tool_unique_blocks": len(tool_blocks), "tool_repeat": repeat,
        "tool_tok_est": tools_tok, "tool_frac_actual": round(tools_tok / max(1, prose_tok + tools_tok), 3),
        "final_blocks": len(allb), "final_bytes": nbytes, "final_tok_est": toks(nbytes),
        "sha1": sha, "noise_rescan": noise,
    }
    (out.with_suffix(".manifest.json")).write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    if any(noise.values()):
        print("\n⚠ BRUIT RESIDUEL DETECTE — investiguer avant usage.")
    else:
        print("\n✓ re-scan bruit = 0")


if __name__ == "__main__":
    main()
