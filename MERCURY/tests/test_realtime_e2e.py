"""E2E test for Mercury's /v1/realtime proxy → OpenAI Realtime.

Run manually with:
    python tests/test_realtime_e2e.py \
        --mercury-url ws://localhost:17890 \
        --mercury-key <your-mercury-api-key> \
        --model gpt-realtime-2

Requires a Mercury instance running with `realtime_enabled: true` and a valid
`audio_openai_api_key`. The test sends a synthetic 1s silence audio buffer
(no STT will trigger) then sends a text user message to validate the
text→text roundtrip. For a true audio hello→bonjour test, set --audio-wav
to a path to a 24kHz PCM16 mono WAV.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import time
import wave
from pathlib import Path

try:
    import websockets
except ImportError:
    print("Missing dep: pip install websockets", file=sys.stderr)
    sys.exit(2)


def load_wav_24khz_pcm16(path: Path) -> bytes:
    """Load a WAV file, assert 24kHz mono PCM16, return raw PCM bytes."""
    with wave.open(str(path), "rb") as w:
        if w.getnchannels() != 1:
            raise ValueError(f"Expected mono, got {w.getnchannels()} channels")
        if w.getsampwidth() != 2:
            raise ValueError(f"Expected 16-bit PCM, got {w.getsampwidth() * 8}-bit")
        if w.getframerate() != 24000:
            raise ValueError(f"Expected 24000 Hz, got {w.getframerate()} Hz")
        return w.readframes(w.getnframes())


async def run_text_only_test(url: str, key: str, model: str) -> int:
    """Minimal validation: hello text → bonjour text. No audio."""
    print(f"[test] Connecting to {url} model={model}")
    async with websockets.connect(
        url,
        additional_headers={"Authorization": f"Bearer {key}"},
        max_size=None,
    ) as ws:
        print("[test] Connected. Sending session.update...")
        # `output_modalities` is the current field name (was `modalities` in
        # earlier preview versions); we send the legacy alias too for safety
        # in case OpenAI is still routing older models on the old schema.
        await ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "instructions": "You are a translator. Translate the user's English text to French. Output only the French translation, nothing else.",
                "output_modalities": ["text"],
                "modalities": ["text"],
            },
        }))
        await ws.send(json.dumps({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "Hello, how are you?"}],
            },
        }))
        await ws.send(json.dumps({"type": "response.create"}))

        final_text = ""
        usage = None
        t0 = time.perf_counter()
        async for raw in ws:
            data = json.loads(raw)
            t = data.get("type", "?")
            # Current API: response.output_text.delta / response.output_text.done
            # Legacy alias still accepted: response.text.delta / response.text.done
            if t in ("response.output_text.delta", "response.text.delta"):
                final_text += data.get("delta", "")
                print(f"[delta] {data.get('delta', '')!r}")
            elif t in ("response.output_text.done", "response.text.done"):
                final_text = data.get("text", final_text)
            elif t == "response.done":
                usage = data.get("response", {}).get("usage")
                print(f"[test] response.done usage={usage}")
                break
            elif t == "error":
                print(f"[test][ERROR] {data}", file=sys.stderr)
                return 1
            else:
                print(f"[evt] {t}")

        elapsed = time.perf_counter() - t0
        print(f"[test] Final text: {final_text!r}")
        print(f"[test] Elapsed: {elapsed:.2f}s")
        if not final_text.strip():
            print("[test] FAIL: no text returned", file=sys.stderr)
            return 1
        if "bonjour" not in final_text.lower() and "comment" not in final_text.lower():
            print(f"[test] WARN: unexpected translation: {final_text!r}", file=sys.stderr)
        print(f"[test] PASS — usage={usage}")
        return 0


async def run_audio_test(url: str, key: str, model: str, wav_path: Path) -> int:
    """Audio in → text out: send a WAV, expect French transcription."""
    print(f"[test] Loading WAV {wav_path}")
    pcm = load_wav_24khz_pcm16(wav_path)
    print(f"[test] Loaded {len(pcm)} bytes PCM16 24kHz mono")

    async with websockets.connect(
        url,
        additional_headers={"Authorization": f"Bearer {key}"},
        max_size=None,
    ) as ws:
        await ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "instructions": "Translate the user's speech to French. Output only the French translation as text, nothing else.",
                "output_modalities": ["text"],
                "modalities": ["text"],
                "input_audio_format": "pcm16",
                "turn_detection": None,
            },
        }))
        # Send audio in ~100ms chunks
        chunk_size = 2 * 24000 // 10  # 2 bytes per sample * 24kHz / 10
        for offset in range(0, len(pcm), chunk_size):
            chunk = pcm[offset:offset + chunk_size]
            await ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(chunk).decode("ascii"),
            }))
        await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
        await ws.send(json.dumps({"type": "response.create"}))

        final_text = ""
        transcript_in = ""
        usage = None
        async for raw in ws:
            data = json.loads(raw)
            t = data.get("type", "?")
            if t == "conversation.item.input_audio_transcription.completed":
                transcript_in = data.get("transcript", "")
                print(f"[stt] input transcript: {transcript_in!r}")
            elif t in ("response.output_text.delta", "response.text.delta", "response.audio_transcript.delta"):
                final_text += data.get("delta", "")
            elif t in ("response.output_text.done", "response.text.done", "response.audio_transcript.done"):
                final_text = data.get("text") or data.get("transcript") or final_text
            elif t == "response.done":
                usage = data.get("response", {}).get("usage")
                break
            elif t == "error":
                print(f"[test][ERROR] {data}", file=sys.stderr)
                return 1
        print(f"[test] STT input: {transcript_in!r}")
        print(f"[test] Translation: {final_text!r}")
        print(f"[test] Usage: {usage}")
        return 0 if final_text.strip() else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mercury-url", default="ws://localhost:17890",
                    help="Mercury base URL (ws:// or wss://). /v1/realtime is appended.")
    ap.add_argument("--mercury-key", required=True, help="Mercury API key (Bearer)")
    ap.add_argument("--model", default="gpt-realtime-2", help="Realtime model name to forward")
    ap.add_argument("--audio-wav", type=Path, default=None,
                    help="Optional 24kHz mono PCM16 WAV to use for audio→text test")
    args = ap.parse_args()

    base = args.mercury_url.rstrip("/")
    url = f"{base}/v1/realtime?model={args.model}"

    if args.audio_wav:
        rc = asyncio.run(run_audio_test(url, args.mercury_key, args.model, args.audio_wav))
    else:
        rc = asyncio.run(run_text_only_test(url, args.mercury_key, args.model))
    sys.exit(rc)


if __name__ == "__main__":
    main()
