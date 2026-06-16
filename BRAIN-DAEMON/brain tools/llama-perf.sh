#!/usr/bin/env bash
# llama-perf.sh — bascule perf/eco pour llama.cpp sur Ryzen AI Max+ 395
# Usage: llama-perf.sh [on|off|status]

set -euo pipefail

MODE="${1:-on}"

GPU_POWER_FILE="/sys/class/drm/card0/device/power_dpm_force_performance_level"
CPU_POLICIES=$(ls -d /sys/devices/system/cpu/cpufreq/policy* 2>/dev/null)

# Limites thermiques/puissance pour le NucBox EVO-X2
# BIOS par défaut : fast=120W, slow=85W, tctl=98°C
# On monte les limites power pour ne pas brider l'inférence.
# La protection thermique (tctl=90°C) reste le vrai garde-fou.
# À 85W le système était power-throttled avec 34°C de marge thermique.
RYZENADJ_STAPM=120000  # 120W STAPM (soutenu — était bridé à 85W)
RYZENADJ_SLOW=120000   # 120W PPT slow (= fast, plus de bottleneck power)
RYZENADJ_FAST=140000   # 140W PPT fast (burst court)
RYZENADJ_TCTL=90       # throttle à 90°C — le vrai garde-fou
RYZENADJ_APU_SLOW=120000  # 120W APU (GPU intégré, était à 70W par défaut)

status() {
    echo "=== CPU governor ==="
    for p in $CPU_POLICIES; do
        echo "  $(basename $p): $(cat $p/scaling_governor)"
    done | sort -u

    echo "=== GPU power level ==="
    echo "  $(cat $GPU_POWER_FILE)"

    echo "=== GPU clock states ==="
    cat /sys/class/drm/card0/device/pp_dpm_sclk 2>/dev/null | sed 's/^/  /'

    echo "=== Kernel memory ==="
    echo "  vm.swappiness       = $(cat /proc/sys/vm/swappiness)"
    echo "  vm.dirty_ratio      = $(cat /proc/sys/vm/dirty_ratio)"
    echo "  HugePages_Total     = $(grep HugePages_Total /proc/meminfo | awk '{print $2}')"
    echo "  THP                 = $(cat /sys/kernel/mm/transparent_hugepage/enabled)"

    echo "=== APU power limits (ryzenadj) ==="
    if command -v ryzenadj &>/dev/null; then
        ryzenadj -i 2>/dev/null | grep -E "(STAPM LIMIT|PPT LIMIT|THM LIMIT CORE)" | sed 's/^/  /'
    else
        echo "  ryzenadj non disponible"
    fi
}

perf_on() {
    echo "[llama-perf] Passage en mode PERFORMANCE"

    # CPU : performance sur tous les cœurs
    for p in $CPU_POLICIES; do
        echo performance > "$p/scaling_governor"
    done
    echo "  CPU governor → performance"

    # GPU : forcer les clocks max via "high"
    # Sur gfx1151 (RDNA 3.5), l'écriture directe de pp_dpm_sclk n'est plus supportée.
    # "high" force SCLK/MCLK au max. La protection thermique (tctl via ryzenadj) reste active.
    echo high > "$GPU_POWER_FILE"
    echo "  GPU power level → high (clocks max, protection thermique active via ryzenadj)"

    # APU power limits : on déverrouille le power budget, le tctl (90°C) protège le hardware
    if command -v ryzenadj &>/dev/null; then
        ryzenadj \
            --stapm-limit=${RYZENADJ_STAPM} \
            --slow-limit=${RYZENADJ_SLOW} \
            --fast-limit=${RYZENADJ_FAST} \
            --apu-slow-limit=${RYZENADJ_APU_SLOW} \
            --tctl-temp=${RYZENADJ_TCTL} 2>/dev/null
        echo "  ryzenadj → stapm=${RYZENADJ_STAPM}mW slow=${RYZENADJ_SLOW}mW fast=${RYZENADJ_FAST}mW apu=${RYZENADJ_APU_SLOW}mW tctl=${RYZENADJ_TCTL}°C"
    else
        echo "  [WARN] ryzenadj non trouvé — limites BIOS appliquées !"
    fi

    # Mémoire : moins agressif sur le swap
    sysctl -q vm.swappiness=10
    echo "  vm.swappiness → 10"

    # Dirty pages : flush plus rapide (évite les pics de latence I/O)
    sysctl -q vm.dirty_ratio=5
    sysctl -q vm.dirty_background_ratio=2
    echo "  vm.dirty_ratio → 5 / dirty_background_ratio → 2"

    # THP always : kernel backe automatiquement les grosses allocs (modèle + KV cache)
    # en pages 2MB sans que llama.cpp ait besoin de le demander explicitement
    # (vm.nr_hugepages=0 : pas de hugepages statiques, elles seraient ignorées par llama)
    echo always > /sys/kernel/mm/transparent_hugepage/enabled
    echo "  THP → always"

    # Drop caches proprement (libère buff/cache sans tuer la RAM utile)
    sync
    echo 3 > /proc/sys/vm/drop_caches
    echo "  Page cache droppé"

    echo "[llama-perf] Mode PERFORMANCE actif."
}

perf_off() {
    echo "[llama-perf] Retour en mode ECO"

    for p in $CPU_POLICIES; do
        echo powersave > "$p/scaling_governor"
    done
    echo "  CPU governor → powersave"

    echo auto > "$GPU_POWER_FILE"
    echo "  GPU power level → auto (toutes les p-states)"

    # Restore limites BIOS d'origine
    if command -v ryzenadj &>/dev/null; then
        ryzenadj \
            --stapm-limit=85000 \
            --slow-limit=85000 \
            --fast-limit=120000 \
            --apu-slow-limit=70000 \
            --tctl-temp=98 2>/dev/null
        echo "  ryzenadj → limites BIOS restaurées"
    fi

    sysctl -q vm.swappiness=60
    sysctl -q vm.dirty_ratio=20
    sysctl -q vm.dirty_background_ratio=10
    echo "  vm params → valeurs par défaut"

    echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
    echo "  THP → madvise (défaut)"

    echo "[llama-perf] Mode ECO actif."
}

case "$MODE" in
    on)
        if [ "$EUID" -ne 0 ]; then
            echo "Requires root. Relaunching with sudo..."
            exec sudo "$0" on
        fi
        perf_on
        ;;
    off)
        if [ "$EUID" -ne 0 ]; then
            echo "Requires root. Relaunching with sudo..."
            exec sudo "$0" off
        fi
        perf_off
        ;;
    status)
        status
        ;;
    *)
        echo "Usage: $0 [on|off|status]"
        exit 1
        ;;
esac
