"""brain-quant lib — logique pure réutilisable par TUI (brain-quant.py /
inspect-imatrix.py / build-calibration.py) ET par brain-daemon `/quant/*` router.

Modules :
    paths       : resolveur de chemins (models_path, output_dir, calib_dir, imatrix_dir)
    config      : load + validate config.yaml
    scan        : scan FS (modèles sources, calibrations, GGUFs, imatrices)
    toolbox     : wrappers `toolbox run -c ...` + helpers accessibilité
    imatrix     : runner llama-imatrix + parser binaire .imatrix + dedup cache
    quantize    : runner llama-quantize + builder overrides + validator GGUF post-quant
    surgical    : emitter de presets surgical depuis stats imatrix (top-K% F16 per-family)
    presets     : registry presets canoniques (config.yaml) + normalisation
    calibration : builder de corpus calibration (dedup MinHash+LSH, bucket balance)
    gguf        : re-export gguf_stats (lecture header GGUF, sharded)

Pattern progress_cb : chaque runner long-running (run_imatrix, run_quantize,
build_corpus) prend un `Callable[[ProgressEvent], None]` + un `asyncio.Event | None`
pour cancel. Le TUI passe un callback qui pousse vers rich.Progress, le daemon
pousse les events dans une queue NDJSON.
"""
from __future__ import annotations

__all__ = [
    "paths",
    "config",
    "scan",
    "toolbox",
    "imatrix",
    "quantize",
    "surgical",
    "presets",
    "calibration",
    "gguf",
]
