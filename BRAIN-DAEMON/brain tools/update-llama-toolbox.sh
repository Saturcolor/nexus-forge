#!/usr/bin/env bash
# update-llama-toolbox.sh — Met à jour llama.cpp dans le toolbox vulkan-radv

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
TOOLBOX_NAME="llama-vulkan-radv"
UPSTREAM_IMAGE="docker.io/kyuz0/amd-strix-halo-toolboxes:vulkan-radv"
LOCAL_IMAGE="localhost/llama-vulkan-radv:local"
BACKUP_IMAGE="localhost/llama-vulkan-radv:backup"
DOCKERFILE="$HOME/amd-strix-halo-toolboxes/toolboxes/Dockerfile.vulkan-radv"
TOOLBOX_ARGS="--device /dev/dri --group-add video --security-opt seccomp=unconfined"
DAEMON_SERVICE="llamacpp-daemon"

# ── Helpers ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()     { echo -e "${RED}[ERR]${NC}  $*" >&2; }
header()  { echo -e "\n${BOLD}$*${NC}"; }
confirm() {
    local prompt="$1"
    local resp
    read -rp "$(echo -e "${YELLOW}?${NC} ${prompt} [o/N] ")" resp
    [[ "${resp,,}" == "o" ]]
}

daemon_is_active() {
    systemctl --user is-active "$DAEMON_SERVICE" &>/dev/null
}

daemon_stop() {
    if daemon_is_active; then
        info "Arrêt du daemon llamacpp..."
        systemctl --user stop "$DAEMON_SERVICE"
        ok "Daemon arrêté."
    fi
}

daemon_start() {
    if systemctl --user is-enabled "$DAEMON_SERVICE" &>/dev/null; then
        info "Redémarrage du daemon llamacpp..."
        systemctl --user start "$DAEMON_SERVICE"
        ok "Daemon redémarré."
    else
        warn "Le daemon n'est pas activé (systemctl enable), pas redémarré."
    fi
}

toolbox_exists() {
    toolbox list 2>/dev/null | awk 'NR>1 {print $2}' | grep -q "^${TOOLBOX_NAME}$"
}

image_exists() {
    podman image exists "$1" 2>/dev/null
}

current_llama_version() {
    toolbox run "$TOOLBOX_NAME" llama-server --version 2>/dev/null \
        | grep -oP 'version: \K[0-9]+' || echo "inconnue"
}

recreate_toolbox() {
    local image="$1"
    info "Suppression de l'ancien toolbox..."
    toolbox rm -f "$TOOLBOX_NAME" 2>/dev/null || true
    info "Création du toolbox depuis $image..."
    # shellcheck disable=SC2086
    toolbox create "$TOOLBOX_NAME" --image "$image" -- $TOOLBOX_ARGS
    ok "Toolbox $TOOLBOX_NAME recréé."
}

# ── Menu principal ────────────────────────────────────────────────────────────
clear
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Mise à jour llama.cpp — $TOOLBOX_NAME   ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

if toolbox_exists; then
    version=$(current_llama_version)
    info "Version actuelle dans le toolbox : build ${BOLD}$version${NC}"
else
    warn "Le toolbox '$TOOLBOX_NAME' n'existe pas encore."
fi
echo ""

echo -e "  ${BOLD}1)${NC} Mettre à jour  — rebuild depuis le Dockerfile (dernier llama.cpp master)"
echo -e "  ${BOLD}2)${NC} Repull         — récupérer la dernière image de kyuz0 sur Docker Hub"
echo -e "  ${BOLD}3)${NC} Backup         — sauvegarder l'image actuelle (avant une mise à jour)"
echo -e "  ${BOLD}4)${NC} Restaurer      — revenir au backup ou à l'image kyuz0 d'origine"
echo -e "  ${BOLD}5)${NC} Statut         — infos sur les images et le toolbox"
echo -e "  ${BOLD}q)${NC} Quitter"
echo ""

read -rp "$(echo -e "${BOLD}Choix :${NC} ")" choice

case "$choice" in

# ── 1. Mise à jour locale ──────────────────────────────────────────────────
1)
    header "Mise à jour — rebuild local"

    if [ ! -f "$DOCKERFILE" ]; then
        err "Dockerfile introuvable : $DOCKERFILE"
        exit 1
    fi

    warn "Le build va cloner le dernier master de llama.cpp (~15-20 min)."

    if image_exists "$BACKUP_IMAGE"; then
        info "Un backup existe déjà ($(podman inspect "$BACKUP_IMAGE" --format '{{.Created}}' 2>/dev/null | cut -dT -f1))."
    else
        if toolbox_exists && confirm "Faire un backup de l'image actuelle avant de continuer ?"; then
            current_img=$(podman container inspect "$TOOLBOX_NAME" --format '{{.ImageName}}' 2>/dev/null \
                          || echo "$UPSTREAM_IMAGE")
            info "Backup de $current_img -> $BACKUP_IMAGE"
            podman tag "$current_img" "$BACKUP_IMAGE"
            ok "Backup créé : $BACKUP_IMAGE"
        fi
    fi

    if ! confirm "Lancer le build maintenant ?"; then
        info "Annulé."; exit 0
    fi

    daemon_stop

    info "Build en cours..."
    podman build \
        -f "$DOCKERFILE" \
        -t "$LOCAL_IMAGE" \
        "$(dirname "$DOCKERFILE")"
    ok "Image buildée : $LOCAL_IMAGE"

    new_ver=$(podman run --rm "$LOCAL_IMAGE" llama-server --version 2>/dev/null \
              | grep -oP 'version: \K[0-9]+' || echo "inconnue")
    ok "Nouvelle version : build ${BOLD}$new_ver${NC}"

    recreate_toolbox "$LOCAL_IMAGE"
    daemon_start
    ;;

