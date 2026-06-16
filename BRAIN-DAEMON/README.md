# brain-daemon

> v1.8.6 — LLM inference management daemon optimised for AMD Strix Halo (gfx1151/UMA)

A FastAPI service that wraps `llama.cpp` (and optionally vLLM / Lucebox speculative decoding) into a unified management plane: model lifecycle, OpenAI-compatible proxy, real-time thermal control, unified-memory-aware eviction, on-device quantisation pipeline, and control-vector extraction. Every subsystem is designed around the constraints of an AMD APU where the CPU and GPU share a single physical memory pool.

---

## What it is

Most inference daemons assume discrete VRAM. On AMD Strix Halo there is no discrete GPU: a 128 GB LPDDR5x pool is shared between CPU and all 40 CUs. This creates two problems that standard wrappers do not solve:

1. **Thermal coupling** — sustained GPU compute drives the same die that the CPU runs on, and the Tctl sensor is noisy (±2 °C between cores). A naive governor reacts to noise and causes frequency swings that destabilise VRM rails and trigger Vulkan `device lost`.
2. **Memory accounting** — weights spill from VRAM into RAM invisibly. An OOM killer that fires after the fact is not acceptable; the daemon must predict load feasibility before issuing the `llama-server` spawn.

brain-daemon addresses both by integrating the thermal governor and the memory controller as first-class async loops inside the same process as the inference proxy.

---

## Hardware scope

This daemon is **not portable by design**. It targets:

| Constraint | Detail |
|---|---|
| GPU | AMD Radeon 890M / 8060S (gfx1151, RDNA 3.5) |
| Memory | UMA — CPU and GPU share the same physical pool |
| Thermal | Tctl via `/sys/class/drm/card0/device/hwmon/hwmon*/temp1_input` |
| Performance mode | `/sys/class/drm/card0/device/power_dpm_force_performance_level` |
| CPU governor | `/sys/devices/system/cpu/cpufreq/policy*/scaling_max_freq` |
| Power limits | `ryzenadj` (ryzen_smu kernel module required) |
| Backend | Toolbox-containerised `llama-server` (Vulkan/ROCm) or native binaries at `/opt/` |

Running on other AMD APUs with a similar sysfs layout may work with config adjustments. Running on dGPU machines or non-AMD hardware will not: the thermal and memory modules will fail to find their sysfs paths and default to no-ops with logged warnings, but the inference proxy itself will still function.

---

## Architecture

```
HTTP :4321
    │
    ├─ /v1/*         OpenAI-compatible proxy
    │                 ├── lazy-loads model on first request
    │                 ├── per-request LoRA scale injection
    │                 └── streaming watchdog (thermal stop detection)
    │
    ├─ /mgmt/*       Model management
    │                 ├── load / unload (multi-backend dispatch)
    │                 ├── KV cache save / restore
    │                 ├── control vector cocktail assignment
    │                 └── LoRA stack management
    │
    ├─ /thermal/*    Thermal controller API
    ├─ /memory/*     Memory controller + eviction events
    ├─ /stats/*      System stats (CPU/RAM/VRAM/temps)
    ├─ /quant/*      Quantisation pipeline (async jobs + surgical preview)
    ├─ /atlas/*      Control vector extraction
    ├─ /audio/*      OmniVoice TTS (opt-in)
    ├─ /downloader/* HuggingFace model downloader
    └─ /updater/*    llama.cpp build updater (native + Lucebox)
```

### Core modules

**`daemon.py` / `manager.py` — model lifecycle**

`ModelManager` scans `models_path` recursively for GGUF files (shard-aware, skips projectors) and HuggingFace directories (completeness-checked via `model.safetensors.index.json`). Models are loaded as subprocesses: toolbox containers (`toolbox run -c <name> llama-server`), native binaries, or Lucebox speculative-decode servers. Each spawned process runs in its own process group so SIGTERM/SIGKILL can reach the entire tree.

Backend dispatch at load time:

```
backend name → (resource, backend_type)
  "vulkan"        → toolbox container, llama.cpp Vulkan/RADV
  "rocm"          → toolbox container, llama.cpp ROCm
  "native-vulkan" → /opt/llama-native/bin/llama-server
  "native-*"      → extra_native_backends from config.yaml
  "vllm-rocm"     → vLLM via toolbox
  "lucebox"       → Lucebox DFlash speculative-decode server
```

Load configs (model × backend × context × LoRA × control vectors) are persisted in `load_configs.json` and restored on daemon restart, including lazy-loading: if a model is referenced in an inference request and not yet running, it is loaded transparently from the persisted config.

**`thermal/controller.py` — continuous thermal governor**

The controller runs a 1 Hz async loop reading Tctl via sysfs hwmon. Two design choices that matter:

- **EMA smoothing (α=0.4)** on the temperature reading before applying the CPU frequency curve. Tctl oscillates ±2 °C between cores; without smoothing the linear curve 75–90 °C produces frequency swings on noise rather than signal. Raw temperature is still used for emergency checks.
- **Slew-rate cap (500 MHz/tick)** when writing `scaling_max_freq`. A single tick from 5.2 GHz to 625 MHz hammers VRM rails shared between CPU and GPU and reliably triggers Vulkan `device lost` on this platform.

