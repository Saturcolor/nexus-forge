#!/usr/bin/env bash
set -euo pipefail
PREFIX=/opt/llama-native-turboquant
SRC=/opt/atomic-llama-cpp-turboquant

echo "[1/4] Installing binaries to $PREFIX"
cmake --install /tmp/atomic-llama-build --prefix "$PREFIX" --config Release > /tmp/install-turboquant.log 2>&1
echo "  $(grep -c '^-- Installing:' /tmp/install-turboquant.log) files installed"

echo "[2/4] Installing MTP assistant"
mkdir -p "$PREFIX/share/assistants"
cp /tmp/mtp-assistant/gemma-4-31B-it-assistant.Q4_K_M.gguf "$PREFIX/share/assistants/"

echo "[3/4] Writing BUILD_INFO"
{
  echo "build_date=$(date -Iseconds)"
  echo "fork=AtomicBot-ai/atomic-llama-cpp-turboquant"
  echo "src_dir=$SRC"
  echo "install_prefix=$PREFIX"
  echo "commit=$(git -c safe.directory=$SRC -C $SRC rev-parse HEAD)"
  echo "commit_short=$(git -c safe.directory=$SRC -C $SRC rev-parse --short HEAD)"
  echo "host=$(hostname)"
  echo "vulkan_driver=$(vulkaninfo --summary 2>/dev/null | grep driverName | head -1 | awk '{print $NF}')"
} > "$PREFIX/BUILD_INFO"

echo "[4/4] Verifying"
"$PREFIX/bin/llama-server" --version 2>&1 | head -2
echo "Assistant: $(ls -lh $PREFIX/share/assistants/*.gguf | awk '{print $5, $NF}')"
echo "RPATH: $(readelf -d $PREFIX/bin/llama-server | grep -E 'RPATH|RUNPATH')"
echo
echo "OK — registered binary: $PREFIX/bin/llama-server"