# ── 2. Repull depuis Docker Hub ────────────────────────────────────────────
2)
    header "Repull depuis Docker Hub (kyuz0)"
    info "Image : $UPSTREAM_IMAGE"

    if confirm "Faire un backup de l'image actuelle avant de continuer ?"; then
        if image_exists "$UPSTREAM_IMAGE"; then
            podman tag "$UPSTREAM_IMAGE" "$BACKUP_IMAGE"
            ok "Backup créé : $BACKUP_IMAGE"
        else
            warn "Aucune image locale à sauvegarder."
        fi
    fi

    daemon_stop

    info "Pull en cours..."
    podman pull "$UPSTREAM_IMAGE"
    ok "Image mise à jour depuis Docker Hub."

    new_ver=$(podman run --rm "$UPSTREAM_IMAGE" llama-server --version 2>/dev/null \
              | grep -oP 'version: \K[0-9]+' || echo "inconnue")
    ok "Nouvelle version : build ${BOLD}$new_ver${NC}"

    recreate_toolbox "$UPSTREAM_IMAGE"
    daemon_start
    ;;

# ── 3. Backup ─────────────────────────────────────────────────────────────
3)
    header "Backup de l'image actuelle"

    if ! toolbox_exists; then
        err "Le toolbox '$TOOLBOX_NAME' n'existe pas."; exit 1
    fi

    if image_exists "$BACKUP_IMAGE"; then
        warn "Un backup existe déjà :"
        podman images "$BACKUP_IMAGE"
        if ! confirm "Écraser le backup existant ?"; then
            info "Annulé."; exit 0
        fi
    fi

    current_img=$(podman container inspect "$TOOLBOX_NAME" --format '{{.ImageName}}' 2>/dev/null \
                  || echo "$UPSTREAM_IMAGE")
    info "Sauvegarde de $current_img -> $BACKUP_IMAGE"
    podman tag "$current_img" "$BACKUP_IMAGE"
    ok "Backup créé : $BACKUP_IMAGE"
    ;;

# ── 4. Restauration ────────────────────────────────────────────────────────
4)
    header "Restauration"

    echo -e "  ${BOLD}a)${NC} Restaurer depuis le backup local"
    echo -e "  ${BOLD}b)${NC} Repull l'image originale de kyuz0 (état d'origine)"
    echo ""
    read -rp "$(echo -e "${BOLD}Choix :${NC} ")" restore_choice

    case "$restore_choice" in
    a)
        if ! image_exists "$BACKUP_IMAGE"; then
            err "Aucun backup trouvé ($BACKUP_IMAGE)."; exit 1
        fi
        info "Backup disponible :"
        podman images "$BACKUP_IMAGE"
        if ! confirm "Restaurer ce backup ?"; then
            info "Annulé."; exit 0
        fi
        daemon_stop
        recreate_toolbox "$BACKUP_IMAGE"
        daemon_start
        ok "Restauré depuis le backup."
        ;;
    b)
        warn "Ceci va repull l'image de kyuz0 et écraser l'image locale."
        if ! confirm "Continuer ?"; then
            info "Annulé."; exit 0
        fi
        daemon_stop
        info "Pull en cours..."
        podman pull "$UPSTREAM_IMAGE"
        recreate_toolbox "$UPSTREAM_IMAGE"
        daemon_start
        ok "Restauré depuis Docker Hub (kyuz0)."
        ;;
    *)
        info "Annulé."; exit 0
        ;;
    esac
    ;;

# ── 5. Statut ─────────────────────────────────────────────────────────────
5)
    header "Statut"

    echo -e "\n${BOLD}Toolbox :${NC}"
    if toolbox_exists; then
        ok "'$TOOLBOX_NAME' existe"
        echo "  Version llama.cpp : build $(current_llama_version)"
    else
        warn "'$TOOLBOX_NAME' absent"
    fi

    echo -e "\n${BOLD}Images podman :${NC}"
    podman images | grep -E "(REPOSITORY|kyuz0|llama-vulkan)" || echo "  Aucune"

    echo -e "\n${BOLD}Backup :${NC}"
    if image_exists "$BACKUP_IMAGE"; then
        podman images "$BACKUP_IMAGE"
    else
        warn "Aucun backup trouvé"
    fi

    echo -e "\n${BOLD}Daemon :${NC}"
    if daemon_is_active; then
        ok "llamacpp-daemon actif"
    else
        warn "llamacpp-daemon inactif"
    fi
    ;;

q|Q)
    info "Bye."; exit 0
    ;;

*)
    err "Choix invalide."; exit 1
    ;;
esac