Throttle curve:

| Temperature | Action |
|---|---|
| < 75 °C | Full CPU frequency (5187.5 MHz) |
| 75–90 °C | Linear reduction → 625 MHz |
| ≥ 90 °C | CPU at minimum, GPU forced to `auto` power level |
| ≥ 98 °C sustained 2 s | SIGSTOP to all llama-server instances |
| < 55 °C after SIGSTOP | SIGCONT + power ramp-up over 40 s |

GPU performance level is kept at `auto` during inference. Mode `high` bypasses power limits and pulls 200 W+, which causes thermal runaway on this TDP-constrained platform within seconds of sustained load.

**`memory/controller.py` — UMA-aware eviction**

VRAM and RAM are the same physical pool; the controller tracks both but only triggers eviction on RAM pressure (VRAM filling up is expected and correct — it means weights are paged in efficiently).

Pre-load check before every `llama-server` spawn:

```
needed = model_weights_mb + kv_cache_mb + headroom_mb
available = vram_available + ram_available   # same pool, sum is valid
if needed > available: try eviction, else reject with HTTP 507
```

Eviction candidate selection prioritises by highest RAM footprint (measured delta at load > static estimate > RSS), skips protected models and those mid-inference. KV cache can optionally be saved before eviction.

Swap auto-flush: when swap exceeds threshold for 90 s and free RAM can absorb it, the controller runs `swapoff -a && swapon -a` to reclaim pages.

**`quantize/` — surgical quantisation pipeline**

Two entry points with the same underlying library:

- **`brain-quant.py`** — standalone TUI (no daemon dependency) for interactive batch runs
- **`/quant/*` HTTP API** — integrated job queue for dashboard-driven quantisation

The "surgical" quantisation strategy assigns different precision to different tensor families based on calibration data:

```
Source: activation statistics from llama-imatrix on a calibration corpus
  ↓
Top X% tensors per family (by sum_values) → kept at higher precision (F16 or Q8_0)
MoE router tensors (ffn_gate_inp.*) → always F16 (0.1% of weight, critical for routing)
Embedding + output → always F16 (vocabulary distribution)
Attention (k/q/v/o) → Q8_0 (precision matters more than FFN)
FFN bulk → base quantisation (Q6_K, Q5_K_M, ...)
```

Alternative path when no imatrix is available: `source=cartography` uses L2-norm of the weights themselves (a proxy for activation importance derived from the GGUF file directly, no calibration corpus needed).

The pipeline is: `build-calibration.py` (dedup + filter corpus) → `llama-imatrix` → `brain-quant.py` TUI → `llama-quantize --tensor-type` per tensor. Quality eval runs automated pass/fail scoring across categories (coding, reasoning, tool_use, etc.) at temperature=0 after each variant.

**`atlas/` — control vector extraction**

Wraps `llama-extract-vector` (C++ binary from the `atomic-llama-cpp-turboquant` fork) via subprocess. Each extraction is process-isolated so a segfault or OOM in the C++ layer does not bring down the daemon. The binary computes diff-of-means over positive/negative prompt pairs and exports a GGUF control vector compatible with `llama-server --control-vector-scaled`. Extracted vectors are served back to Mercury/AtlasMind over HTTP, which manages the cocktail (multi-vector combinations with per-layer range and per-vector scale).

**`updater/` — build management**

`build-native.sh` compiles side-by-side llama.cpp builds under `/opt/llama-native-<name>/`. Each slot in `extra_native_backends` config maps a name to a binary path plus optionally a PR number or branch to track. A separate Lucebox updater handles the HIP cmake build (different repo, different flags — cannot share the same build script).

---

## Hard problems addressed

**Multi-backend coexistence**
The daemon can have multiple llama.cpp builds loaded simultaneously (master, TurboQuant fork, DFlash PR, MTP PR), each on different ports, routed by name at load time. The LoRA `id` ordering is contractual: index in the `loras` list at boot = server-side id used for per-request scale injection. Reordering the list would silently apply scales to the wrong adapters; the code raises rather than silently skipping entries.

**KV cache persistence across unloads**
`llama-server --slot-save-path` writes slot state on demand. The daemon exposes `/mgmt/kv-cache/save` and `/mgmt/kv-cache/restore`, and the memory controller can optionally save before eviction. KV state survives daemon restarts: model config including context size is persisted and the KV file is restored after the model is loaded with identical parameters.

**Control vector cocktails**
Multiple control vectors can be applied simultaneously with independent scales and a shared layer range. The daemon validates file existence at assignment time (not just at load), stores the cocktail separately from `extra_args` (so `/mgmt/status` can display it without re-parsing CLI flags), and rebuilds the CLI flags on every load (including lazy-load from persisted config).

