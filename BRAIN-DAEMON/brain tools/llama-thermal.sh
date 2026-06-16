#!/usr/bin/env bash
# llama-thermal.sh — Software thermal throttle daemon for Strix Halo APU
# Comble le trou entre ryzenadj (qui ne contrôle rien) et le trip critical kernel (110°C)
#
# Lit hwmon edge temp toutes les 300ms et throttle progressivement :
#   < 75°C       → FULL     CPU max + GPU high
#   75-80°C      → GPU THR  CPU max + GPU auto (le GPU est le principal emetteur de chaleur)
#   80-88°C      → CPU+GPU  CPU réduit linéairement + GPU auto
#   > 88°C       → STOP     SIGSTOP llama-server
#   < 55°C       → RESUME   SIGCONT + cooldown 5s en mode GPU throttle
#
# Usage: sudo ./llama-thermal.sh [start|stop|status]

set -euo pipefail

# === Configuration ===
T_GPU_THROTTLE=75000  # milli°C — GPU passe en auto (le vrai levier)
T_CPU_THROTTLE=80000  # milli°C — réduction CPU en plus
T_CRIT=88000          # milli°C — SIGSTOP llama-server
T_RESUME=55000        # milli°C — SIGCONT (bas pour éviter le yo-yo)
COOLDOWN=5            # secondes minimum entre RESUME et prochain check
INTERVAL=0.3          # secondes entre chaque check (plus rapide = réaction plus fine)
PIDFILE="/run/llama-thermal.pid"
LOGFILE="/var/log/llama-thermal.log"

# === Hardware paths ===
HWMON="/sys/class/drm/card0/device/hwmon/hwmon2"
TEMP_INPUT="$HWMON/temp1_input"
POWER_INPUT="$HWMON/power1_input"
GPU_PERF="/sys/class/drm/card0/device/power_dpm_force_performance_level"
CPU_MAX_FREQ=5187500   # kHz
CPU_MIN_FREQ=625000    # kHz
CPU_POLICIES="/sys/devices/system/cpu/cpufreq/policy"

# === State ===
CURRENT_LEVEL="full"   # full, gpu_throttle, cpu_throttle, stopped
STOPPED_PID=""
LAST_RESUME_TS=0

log() {
    local msg="[$(date '+%H:%M:%S.%3N')] $*"
    echo "$msg" >> "$LOGFILE"
    echo "$msg"
}

get_temp() {
    cat "$TEMP_INPUT" 2>/dev/null || echo "0"
}

get_power() {
    # power1_input is in microwatts
    local uw
    uw=$(cat "$POWER_INPUT" 2>/dev/null || echo "0")
    echo "scale=1; $uw / 1000000" | bc
}

get_llama_pid() {
    pgrep -x llama-server | head -1 || echo ""
}

set_cpu_max_freq() {
    local freq=$1
    for p in /sys/devices/system/cpu/cpufreq/policy*/scaling_max_freq; do
        echo "$freq" > "$p" 2>/dev/null || true
    done
}

set_gpu_level() {
    echo "$1" > "$GPU_PERF" 2>/dev/null || true
}

now_ts() {
    date +%s
}

do_full() {
    if [ "$CURRENT_LEVEL" != "full" ]; then
        log "FULL PERF — temp OK → CPU=${CPU_MAX_FREQ}kHz GPU=high"
        set_cpu_max_freq "$CPU_MAX_FREQ"
        set_gpu_level "high"
        CURRENT_LEVEL="full"
    fi
}

do_gpu_throttle() {
    local temp=$1
    local temp_c=$((temp / 1000))
    if [ "$CURRENT_LEVEL" != "gpu_throttle" ]; then
        log "GPU THROTTLE — ${temp_c}°C → CPU=${CPU_MAX_FREQ}kHz GPU=auto"
    fi
    set_cpu_max_freq "$CPU_MAX_FREQ"
    set_gpu_level "auto"
    CURRENT_LEVEL="gpu_throttle"
}

do_cpu_throttle() {
    local temp=$1
    # Interpolation linéaire : T_CPU_THROTTLE → CPU_MAX, T_CRIT → CPU_MIN
    local range=$((T_CRIT - T_CPU_THROTTLE))
    local over=$((temp - T_CPU_THROTTLE))
    local freq_range=$((CPU_MAX_FREQ - CPU_MIN_FREQ))
    local reduction=$((freq_range * over / range))
    local target=$((CPU_MAX_FREQ - reduction))
    # Clamp
    if [ "$target" -lt "$CPU_MIN_FREQ" ]; then target=$CPU_MIN_FREQ; fi
    if [ "$target" -gt "$CPU_MAX_FREQ" ]; then target=$CPU_MAX_FREQ; fi
    # Round to nearest 100MHz
    target=$(( (target / 100000) * 100000 ))
    if [ "$target" -lt "$CPU_MIN_FREQ" ]; then target=$CPU_MIN_FREQ; fi

    local temp_c=$((temp / 1000))
    if [ "$CURRENT_LEVEL" != "cpu_throttle" ]; then
        log "CPU+GPU THROTTLE — ${temp_c}°C → CPU=${target}kHz GPU=auto"
    fi
    set_cpu_max_freq "$target"
    set_gpu_level "auto"
    CURRENT_LEVEL="cpu_throttle"
}

