"""
quality_eval.py — Suite de quality eval auto post-quantize pour brain-quant.

Inspiré de opentq/src/opentq/quality_eval.py (zlaabsi), adapté pour :
  - lancer via toolbox podman (pas binaire direct sur l'hôte)
  - respecter le chat template du modèle via --jinja (Gemma, Qwen, Mistral...)
  - produire un rapport JSON informatif (pas de "release gate" bloquant)

Workflow :
  1. brain-quant produit N quants → on appelle run_quality_eval() pour chaque
  2. Pour chaque sample du JSONL : llama-cli --jinja -p <prompt> → output
  3. Scoring auto (contains / contains_all / exact / regex / json_valid /
     json_contains)
  4. Dump rapport JSON par quant + table comparative à l'écran

Format JSON output (compatible opentq schema "opentq.gguf_quality_eval.v1") :
  {
    "schema": "brain-quant.gguf_quality_eval.v1",
    "gguf": "<path>",
    "quant_name": "UD-Q5_K_M",
    "started_at": "2026-05-02T14:32:01+00:00",
    "duration_seconds": 145.3,
    "samples": [ { id, category, prompt, output, score{passed, scorer, ...}, ... } ],
    "summary": {
      "total": 18, "passed": 17, "pass_rate": 0.944,
      "categories": { knowledge: {total, passed, pass_rate}, ... },
      "latency_seconds_p50": 4.2, "latency_seconds_p95": 12.1
    }
  }

Aucune dépendance externe — utilise uniquement json/re/subprocess/dataclasses.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Optional


SCHEMA_VERSION = "brain-quant.gguf_quality_eval.v1"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _percentile(values: list[float], pct: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, math.ceil((pct / 100.0) * len(ordered)) - 1))
    return round(ordered[idx], 3)


def _tail(text: str, max_chars: int = 12_000) -> str:
    return text if len(text) <= max_chars else text[-max_chars:]


# ────────────────────────────────────────────────────────────────────────────
# Sample loader
# ────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class QualityEvalOptions:
    gguf: Path
    suite: Path
    output: Path
    toolbox: str
    quant_name: str = ""
    gpu_layers: str = "999"
    ctx_size: int = 4096
    flash_attn: bool = True
    timeout_seconds: float = 300.0
    temperature: float = 0.0
    max_samples: Optional[int] = None
    sample_ids: tuple[str, ...] = field(default_factory=tuple)


def load_suite(path: Path,
               max_samples: Optional[int] = None,
               sample_ids: tuple[str, ...] = ()) -> list[dict[str, Any]]:
    """Parse un JSONL de samples. Lignes vides et `#` ignorées.

    Format attendu par sample :
        {id, category?, description?, prompt, expected, scorer, max_tokens?}

    Lève ValueError si un sample est mal formé.
    """
    if not path.exists():
        raise FileNotFoundError(f"missing quality suite: {path}")
    selected = set(sample_ids)
    samples: list[dict[str, Any]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        try:
            sample = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise ValueError(f"sample line {line_no} invalid JSON: {exc}") from exc
        if "id" not in sample:
            raise ValueError(f"sample line {line_no} missing 'id'")
        if "prompt" not in sample:
            raise ValueError(f"sample {sample['id']} missing 'prompt'")
        if selected and sample["id"] not in selected:
            continue
        samples.append(sample)
        if max_samples is not None and len(samples) >= max_samples:
            break
    if selected:
        found = {s["id"] for s in samples}
        missing = sorted(selected - found)
        if missing:
            raise ValueError(f"sample ids not found in {path}: {', '.join(missing)}")
    if not samples:
        raise ValueError(f"no samples selected from {path}")
    return samples


# ────────────────────────────────────────────────────────────────────────────
# Scoring
# ────────────────────────────────────────────────────────────────────────────


def _expected_strings(sample: dict[str, Any]) -> list[str]:
    """Normalise sample.expected en list[str] pour scorers basés string."""
    raw = sample.get("expected", [])
    if isinstance(raw, list):
        return [str(item) for item in raw]
    if isinstance(raw, dict):
        # json_contains : on garde le dict tel quel via score_output()
        return list(map(str, raw.keys()))
    return [str(raw)]


def clean_output_for_scoring(output: str) -> str:
    """Strip whitespace + markers de fin connus avant scoring."""
    cleaned = output.strip()
    for marker in ("[end of text]", "<|im_end|>", "<|eot_id|>", "</s>"):
        while cleaned.endswith(marker):
            cleaned = cleaned[: -len(marker)].strip()
    return cleaned


def _strip_markdown_fences(text: str) -> str:
    """Retire ```json ... ``` et ``` ... ``` si présents (pour json_contains)."""
    s = text.strip()
    m = re.match(r"^```(?:json)?\s*\n(.*?)\n```\s*$", s, flags=re.DOTALL)
    if m:
        return m.group(1).strip()
    return s


def score_output(sample: dict[str, Any], output: str) -> dict[str, Any]:
    """Évalue un output selon sample['scorer']. Retourne un dict détail."""
    scorer = str(sample.get("scorer", "contains")).lower()
    expected = _expected_strings(sample)
    normalized = clean_output_for_scoring(output)
    lowered = normalized.lower()

    passed = False
    detail: dict[str, Any] = {"scorer": scorer, "expected": expected}

    if scorer == "contains":
        passed = any(item.lower() in lowered for item in expected)
    elif scorer == "contains_all":
        passed = all(item.lower() in lowered for item in expected)
    elif scorer == "exact":
        passed = bool(expected) and normalized == expected[0]
    elif scorer == "regex":
        if not expected:
            raise ValueError(f"sample {sample['id']} regex scorer needs expected pattern")
        passed = re.search(expected[0], normalized,
                           flags=re.IGNORECASE | re.DOTALL) is not None
    elif scorer == "json_valid":
        try:
            parsed = json.loads(_strip_markdown_fences(normalized))
            passed = True
            detail["parsed_type"] = type(parsed).__name__
        except json.JSONDecodeError as exc:
            detail["json_error"] = str(exc)
    elif scorer == "json_contains":
        expected_map = sample.get("expected", {})
        if not isinstance(expected_map, dict):
            raise ValueError(
                f"sample {sample['id']} json_contains needs expected dict"
            )
        detail["expected"] = expected_map
        try:
            parsed = json.loads(_strip_markdown_fences(normalized))
            detail["parsed_type"] = type(parsed).__name__
            if not isinstance(parsed, dict):
                detail["json_error"] = "expected JSON object"
            else:
                missing = {
                    k: {"expected": v, "actual": parsed.get(k)}
                    for k, v in expected_map.items()
                    if parsed.get(k) != v
                }
                detail["missing_or_mismatched"] = missing
                passed = not missing
        except json.JSONDecodeError as exc:
            detail["json_error"] = str(exc)
    else:
        raise ValueError(f"unsupported scorer for sample {sample['id']}: {scorer}")

    detail["passed"] = passed
    return detail


# ────────────────────────────────────────────────────────────────────────────
# Runner — toolbox podman
# ────────────────────────────────────────────────────────────────────────────


def _build_llama_cli_cmd(opts: QualityEvalOptions, sample: dict[str, Any]) -> list[str]:
    """Construit la commande llama-cli pour un sample.

    Choix :
      --jinja → applique le chat template du modèle (Gemma/Qwen/Mistral...).
                Sinon le prompt est traité comme du raw → réponses random
                pour les modèles instruct.
      --no-display-prompt → seule la complétion sort sur stdout, pas de re-écho
      --temp 0 → déterministe, on veut un signal de régression reproductible
      -no-cnv → mode single-shot, pas de boucle conversationnelle
    """
    max_tokens = int(sample.get("max_tokens", 64))
    if max_tokens < 1:
        max_tokens = 64
    ctx = int(sample.get("ctx_size", opts.ctx_size))

    cmd = [
        "llama-cli",
        "-m", str(opts.gguf),
        "-ngl", str(opts.gpu_layers),
        "-c", str(ctx),
        "-n", str(max_tokens),
        "--temp", str(opts.temperature),
        "-p", sample["prompt"],
        "--jinja",
        "--no-display-prompt",
        "-no-cnv",
    ]
    if opts.flash_attn:
        cmd += ["-fa", "1"]
    return cmd


def _toolbox_run(toolbox: str, args: list[str], timeout_s: float) -> tuple[int, str, str, float]:
    """Lance via `toolbox run -c <toolbox>`, capture stdout/stderr.
    Retourne (returncode, stdout, stderr, duration_seconds).
    Sur timeout : returncode=None codé comme -1.
    """
    cmd = ["toolbox", "run", "-c", toolbox] + args
    started = time.monotonic()
    try:
        completed = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=str(Path.home()),  # toolbox containers ne montent que HOME
        )
        duration = time.monotonic() - started
        return completed.returncode, completed.stdout or "", completed.stderr or "", duration
    except subprocess.TimeoutExpired as exc:
        duration = time.monotonic() - started
        stdout = exc.stdout or b""
        stderr = exc.stderr or b""
        if isinstance(stdout, bytes):
            stdout = stdout.decode(errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode(errors="replace")
        return -1, stdout, stderr, duration


def _run_sample(opts: QualityEvalOptions, sample: dict[str, Any]) -> dict[str, Any]:
    """Lance un sample, score, retourne dict prêt à dumper."""
    cmd_args = _build_llama_cli_cmd(opts, sample)
    rc, stdout, stderr, duration = _toolbox_run(
        opts.toolbox, cmd_args, opts.timeout_seconds
    )

    timed_out = (rc == -1)
    if timed_out:
        score = {
            "scorer": str(sample.get("scorer", "contains")).lower(),
            "expected": _expected_strings(sample),
            "passed": False,
            "reason": "timeout",
        }
        passed = False
    elif rc != 0:
        score = {
            "scorer": str(sample.get("scorer", "contains")).lower(),
            "expected": _expected_strings(sample),
            "passed": False,
            "reason": f"runtime_error_rc{rc}",
        }
        passed = False
    elif not stdout.strip():
        score = {
            "scorer": str(sample.get("scorer", "contains")).lower(),
            "expected": _expected_strings(sample),
            "passed": False,
            "reason": "no_output",
        }
        passed = False
    else:
        score = score_output(sample, stdout)
        passed = bool(score.get("passed"))

    return {
        "id": sample["id"],
        "category": sample.get("category", "uncategorized"),
        "description": sample.get("description"),
        "prompt": sample["prompt"],
        "returncode": rc if not timed_out else None,
        "timed_out": timed_out,
        "duration_seconds": round(duration, 3),
        "max_tokens": int(sample.get("max_tokens", 64)),
        "ctx_size": int(sample.get("ctx_size", opts.ctx_size)),
        "stdout": _tail(stdout),
        "stderr_tail": _tail(stderr, 4_000),
        "score": score,
        "passed": passed,
    }


def _summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    durations = [float(r["duration_seconds"]) for r in results]
    passed = [r for r in results if r["passed"]]
    cats: dict[str, dict[str, Any]] = {}
    for r in results:
        cat = str(r.get("category") or "uncategorized")
        row = cats.setdefault(cat, {"total": 0, "passed": 0, "pass_rate": 0.0})
        row["total"] += 1
        row["passed"] += int(bool(r["passed"]))
    for row in cats.values():
        row["pass_rate"] = round(row["passed"] / row["total"], 4) if row["total"] else 0.0
    return {
        "total": len(results),
        "passed": len(passed),
        "failed": len(results) - len(passed),
        "pass_rate": round(len(passed) / len(results), 4) if results else 0.0,
        "duration_seconds_total": round(sum(durations), 3),
        "latency_seconds_mean": round(sum(durations) / len(durations), 3) if durations else None,
        "latency_seconds_p50": _percentile(durations, 50.0),
        "latency_seconds_p95": _percentile(durations, 95.0),
        "categories": cats,
    }


def run_quality_eval(opts: QualityEvalOptions,
                     progress_callback=None) -> dict[str, Any]:
    """Lance l'éval complète. Retourne le rapport dict (déjà dumpé sur disque).

    progress_callback(current, total, sample_id, passed) appelé après chaque
    sample. Utilisé par le TUI pour afficher la progression.
    """
    samples = load_suite(opts.suite, opts.max_samples, opts.sample_ids)
    started_at = _now_iso()
    t0 = time.monotonic()

    results: list[dict[str, Any]] = []
    for i, sample in enumerate(samples, 1):
        result = _run_sample(opts, sample)
        results.append(result)
        if progress_callback:
            try:
                progress_callback(i, len(samples), sample["id"], result["passed"])
            except Exception:
                pass

    duration = time.monotonic() - t0
    summary = _summarize(results)

    report = {
        "schema": SCHEMA_VERSION,
        "gguf": str(opts.gguf),
        "quant_name": opts.quant_name,
        "suite": str(opts.suite),
        "toolbox": opts.toolbox,
        "started_at": started_at,
        "duration_seconds": round(duration, 3),
        "options": {
            "gpu_layers": opts.gpu_layers,
            "ctx_size": opts.ctx_size,
            "flash_attn": opts.flash_attn,
            "temperature": opts.temperature,
            "timeout_seconds": opts.timeout_seconds,
        },
        "summary": summary,
        "samples": results,
    }

    opts.output.parent.mkdir(parents=True, exist_ok=True)
    opts.output.write_text(json.dumps(report, indent=2, ensure_ascii=False),
                            encoding="utf-8")
    return report


# ────────────────────────────────────────────────────────────────────────────
# Compare reports (used after multi-quant run for delta table)
# ────────────────────────────────────────────────────────────────────────────


def compare_reports(reports: list[dict[str, Any]]) -> dict[str, Any]:
    """Compare N rapports (typiquement les N quants d'un même F16).

    Retourne une struct {by_category: {cat: {quant_name: pass_rate}},
                          overall: {quant_name: pass_rate}}
    pour rendu en table.
    """
    cats: dict[str, dict[str, float]] = {}
    overall: dict[str, float] = {}
    for r in reports:
        qname = r.get("quant_name") or Path(r.get("gguf", "")).stem
        summary = r.get("summary", {})
        overall[qname] = summary.get("pass_rate", 0.0)
        for cat, row in summary.get("categories", {}).items():
            cats.setdefault(cat, {})[qname] = row.get("pass_rate", 0.0)
    return {"overall": overall, "by_category": cats}


# ────────────────────────────────────────────────────────────────────────────
# CLI standalone (pour tests sans brain-quant)
# ────────────────────────────────────────────────────────────────────────────


def _cli():
    import argparse
    ap = argparse.ArgumentParser(
        description="Run quality eval suite on a GGUF via toolbox",
    )
    ap.add_argument("gguf", type=Path, help="Path to GGUF file (must be under $HOME)")
    ap.add_argument("--suite", type=Path, required=True, help="Path to JSONL suite")
    ap.add_argument("--output", type=Path, required=True, help="Output JSON report")
    ap.add_argument("--toolbox", default="llama-vulkan-radv")
    ap.add_argument("--quant-name", default="")
    ap.add_argument("--ctx-size", type=int, default=4096)
    ap.add_argument("--gpu-layers", default="999")
    ap.add_argument("--temperature", type=float, default=0.0)
    ap.add_argument("--timeout", type=float, default=300.0)
    ap.add_argument("--no-flash-attn", action="store_true")
    ap.add_argument("--max-samples", type=int, default=None)
    ap.add_argument("--sample-id", action="append", default=[],
                    help="Restrict to specific sample ids (repeatable)")
    args = ap.parse_args()

    opts = QualityEvalOptions(
        gguf=args.gguf,
        suite=args.suite,
        output=args.output,
        toolbox=args.toolbox,
        quant_name=args.quant_name,
        ctx_size=args.ctx_size,
        gpu_layers=args.gpu_layers,
        temperature=args.temperature,
        timeout_seconds=args.timeout,
        flash_attn=not args.no_flash_attn,
        max_samples=args.max_samples,
        sample_ids=tuple(args.sample_id),
    )

    def _print(i, n, sid, passed):
        mark = "✓" if passed else "✗"
        print(f"  [{i:>2}/{n}] {mark} {sid}", flush=True)

    print(f"Running quality eval on {args.gguf.name}...")
    report = run_quality_eval(opts, progress_callback=_print)
    s = report["summary"]
    print(f"\n{s['passed']}/{s['total']} passed "
          f"({s['pass_rate']*100:.1f}%) in {report['duration_seconds']:.1f}s")
    print(f"Report: {args.output}")


if __name__ == "__main__":
    _cli()
