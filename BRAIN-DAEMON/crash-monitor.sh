#!/usr/bin/env bash
# crash-monitor.sh — Log système haute fréquence pour diagnostiquer un thermal crash
# Usage: sudo ./crash-monitor.sh [interval_sec]
# Les données sont flushées à chaque ligne → survivent à un power-off brutal
#
# Enrichi pour le brain-daemon : log thermal controller state, GPU power,
# ryzenadj limits vs values, scaling_max_freq, process state

set -euo pipefail

INTERVAL="${1:-0.5}"
LOGFILE="${LOGFILE_DIR:-/tmp}/crash-monitor-$(date +%Y%m%d_%H%M%S).csv"
# LOGFILE_DIR : optional env var to redirect logs (default: /tmp)
GPU_SCLK="/sys/class/drm/card0/device/pp_dpm_sclk"
GPU_MCLK="/sys/class/drm/card0/device/pp_dpm_mclk"
GPU_BUSY="/sys/class/drm/card0/device/gpu_busy_percent"
GPU_VRAM_USED="/sys/class/drm/card0/device/mem_info_vram_used"
GPU_POWER_LEVEL="/sys/class/drm/card0/device/power_dpm_force_performance_level"
HWMON=$(ls -d /sys/class/drm/card0/device/hwmon/hwmon* 2>/dev/null | head -1)
BRAIN_DAEMON_URL="http://localhost:4321"
THERMAL_ACTIONS_LOG="/tmp/brain-thermal-actions.log"
LAST_ACTION_LINE=0

if [ "$EUID" -ne 0 ]; then
    echo "Requires root (ryzenadj). Relaunching with sudo..."
    exec sudo "$0" "$@"
fi

echo "[crash-monitor] Logging to: $LOGFILE"
echo "[crash-monitor] Interval: ${INTERVAL}s — Ctrl+C to stop"
echo ""

# Header
HEADER="timestamp,uptime_sec"
# ryzenadj values
HEADER+=",stapm_val_w,stapm_lim_w,ppt_fast_val_w,ppt_fast_lim_w,ppt_slow_val_w,ppt_slow_lim_w,ppt_apu_val_w,ppt_apu_lim_w"
# temperatures ryzenadj
HEADER+=",tctl_val_c,tctl_lim_c,stt_apu_c,stt_dgpu_c"
# hwmon temps
if [ -n "$HWMON" ]; then
    HEADER+=",hwmon_edge_c,hwmon_junction_c,hwmon_mem_c"
    # GPU power (watts)
    if [ -f "$HWMON/power1_input" ]; then
        HEADER+=",gpu_power_w"
    fi
fi
# GPU
HEADER+=",gpu_sclk_mhz,gpu_mclk_mhz,gpu_busy_pct,gpu_vram_used_mb,gpu_perf_level"
# CPU
HEADER+=",cpu_avg_mhz,cpu_max_mhz,cpu_scaling_max_mhz,cpu_governor"
# Memory
HEADER+=",mem_used_mb,mem_available_mb,swap_used_mb"
# llama-server process
HEADER+=",llama_pid,llama_state,llama_rss_mb,llama_cpu_pct"
# brain-daemon thermal
HEADER+=",thermal_level,thermal_throttle_pct,thermal_emergency"
HEADER+=",thermal_last_action"
echo "$HEADER" | tee "$LOGFILE"

# Parse ryzenadj -i output — extract value+limit for a given name
parse_radj_val() {
    # ryzenadj -i format: "| NAME | VALUE | LIMIT |"
    # $2=name, $3=value, $4=limit — value est un float
    echo "$1" | awk -F'|' -v name="$2" '$2 ~ name {gsub(/[[:space:]]/, "", $3); if ($3 ~ /^[0-9.]/) print $3; else print "0"}'
}
parse_radj_lim() {
    echo "$1" | awk -F'|' -v name="$2" '$2 ~ name {gsub(/[[:space:]]/, "", $4); if ($4 ~ /^[0-9.]/) print $4; else print "0"}'
}

get_active_clock() {
    grep '\*' "$1" 2>/dev/null | grep -oP '\d+(?=Mhz)' | head -1 || echo "0"
}