do_stop() {
    local temp=$1
    local temp_c=$((temp / 1000))
    local pid
    pid=$(get_llama_pid)
    if [ -n "$pid" ] && [ "$CURRENT_LEVEL" != "stopped" ]; then
        log "EMERGENCY STOP — ${temp_c}°C → SIGSTOP llama-server (pid $pid)"
        kill -STOP "$pid" 2>/dev/null || true
        STOPPED_PID="$pid"
        set_cpu_max_freq "$CPU_MIN_FREQ"
        set_gpu_level "auto"
        CURRENT_LEVEL="stopped"
    fi
}

do_resume() {
    if [ "$CURRENT_LEVEL" = "stopped" ] && [ -n "$STOPPED_PID" ]; then
        local temp_c=$(( $(get_temp) / 1000 ))
        log "RESUME — ${temp_c}°C → SIGCONT llama-server (pid $STOPPED_PID), cooldown ${COOLDOWN}s"
        kill -CONT "$STOPPED_PID" 2>/dev/null || true
        STOPPED_PID=""
        LAST_RESUME_TS=$(now_ts)
        # Resume into gpu_throttle, NOT full — let it prove it's cool enough
        set_gpu_level "auto"
        set_cpu_max_freq "$CPU_MAX_FREQ"
        CURRENT_LEVEL="gpu_throttle"
    fi
}

cleanup() {
    log "Shutting down — restoring full perf"
    set_cpu_max_freq "$CPU_MAX_FREQ"
    set_gpu_level "high"
    if [ -n "$STOPPED_PID" ]; then
        kill -CONT "$STOPPED_PID" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
    exit 0
}

status() {
    local temp temp_c power
    temp=$(get_temp)
    temp_c=$((temp / 1000))
    power=$(get_power)
    local cur_freq
    cur_freq=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq 2>/dev/null)
    local gpu_level
    gpu_level=$(cat "$GPU_PERF" 2>/dev/null)
    local pid
    pid=$(get_llama_pid)
    local pid_state="n/a"
    if [ -n "$pid" ]; then
        pid_state=$(cat /proc/"$pid"/status 2>/dev/null | grep "^State:" | awk '{print $2, $3}')
    fi

    echo "=== llama-thermal status ==="
    echo "  Temperature:     ${temp_c}°C"
    echo "  Power (GPU):     ${power}W"
    echo "  CPU max freq:    ${cur_freq}kHz"
    echo "  GPU perf level:  ${gpu_level}"
    echo "  llama-server:    pid=${pid:-none} state=${pid_state}"
    echo "  Thresholds:      GPU<$((T_GPU_THROTTLE/1000))°C  CPU<$((T_CPU_THROTTLE/1000))°C  CRIT<$((T_CRIT/1000))°C  RESUME<$((T_RESUME/1000))°C"
    if [ -f "$PIDFILE" ]; then
        echo "  Daemon:          running (pid $(cat $PIDFILE))"
    else
        echo "  Daemon:          not running"
    fi
    echo ""
    if [ -f "$LOGFILE" ]; then
        echo "=== Last 10 log entries ==="
        tail -10 "$LOGFILE"
    fi
}

run_daemon() {
    if [ "$EUID" -ne 0 ]; then
        echo "Requires root. Relaunching with sudo..."
        exec sudo "$0" start
    fi

    # Check not already running
    if [ -f "$PIDFILE" ]; then
        local oldpid
        oldpid=$(cat "$PIDFILE")
        if kill -0 "$oldpid" 2>/dev/null; then
            echo "Already running (pid $oldpid). Use 'stop' first."
            exit 1
        fi
        rm -f "$PIDFILE"
    fi

    # Verify hwmon exists
    if [ ! -f "$TEMP_INPUT" ]; then
        echo "ERROR: $TEMP_INPUT not found. Check HWMON path."
        exit 1
    fi

    echo $$ > "$PIDFILE"
    trap cleanup EXIT INT TERM

    log "=== llama-thermal daemon started (pid $$) ==="
    log "Thresholds: GPU_THR<$((T_GPU_THROTTLE/1000))°C CPU_THR<$((T_CPU_THROTTLE/1000))°C CRIT<$((T_CRIT/1000))°C RESUME<$((T_RESUME/1000))°C"

    while true; do
        local temp
        temp=$(get_temp)
        local now
        now=$(now_ts)

        if [ "$CURRENT_LEVEL" = "stopped" ]; then
            # In emergency stop — wait for temp AND cooldown period
            if [ "$temp" -lt "$T_RESUME" ]; then
                do_resume
            fi
        elif [ $((now - LAST_RESUME_TS)) -lt "$COOLDOWN" ]; then
            # In cooldown after resume — stay in gpu_throttle, don't go full
            if [ "$temp" -ge "$T_CRIT" ]; then
                do_stop "$temp"
            fi
        elif [ "$temp" -ge "$T_CRIT" ]; then
            do_stop "$temp"
        elif [ "$temp" -ge "$T_CPU_THROTTLE" ]; then
            do_cpu_throttle "$temp"
        elif [ "$temp" -ge "$T_GPU_THROTTLE" ]; then
            do_gpu_throttle "$temp"
        else
            do_full
        fi

        sleep "$INTERVAL"
    done
}

stop_daemon() {
    if [ -f "$PIDFILE" ]; then
        local pid
        pid=$(cat "$PIDFILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "Stopping daemon (pid $pid)..."
            kill "$pid"
            sleep 1
            echo "Stopped."
        else
            echo "Stale pidfile, removing."
            rm -f "$PIDFILE"
        fi
    else
        echo "Not running."
    fi
}

case "${1:-status}" in
    start)
        run_daemon
        ;;
    stop)
        stop_daemon
        ;;
    status)
        status
        ;;
    *)
        echo "Usage: $0 [start|stop|status]"
        exit 1
        ;;
esac
