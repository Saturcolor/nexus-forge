#!/usr/bin/env bash
# build-native.sh — Build llama.cpp natively with Vulkan (RADV) on the host
# Usage:
#   ./build-native.sh                              # clone + build latest master → /opt/llama-native
#   ./build-native.sh --commit abc123              # pin to a specific commit
#   ./build-native.sh --update                     # git pull + rebuild existing clone
#   ./build-native.sh --branch <name>              # checkout a specific branch
#   ./build-native.sh --pr 22105                   # fetch PR #22105 head and build (sets BRANCH=pr-22105)
#   ./build-native.sh --prefix /opt/llama-native-X # install to a custom prefix (parallel slot)
#   ./build-native.sh --src-dir /path/to/src       # use an existing source tree (skip clone/fetch)
#   ./build-native.sh --repo https://github.com/user/llama.cpp.git  # override clone URL (forks)
#
# Multiple slots can coexist by passing different --prefix values, allowing
# brain-daemon to switch between a stable master build and one or more PR-branch
# builds (DFlash, MTP, etc.) without rebuilding.
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
INSTALL_PREFIX="/opt/llama-native"
SRC_DIR=""           # default derived from INSTALL_PREFIX after parse
BUILD_DIR=""         # derived from SRC_DIR after parse
REPO="https://github.com/ggerganov/llama.cpp.git"
BRANCH="master"
COMMIT=""
PR=""
UPDATE=false
NO_RPC=false
JOBS="$(nproc)"
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)/brain tools/amd-strix-halo-toolboxes/toolboxes"

# ── Parse args ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --commit)   COMMIT="$2";          shift 2 ;;
        --branch)   BRANCH="$2";          shift 2 ;;
        --pr)       PR="$2";              shift 2 ;;
        --prefix)   INSTALL_PREFIX="$2";  shift 2 ;;
        --src-dir)  SRC_DIR="$2";         shift 2 ;;
        --repo)     REPO="$2";            shift 2 ;;
        --update)   UPDATE=true;          shift   ;;
        --no-rpc)   NO_RPC=true;          shift   ;;
        --jobs|-j)  JOBS="$2";            shift 2 ;;
        --help|-h)
            sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# Derive paths from prefix unless --src-dir was given
if [[ -z "$SRC_DIR" ]]; then
    SRC_DIR="${INSTALL_PREFIX}/src/llama.cpp"
fi
BUILD_DIR="${SRC_DIR}/build"

# --pr implies a PR-head branch name (used for clone-time branch + fetch)
if [[ -n "$PR" ]]; then
    BRANCH="pr-${PR}"
fi

# ── Colors ───────────────────────────────────────────────────────────────────
_info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
_ok()    { printf '\033[1;32m[OK]\033[0m    %s\n' "$*"; }
_err()   { printf '\033[1;31m[ERR]\033[0m   %s\n' "$*" >&2; }

# ── Step 1: Install build dependencies ───────────────────────────────────────
install_deps() {
    local missing=()
    local required_pkgs=(
        git make gcc gcc-c++ cmake ninja-build lld
        vulkan-loader-devel vulkan-headers
        glslc
        spirv-headers-devel spirv-tools-devel
        libcurl-devel
    )

    for pkg in "${required_pkgs[@]}"; do
        if ! rpm -q "$pkg" &>/dev/null; then
            missing+=("$pkg")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        _info "Installing missing packages: ${missing[*]}"
        sudo dnf install -y --setopt=install_weak_deps=False "${missing[@]}"
    else
        _info "All build dependencies already installed"
    fi
}