# Quick curl with timeout — returns empty on fail
brain_thermal() {
    curl -sf --max-time 1 "$BRAIN_DAEMON_URL/thermal/status" 2>/dev/null || echo ""
}

echo "[crash-monitor] Monitoring started — waiting for data..."

while true; do
    TS=$(date '+%Y-%m-%d %H:%M:%S.%3N')
    UPTIME=$(awk '{print $1}' /proc/uptime)

    # ryzenadj
    RADJ=$(ryzenadj -i 2>/dev/null || echo "")
    STAPM_VAL=$(parse_radj_val "$RADJ" "STAPM VALUE")
    STAPM_LIM=$(parse_radj_lim "$RADJ" "STAPM LIMIT")
    PPT_FAST_VAL=$(parse_radj_val "$RADJ" "PPT VALUE FAST")
    PPT_FAST_LIM=$(parse_radj_lim "$RADJ" "PPT LIMIT FAST")
    PPT_SLOW_VAL=$(parse_radj_val "$RADJ" "PPT VALUE SLOW")
    PPT_SLOW_LIM=$(parse_radj_lim "$RADJ" "PPT LIMIT SLOW")
    PPT_APU_VAL=$(parse_radj_val "$RADJ" "PPT VALUE APU")
    PPT_APU_LIM=$(parse_radj_lim "$RADJ" "PPT LIMIT APU")
    TCTL_VAL=$(parse_radj_val "$RADJ" "THM VALUE CORE")
    TCTL_LIM=$(parse_radj_lim "$RADJ" "THM LIMIT CORE")
    STT_APU=$(parse_radj_val "$RADJ" "STT VALUE APU")
    STT_DGPU=$(parse_radj_val "$RADJ" "STT VALUE dGPU")

    # hwmon temps + GPU power
    HWMON_EXTRA=""
    if [ -n "$HWMON" ]; then
        T_EDGE=$(awk '{printf "%.1f", $1/1000}' "$HWMON/temp1_input" 2>/dev/null || echo "0")
        T_JUNC=$(awk '{printf "%.1f", $1/1000}' "$HWMON/temp2_input" 2>/dev/null || echo "0")
        T_MEM=$(awk '{printf "%.1f", $1/1000}' "$HWMON/temp3_input" 2>/dev/null || echo "0")
        HWMON_EXTRA=",$T_EDGE,$T_JUNC,$T_MEM"
        if [ -f "$HWMON/power1_input" ]; then
            GPU_POWER=$(awk '{printf "%.1f", $1/1000000}' "$HWMON/power1_input" 2>/dev/null || echo "0")
            HWMON_EXTRA+=",$GPU_POWER"
        fi
    fi

    # GPU
    GPU_SCLK_VAL=$(get_active_clock "$GPU_SCLK")
    GPU_MCLK_VAL=$(get_active_clock "$GPU_MCLK")
    GPU_BUSY_VAL=$(cat "$GPU_BUSY" 2>/dev/null || echo "0")
    GPU_VRAM_VAL=$(awk '{printf "%.0f", $1/1048576}' "$GPU_VRAM_USED" 2>/dev/null || echo "0")
    GPU_PLEVEL=$(cat "$GPU_POWER_LEVEL" 2>/dev/null || echo "?")

    # CPU freqs
    CPU_FREQS=$(cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq 2>/dev/null)
    CPU_AVG=$(echo "$CPU_FREQS" | awk '{s+=$1; n++} END {printf "%.0f", s/n/1000}')
    CPU_MAX=$(echo "$CPU_FREQS" | sort -n | tail -1 | awk '{printf "%.0f", $1/1000}')
    # scaling_max_freq = ce que le thermal controller écrit
    CPU_SCALING_MAX=$(awk '{printf "%.0f", $1/1000}' /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq 2>/dev/null || echo "0")
    CPU_GOV=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo "?")

    # Memory
    MEM_INFO=$(cat /proc/meminfo)
    MEM_TOTAL=$(echo "$MEM_INFO" | awk '/^MemTotal/ {print $2}')
    MEM_AVAIL=$(echo "$MEM_INFO" | awk '/^MemAvailable/ {print $2}')
    MEM_USED=$(( (MEM_TOTAL - MEM_AVAIL) / 1024 ))
    MEM_AVAIL_MB=$(( MEM_AVAIL / 1024 ))
    SWAP_TOTAL=$(echo "$MEM_INFO" | awk '/^SwapTotal/ {print $2}')
    SWAP_FREE=$(echo "$MEM_INFO" | awk '/^SwapFree/ {print $2}')
    SWAP_USED=$(( (SWAP_TOTAL - SWAP_FREE) / 1024 ))

    # llama-server process (cherche dans le container via host /proc)
    LLAMA_PID=$(pgrep -f "llama-server.*--port" | head -1 || echo "")
    if [ -n "$LLAMA_PID" ]; then
        LLAMA_STATE=$(cat /proc/"$LLAMA_PID"/status 2>/dev/null | awk '/^State:/ {print $2}' || echo "?")
        LLAMA_STAT=$(ps -p "$LLAMA_PID" -o rss=,pcpu= 2>/dev/null || echo "0 0")
        LLAMA_RSS=$(echo "$LLAMA_STAT" | awk '{printf "%.0f", $1/1024}')
        LLAMA_CPU=$(echo "$LLAMA_STAT" | awk '{print $2}')
    else
        LLAMA_PID="none"
        LLAMA_STATE="-"
        LLAMA_RSS="0"
        LLAMA_CPU="0"
    fi

    # Brain daemon thermal status (non-blocking, 1s timeout)
    THERMAL_JSON=$(brain_thermal)
    if [ -n "$THERMAL_JSON" ]; then
        THERMAL_LEVEL=$(echo "$THERMAL_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('level','?'))" 2>/dev/null || echo "?")
        THERMAL_PCT=$(echo "$THERMAL_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('throttle_pct','?'))" 2>/dev/null || echo "?")
        THERMAL_EMERG=$(echo "$THERMAL_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('emergency',False))" 2>/dev/null || echo "?")
    else
        THERMAL_LEVEL="unreachable"
        THERMAL_PCT="?"
        THERMAL_EMERG="?"
    fi

    LINE="$TS,$UPTIME"
    LINE+=",$STAPM_VAL,$STAPM_LIM,$PPT_FAST_VAL,$PPT_FAST_LIM,$PPT_SLOW_VAL,$PPT_SLOW_LIM,$PPT_APU_VAL,$PPT_APU_LIM"
    LINE+=",$TCTL_VAL,$TCTL_LIM,$STT_APU,$STT_DGPU"
    LINE+="$HWMON_EXTRA"
    LINE+=",$GPU_SCLK_VAL,$GPU_MCLK_VAL,$GPU_BUSY_VAL,$GPU_VRAM_VAL,$GPU_PLEVEL"
    LINE+=",$CPU_AVG,$CPU_MAX,$CPU_SCALING_MAX,$CPU_GOV"
    LINE+=",$MEM_USED,$MEM_AVAIL_MB,$SWAP_USED"
    LINE+=",$LLAMA_PID,$LLAMA_STATE,$LLAMA_RSS,$LLAMA_CPU"
    # Dernières actions du thermal controller depuis le fichier d'actions
    THERMAL_ACTIONS=""
    if [ -f "$THERMAL_ACTIONS_LOG" ]; then
        TOTAL_LINES=$(wc -l < "$THERMAL_ACTIONS_LOG")
        if [ "$TOTAL_LINES" -gt "$LAST_ACTION_LINE" ]; then
            # Lire les nouvelles lignes depuis la derniere lecture
            NEW_ACTIONS=$(tail -n +$((LAST_ACTION_LINE + 1)) "$THERMAL_ACTIONS_LOG" | grep -v "^#" | tr '\n' ';' | sed 's/;$//')
            LAST_ACTION_LINE=$TOTAL_LINES
            THERMAL_ACTIONS="$NEW_ACTIONS"
        fi
    fi

    LINE+=",$THERMAL_LEVEL,$THERMAL_PCT,$THERMAL_EMERG"
    LINE+=",\"$THERMAL_ACTIONS\""

    # CRITICAL: flush immédiat sur disque — pas de buffer
    echo "$LINE" | tee -a "$LOGFILE"
    sync "$LOGFILE"

    sleep "$INTERVAL"
done