**vLLM subprocess tree cleanup**
`vllm serve` spawns a separate engine subprocess that does not appear in the main process cmdline. A naive `pkill --port` leaves engine workers holding GPU memory. The unload cascade explicitly: finds the main PID by port, SIGTERMs its children first, then the main, then SIGKILLs `vllm.entrypoints` and `vllm.engine` stragglers.

**GGUF header parsing at scale**
Parsing a sharded 200+ GB model header from Python takes 7–8 s. The surgical builder re-fires on every slider move in the dashboard. A mtime-keyed in-process cache with FIFO eviction at 8 entries keeps live-preview latency below 100 ms after the first parse. Cartography scans (reading tensor values for weight health analysis) are additionally cached to disk, surviving daemon restarts.

---

## API overview

All endpoints return JSON. The `/v1/*` routes are OpenAI-compatible (chat completions, completions, embeddings, model list).

| Prefix | Purpose |
|---|---|
| `GET /health` | Status, version, running models, thermal level, memory pressure |
| `GET /mgmt/models` | Scan and list all GGUF/HF models with running state |
| `POST /mgmt/load` | Load a model (backend, ctx, extra_args, LoRA, control vectors) |
| `POST /mgmt/unload` | Unload a model |
| `POST /mgmt/set-preset` | Assign control vector cocktail without loading |
| `GET /mgmt/status` | Running instances with memory deltas, load order, thermal state |
| `GET /thermal/status` | Temperature, throttle %, frequency, power draw |
| `POST /thermal/start` | Enable thermal controller |
| `GET /memory/status` | RAM/VRAM pools, per-model footprint, eviction events |
| `POST /quant/jobs` | Submit quantisation/imatrix job |
| `GET /quant/jobs/{id}/stream` | NDJSON live log stream |
| `POST /quant/surgical/preview` | Generate surgical preset from imatrix or cartography |
| `POST /atlas/extract/stream` | Extract control vector (NDJSON stream) |
| `GET /stats/system` | CPU/RAM/VRAM/temps/disk |
| `GET /updater/status` | llama.cpp build versions per slot |
| `POST /updater/build` | Trigger rebuild of a native backend |

---

## Configuration

Copy `config.yaml.example` to `config.yaml` and adjust:

```yaml
models_path: ~/.lmstudio/models   # scanned recursively for GGUF and HF dirs
toolbox_name: llama-vulkan-radv   # default backend container
daemon_port: 4321
default_context: 262144
kv_cache_dir: ~/.local/share/mercury/kv-cache

thermal:
  auto_start: true
  throttle_start_c: 75
  throttle_full_c: 90
  emergency_c: 98
  resume_c: 55

memory:
  enabled: true
  ram_evict_percent: 85
  preload_headroom_gb: 4.0
```

Per-model load parameters (context size, extra args, LoRA, backend) are persisted in `load_configs.json`. Copy `load_configs.example.json` as a starting point.

---

## Running

```bash
# Install dependencies
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Copy and edit config
cp config.yaml.example config.yaml

# Run (root required for sysfs writes)
uvicorn main:app --host 0.0.0.0 --port 4321

# Or via systemd (see systemd/brain-daemon.service)
systemctl enable --now brain-daemon
```

The daemon requires root for sysfs writes (CPU frequency, GPU performance level). The inference subprocesses themselves can run as a non-root user configured via `run_as_user` in `config.yaml`.

---

## Modules

```
brain-daemon/
├── daemon.py              Main FastAPI app, proxy, management endpoints
├── manager.py             ModelManager: scan, load, unload, KV cache
├── thermal/
│   ├── controller.py      EMA thermal governor, CPU/GPU throttle, SIGSTOP/CONT
│   ├── root_client.py     sysfs writers, ryzenadj wrapper
│   └── routes.py          /thermal/* API
├── memory/
│   ├── controller.py      UMA-aware pre-load check, eviction, swap flush
│   ├── monitor.py         VRAM/RAM readers (sysfs + psutil)
│   └── routes.py          /memory/* API
├── quantize/
│   ├── brain-quant.py     Standalone TUI pipeline
│   ├── lib/
│   │   ├── surgical.py    Tensor-family surgical preset generator
│   │   ├── imatrix.py     .imatrix binary parser
│   │   ├── cartography.py Weight stats (L2-norm per tensor, health scoring)
│   │   └── ...
│   ├── manager.py         Async job queue
│   └── routes.py          /quant/* API
├── atlas/
│   ├── manager.py         AtlasManager, subprocess lifecycle, serialisation
│   ├── extractor.py       llama-extract-vector subprocess wrapper
│   └── routes.py          /atlas/* API
├── updater/
│   ├── lucebox.py         Lucebox (HIP/cmake) build updater
│   └── routes.py          /updater/* API (build-native.sh wrapper)
├── audio/                 OmniVoice TTS (opt-in, CPU-path validated)
├── downloader/            HuggingFace model download manager
├── stats/                 System stats, LM Studio / Ollama log parsers
├── templates/             Patched Qwen3 chat templates (keepthink variants)
├── config.yaml.example
├── load_configs.example.json
└── systemd/brain-daemon.service
```