# ── Step 2: Clone or update source ───────────────────────────────────────────
# PR branches (--pr N): the PR head ref `pull/N/head` is not a regular remote
# branch, so we clone master first and then fetch the PR head into a local
# branch named `pr-N`. Plain --branch values are checked out directly.
prepare_source() {
    if [[ "$UPDATE" == true ]] && [[ -d "$SRC_DIR/.git" ]]; then
        _info "Updating existing clone in $SRC_DIR"
        cd "$SRC_DIR"
        git fetch origin
        if [[ -n "$PR" ]]; then
            _info "Fetching PR #$PR head into local branch $BRANCH"
            git fetch origin "pull/${PR}/head:${BRANCH}" --force
            git checkout "$BRANCH"
            git reset --hard "FETCH_HEAD"
        else
            git checkout "$BRANCH"
            git reset --hard "origin/$BRANCH"
        fi
        git submodule update --init --recursive
    else
        if [[ -d "$SRC_DIR/.git" ]]; then
            _info "Source already exists at $SRC_DIR — use --update to refresh"
            cd "$SRC_DIR"
        else
            mkdir -p "$(dirname "$SRC_DIR")"
            if [[ -n "$PR" ]]; then
                _info "Cloning llama.cpp (master) into $SRC_DIR before fetching PR #$PR"
                git clone --recursive "$REPO" "$SRC_DIR"
                cd "$SRC_DIR"
                _info "Fetching PR #$PR head into local branch $BRANCH"
                git fetch origin "pull/${PR}/head:${BRANCH}"
                git checkout "$BRANCH"
                git submodule update --init --recursive
            else
                _info "Cloning llama.cpp ($BRANCH) into $SRC_DIR"
                git clone -b "$BRANCH" --single-branch --recursive "$REPO" "$SRC_DIR"
                cd "$SRC_DIR"
            fi
        fi
    fi

    if [[ -n "$COMMIT" ]]; then
        _info "Checking out commit $COMMIT"
        git checkout "$COMMIT"
        git submodule update --init --recursive
    fi

    # Apply grammar patch (idempotent — check before applying)
    local patch_file="${PATCH_DIR}/llama-grammar.patch"
    if [[ -f "$patch_file" ]]; then
        if grep -q 'MAX_REPETITION_THRESHOLD 2000' src/llama-grammar.cpp 2>/dev/null; then
            _info "Applying llama-grammar.patch"
            patch -p1 < "$patch_file"
        else
            _info "Grammar patch already applied or not needed, skipping"
        fi
    fi
}

