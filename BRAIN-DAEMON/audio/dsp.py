"""Audio DSP — mastering presets via Spotify pedalboard.

Adapté d'OmniVoice Studio (FSL-1.1-ALv2). Si pedalboard n'est pas installé,
toutes les fonctions sont no-ops gracieuses → la voix sort sans mastering.

Apply post-synth pour donner du caractère à la voix clonée :
  raw         → no processing (model output as-is)
  broadcast   → radio/podcast standard (warm, compressed, clear)
  cinematic   → film-quality (spacious reverb, gentle compression)
  podcast     → close-mic, intimate (heavy compression, no reverb)
  warm        → boosted low-mids, subtle saturation
  bright      → crisp high-end, presence boost
"""
from __future__ import annotations

import logging
from typing import Iterable

logger = logging.getLogger("brain-daemon")

# ── Presets ─────────────────────────────────────────────────────────────────

EFFECT_PRESETS: dict[str, dict] = {
    "raw": {
        "label": "Raw",
        "description": "No processing — model output as-is.",
        "chain": [],
    },
    "broadcast": {
        "label": "Broadcast",
        "description": "Radio/podcast standard — warm, compressed, clear.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 80},
            {"type": "compressor", "threshold_db": -18, "ratio": 3.0, "attack_ms": 5, "release_ms": 80},
            {"type": "eq", "low_gain_db": 1.5, "mid_gain_db": 0, "high_gain_db": 2.0},
            {"type": "limiter", "threshold_db": -1.0},
        ],
    },
    "cinematic": {
        "label": "Cinematic",
        "description": "Film-quality — spacious reverb, gentle compression.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 60},
            {"type": "compressor", "threshold_db": -15, "ratio": 1.8, "attack_ms": 10, "release_ms": 150},
            {"type": "reverb", "room_size": 0.35, "wet_level": 0.15, "dry_level": 0.85},
            {"type": "limiter", "threshold_db": -1.5},
        ],
    },
    "podcast": {
        "label": "Podcast",
        "description": "Close-mic, intimate — heavy compression, no reverb.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 100},
            {"type": "noise_gate", "threshold_db": -40, "release_ms": 200},
            {"type": "compressor", "threshold_db": -20, "ratio": 4.0, "attack_ms": 2, "release_ms": 60},
            {"type": "eq", "low_gain_db": -1.0, "mid_gain_db": 2.0, "high_gain_db": 1.5},
            {"type": "limiter", "threshold_db": -0.5},
        ],
    },
    "warm": {
        "label": "Warm",
        "description": "Boosted low-mids, cozy feel.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 60},
            {"type": "eq", "low_gain_db": 3.0, "mid_gain_db": 1.0, "high_gain_db": -1.0},
            {"type": "compressor", "threshold_db": -16, "ratio": 2.0, "attack_ms": 8, "release_ms": 120},
            {"type": "reverb", "room_size": 0.15, "wet_level": 0.06, "dry_level": 0.94},
        ],
    },
    "bright": {
        "label": "Bright",
        "description": "Crisp high-end, presence boost, airy feel.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 80},
            {"type": "eq", "low_gain_db": -1.0, "mid_gain_db": 0, "high_gain_db": 4.0},
            {"type": "compressor", "threshold_db": -14, "ratio": 2.5, "attack_ms": 3, "release_ms": 80},
            {"type": "limiter", "threshold_db": -1.0},
        ],
    },
}


def list_presets() -> list[dict]:
    return [
        {"id": k, "label": v["label"], "description": v["description"]}
        for k, v in EFFECT_PRESETS.items()
    ]


