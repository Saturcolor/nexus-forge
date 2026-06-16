#!/usr/bin/env bash
# install_omnivoice.sh — Install the k2-fsa/OmniVoice package + extra deps
# into the brain-daemon venv. Run on the brain machine (ROCm).
#
# Usage :
#   sudo /opt/llamacpp-daemon/scripts/install_omnivoice.sh
#
# After install :
#   1. Edit /opt/llamacpp-daemon/config.yaml → omnivoice.enabled: true
#   2. systemctl restart brain-daemon
#   3. curl http://127.0.0.1:4321/audio/health  # expects omnivoice.loaded=true
#   4. curl -F name=your-name -F ref_audio=@me.wav -F 'ref_text=Bonjour je test'
#         http://127.0.0.1:4321/audio/profiles
#   5. curl -X POST http://127.0.0.1:4321/audio/speech \
#         -H 'Content-Type: application/json' \
#         -d '{"input":"Salut le monde","voice":"clone:your-name","language":"fr"}' \
#         --output out.wav

set -euo pipefail

DAEMON_DIR="${DAEMON_DIR:-/opt/llamacpp-daemon}"
VENV="${VENV:-$DAEMON_DIR/venv}"
PIP="$VENV/bin/pip"

OMNIVOICE_SRC="${OMNIVOICE_SRC:-/opt/omnivoice-src}"
OMNIVOICE_REPO="${OMNIVOICE_REPO:-https://github.com/k2-fsa/OmniVoice.git}"
OMNIVOICE_REF="${OMNIVOICE_REF:-main}"

if [ ! -d "$VENV" ]; then
  echo "Venv introuvable: $VENV" >&2
  echo "Lance nexusctl install brain-daemon avant ce script." >&2
  exit 1
fi

echo "[1/5] Clone/update OmniVoice source ($OMNIVOICE_REPO @ $OMNIVOICE_REF)"
if [ -d "$OMNIVOICE_SRC/.git" ]; then
  git -C "$OMNIVOICE_SRC" fetch --depth 1 origin "$OMNIVOICE_REF"
  git -C "$OMNIVOICE_SRC" checkout "$OMNIVOICE_REF"
  git -C "$OMNIVOICE_SRC" reset --hard "origin/$OMNIVOICE_REF" || true
else
  git clone --depth 1 -b "$OMNIVOICE_REF" "$OMNIVOICE_REPO" "$OMNIVOICE_SRC"
fi

echo "[2/5] Install OmniVoice (editable)"
"$PIP" install -e "$OMNIVOICE_SRC"

echo "[3/5] Install extra deps (pedalboard, transformers pinned)"
# NB: on ne pin pas torch/torchaudio à une wheel ROCm ici. Raison : le venv
# brain-daemon est partagé par Kokoro qui importe torch en interne (LSTM +
# WeightNorm), et un swap CUDA→ROCm a fait segfault Kokoro sur Strix Halo
# gfx1151 + HSA_OVERRIDE=11.0.0 le 2026-05-17. Par défaut, pip prend la
# wheel CUDA → OmniVoice tombe en CPU si pas de GPU NVIDIA. Acceptable
# tant qu'on n'a pas une combo torch ROCm validée pour gfx1151 + Kokoro.
"$PIP" install --upgrade \
  "transformers>=4.45" \
  "soundfile" \
  "pedalboard" \
  "torchaudio"

echo "[4/5] Create voices_dir"
VOICES_DIR="${VOICES_DIR:-/root/.local/share/brain-daemon/voices}"
mkdir -p "$VOICES_DIR"
echo "  voices_dir = $VOICES_DIR"

echo "[5/5] Sanity import"
"$VENV/bin/python" - <<'PY'
import sys
try:
    from omnivoice.models.omnivoice import OmniVoice
    print("OmniVoice import OK :", OmniVoice.__module__)
except Exception as e:
    print("OmniVoice import FAILED :", e, file=sys.stderr)
    sys.exit(2)
PY

echo
echo "OK. Active dans config.yaml :"
echo "    omnivoice:"
echo "      enabled: true"
echo "Puis : systemctl restart brain-daemon"