# ── Step 3: Ensure SPIRV headers are available ───────────────────────────────
check_spirv() {
    local vendored="ggml/src/ggml-vulkan/vulkan-shaders/vendor/SPIRV-Headers/include/spirv/unified1/spirv.hpp"
    local system="/usr/include/spirv/unified1/spirv.hpp"

    if [[ -f "$vendored" ]] || [[ -f "$system" ]]; then
        _info "SPIRV headers found"
        return
    fi

    _info "SPIRV headers missing — cloning manually"
    local tmp="/tmp/spirv-headers-$$"
    git clone --depth 1 https://github.com/KhronosGroup/SPIRV-Headers.git "$tmp"
    sudo mkdir -p /usr/local/include/spirv/unified1
    sudo cp "$tmp"/include/spirv/unified1/* /usr/local/include/spirv/unified1/
    rm -rf "$tmp"
    _ok "SPIRV headers installed to /usr/local/include"
}

# ── Step 4: Build ────────────────────────────────────────────────────────────
build() {
    _info "Configuring CMake (Vulkan ON, Release)"

    # RPATH is critical when several slots coexist (master + PR builds). Without it
    # CMake's install step strips RPATH and the binary relies on /etc/ld.so.conf.d/*
    # ordering to find libllama.so.0. With multiple slots that have the SAME SONAME
    # but DIFFERENT ABIs (e.g. master 9043 vs dflash 8942), the wrong lib wins and
    # the binary segfaults. Baking INSTALL_RPATH into each binary makes every slot
    # self-contained: /opt/llama-native-X/bin/llama-server only loads from
    # /opt/llama-native-X/lib(64)/, regardless of system ldconfig state.
    local rpc_flag="-DGGML_RPC=ON"
    [[ "$NO_RPC" == true ]] && rpc_flag="-DGGML_RPC=OFF"

    cmake -S "$SRC_DIR" -B "$BUILD_DIR" -G Ninja \
        -DGGML_VULKAN=ON \
        -DCMAKE_BUILD_TYPE=Release \
        "$rpc_flag" \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_PREFIX" \
        -DCMAKE_INSTALL_RPATH="${INSTALL_PREFIX}/lib;${INSTALL_PREFIX}/lib64" \
        -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
        -DCMAKE_INSTALL_RPATH_USE_LINK_PATH=OFF \
        -DLLAMA_BUILD_TESTS=OFF \
        -DLLAMA_BUILD_EXAMPLES=ON \
        -DLLAMA_BUILD_SERVER=ON

    _info "Building with $JOBS threads"
    cmake --build "$BUILD_DIR" --config Release -j "$JOBS"

    _info "Installing to $INSTALL_PREFIX"
    sudo cmake --install "$BUILD_DIR" --config Release

    # Ensure shared libs are findable. Use a per-prefix conf file so that
    # multiple slots (master + PR builds) coexist without overwriting each other.
    local prefix_slug
    prefix_slug="$(basename "$INSTALL_PREFIX")"   # e.g. llama-native or llama-native-dflash
    local ld_conf="/etc/ld.so.conf.d/${prefix_slug}.conf"
    sudo bash -c "echo '${INSTALL_PREFIX}/lib' > '$ld_conf'"
    sudo bash -c "echo '${INSTALL_PREFIX}/lib64' >> '$ld_conf'"
    sudo ldconfig
}

# ── Step 5: Verify ──────────────────────────────────────────────────────────
verify() {
    local server="${INSTALL_PREFIX}/bin/llama-server"
    if [[ ! -x "$server" ]]; then
        _err "llama-server not found at $server"
        exit 1
    fi

    _ok "llama-server installed: $server"
    "$server" --version 2>&1 || true

    # Quick Vulkan check
    _info "Checking Vulkan device visibility"
    if vulkaninfo --summary 2>&1 | grep -q "PHYSICAL_DEVICE_TYPE"; then
        _ok "Vulkan device accessible"
    else
        _err "No Vulkan device detected — check drivers"
        exit 1
    fi

    # Log build info
    local build_info="${INSTALL_PREFIX}/BUILD_INFO"
    {
        echo "build_date=$(date -Iseconds)"
        echo "branch=$BRANCH"
        if [[ -n "$PR" ]]; then
            echo "pr=$PR"
        fi
        echo "install_prefix=$INSTALL_PREFIX"
        echo "src_dir=$SRC_DIR"
        echo "commit=$(cd "$SRC_DIR" && git rev-parse HEAD)"
        echo "commit_short=$(cd "$SRC_DIR" && git rev-parse --short HEAD)"
        echo "commit_date=$(cd "$SRC_DIR" && git log -1 --format=%ci)"
        echo "host=$(hostname)"
        echo "kernel=$(uname -r)"
        echo "vulkan_driver=$(vulkaninfo --summary 2>&1 | grep driverName | head -1 | awk '{print $NF}')"
    } | sudo tee "$build_info" > /dev/null
    _ok "Build info saved to $build_info"
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
    _info "=== llama.cpp native Vulkan build ==="
    _info "Install prefix: $INSTALL_PREFIX"
    _info "Source dir:     $SRC_DIR"
    if [[ -n "$PR" ]]; then
        _info "PR ref:         #${PR} (local branch: $BRANCH)"
    else
        _info "Branch:         $BRANCH"
    fi
    [[ -n "$COMMIT" ]] && _info "Commit pin:     $COMMIT"

    install_deps
    prepare_source
    check_spirv
    build
    verify

    echo ""
    _ok "Build complete!"
    _ok "Binary: ${INSTALL_PREFIX}/bin/llama-server"
    _ok "Usage:  ${INSTALL_PREFIX}/bin/llama-server -m <model.gguf> -c 8192 --host 127.0.0.1 --port 8080"
}

main