def _build_board(chain: Iterable[dict]):
    """Return a pedalboard.Pedalboard, or None if lib missing or chain empty."""
    try:
        from pedalboard import (
            Pedalboard, Compressor, Reverb, HighpassFilter, LowpassFilter,
            NoiseGate, Limiter, LowShelfFilter, HighShelfFilter, PeakFilter,
            PitchShift,
        )
    except ImportError:
        logger.debug("pedalboard not installed — DSP skipped")
        return None

    plugins: list = []
    for fx in chain:
        t = (fx.get("type") or "").lower()
        try:
            if t == "highpass":
                plugins.append(HighpassFilter(cutoff_frequency_hz=fx.get("cutoff_hz", 80)))
            elif t == "lowpass":
                plugins.append(LowpassFilter(cutoff_frequency_hz=fx.get("cutoff_hz", 8000)))
            elif t == "compressor":
                plugins.append(Compressor(
                    threshold_db=fx.get("threshold_db", -15),
                    ratio=fx.get("ratio", 2.0),
                    attack_ms=fx.get("attack_ms", 5),
                    release_ms=fx.get("release_ms", 100),
                ))
            elif t == "reverb":
                plugins.append(Reverb(
                    room_size=fx.get("room_size", 0.2),
                    wet_level=fx.get("wet_level", 0.1),
                    dry_level=fx.get("dry_level", 0.9),
                ))
            elif t == "noise_gate":
                plugins.append(NoiseGate(
                    threshold_db=fx.get("threshold_db", -40),
                    release_ms=fx.get("release_ms", 200),
                ))
            elif t == "limiter":
                plugins.append(Limiter(threshold_db=fx.get("threshold_db", -1.0)))
            elif t == "eq":
                low = fx.get("low_gain_db", 0)
                mid = fx.get("mid_gain_db", 0)
                high = fx.get("high_gain_db", 0)
                if low:
                    plugins.append(LowShelfFilter(cutoff_frequency_hz=250, gain_db=low))
                if mid:
                    plugins.append(PeakFilter(cutoff_frequency_hz=1500, gain_db=mid, q=1.0))
                if high:
                    plugins.append(HighShelfFilter(cutoff_frequency_hz=4000, gain_db=high))
            elif t == "pitch_shift":
                # Décale toute la voix en demi-tons sans toucher au tempo.
                # Range typique : -12 à +12. Au-delà ça sonne robotique.
                plugins.append(PitchShift(semitones=fx.get("semitones", 0)))
            else:
                logger.debug("Unknown DSP effect: %s — skipped", t)
        except Exception as e:
            logger.warning("DSP effect %s failed to build: %s", t, e)
    return Pedalboard(plugins) if plugins else None


def apply_chain(audio_np, sample_rate: int, chain: list[dict]):
    """Apply an arbitrary DSP chain (list of {type, ...params}) to audio.
    Public counterpart of apply_preset for callers who build their own chain
    (Voice Studio custom DSP)."""
    if not chain:
        return audio_np
    board = _build_board(chain)
    if board is None:
        return audio_np
    import numpy as np
    feed = audio_np[np.newaxis, :] if audio_np.ndim == 1 else audio_np
    try:
        out = board(feed, sample_rate, reset=False)
        return out[0] if audio_np.ndim == 1 else out
    except Exception as e:
        logger.warning("DSP apply_chain failed: %s — returning unmodified", e)
        return audio_np


def shift_pitch(audio_np, sample_rate: int, semitones: float):
    """Standalone pitch shift via pedalboard. No-op if semitones≈0."""
    if not semitones or abs(semitones) < 1e-3:
        return audio_np
    return apply_chain(audio_np, sample_rate, [{"type": "pitch_shift", "semitones": float(semitones)}])


def apply_preset(audio_np, sample_rate: int, preset_id: str):
    """Apply a named preset to a numpy mono/stereo audio array.

    `audio_np`: np.ndarray, shape (n,) or (channels, n).
    Returns the processed array (same shape) or the input if no-op.
    """
    preset = EFFECT_PRESETS.get(preset_id or "raw")
    if not preset or not preset["chain"]:
        return audio_np
    board = _build_board(preset["chain"])
    if board is None:
        return audio_np

    import numpy as np
    if audio_np.ndim == 1:
        feed = audio_np[np.newaxis, :]
    else:
        feed = audio_np
    try:
        out = board(feed, sample_rate, reset=False)
        return out[0] if audio_np.ndim == 1 else out
    except Exception as e:
        logger.warning("DSP apply_preset failed: %s — returning unmodified", e)
        return audio_np


def normalize_peak(audio_np, target_dbfs: float = -2.0):
    """Peak-normalize to target dBFS. Mutates a copy."""
    import numpy as np
    if audio_np.size == 0:
        return audio_np
    peak = float(np.max(np.abs(audio_np)))
    if peak <= 0:
        return audio_np
    target_amp = 10 ** (target_dbfs / 20.0)
    return audio_np * (target_amp / peak)
