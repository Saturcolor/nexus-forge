#!/bin/bash

# ========================================
# Probe LM Studio - Backup / Migration (Linux / macOS)
# ========================================

set -e

APP_DIR="${PROBE_APP_DIR:-/opt/openrouter-probe}"
APP_USER="${PROBE_APP_USER:-$(logname 2>/dev/null || whoami)}"
BACKUP_DIR="${PROBE_BACKUP_DIR:-/var/backups/openrouter-probe}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="probe_backup_${TIMESTAMP}"
RUN_AS=""
[ "$(uname -s)" = "Linux" ] && RUN_AS="sudo -u $APP_USER"
PYTHON_CMD="python3"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}   Probe LM Studio - Migration${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""
}
print_success() { echo -e "${GREEN}✓ $1${NC}"; }
print_error()   { echo -e "${RED}✗ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠ $1${NC}"; }
print_info()   { echo -e "${CYAN}ℹ $1${NC}"; }

if [ "$(uname -s)" = "Linux" ] && [ "$EUID" -ne 0 ]; then
    echo "❌ Ce script doit être exécuté avec sudo sur Linux"
    echo "Usage: sudo ./migrate.sh [backup|restore|migrate|list|help]"
    exit 1
fi

backup() {
    print_header
    print_info "Création d'un backup..."
    mkdir -p "$BACKUP_DIR"
    [ "$(uname -s)" = "Linux" ] && chown -R "$APP_USER:$APP_USER" "$BACKUP_DIR" 2>/dev/null || true
    mkdir -p "$BACKUP_DIR/$BACKUP_NAME"
    if [ -d "$APP_DIR" ]; then
        tar -czf "$BACKUP_DIR/$BACKUP_NAME/code.tar.gz" -C "$APP_DIR" --exclude='venv' --exclude='__pycache__' --exclude='*.pyc' --exclude='.git' . 2>/dev/null || true
        print_success "Code sauvegardé"
    fi
    if [ -f "$APP_DIR/config.yaml" ]; then
        cp "$APP_DIR/config.yaml" "$BACKUP_DIR/$BACKUP_NAME/"
        print_success "Config sauvegardée"
    fi
    cd "$BACKUP_DIR"
    tar -czf "${BACKUP_NAME}.tar.gz" "$BACKUP_NAME"
    rm -rf "$BACKUP_NAME"
    [ "$(uname -s)" = "Linux" ] && chown -R "$APP_USER:$APP_USER" "$BACKUP_DIR"
    print_success "Backup créé: $BACKUP_DIR/${BACKUP_NAME}.tar.gz"
    echo ""
}

restore() {
    print_header
    [ -z "${1:-}" ] && { print_error "Spécifiez le fichier backup"; exit 1; }
    BACKUP_FILE="$1"
    [ ! -f "$BACKUP_FILE" ] && { print_error "Fichier introuvable: $BACKUP_FILE"; exit 1; }
    print_warning "Remplacer le code et la config?"
    read -p "Continuer? (tapez OUI): " confirm
    [ "$confirm" != "OUI" ] && { print_info "Annulé"; exit 0; }
    [ "$(uname -s)" = "Linux" ] && systemctl stop probe-lmstudio 2>/dev/null || true
    EXTRACT_DIR="/tmp/restore_probe_$$"
    mkdir -p "$EXTRACT_DIR"
    tar -xzf "$BACKUP_FILE" -C "$EXTRACT_DIR"
    BACKUP_FOLDER=$(ls "$EXTRACT_DIR" | head -1)
    if [ -f "$EXTRACT_DIR/$BACKUP_FOLDER/code.tar.gz" ]; then
        tar -xzf "$EXTRACT_DIR/$BACKUP_FOLDER/code.tar.gz" -C "$APP_DIR"
        [ "$(uname -s)" = "Linux" ] && chown -R "$APP_USER:$APP_USER" "$APP_DIR"
        print_success "Code restauré"
    fi
    if [ -f "$EXTRACT_DIR/$BACKUP_FOLDER/config.yaml" ]; then
        read -p "Restaurer config.yaml? (o/N): " r
        [ "$r" = "o" ] || [ "$r" = "O" ] && cp "$EXTRACT_DIR/$BACKUP_FOLDER/config.yaml" "$APP_DIR/config.yaml" && print_success "Config restaurée"
    fi
    rm -rf "$EXTRACT_DIR"
    if [ -f "$APP_DIR/requirements.txt" ]; then
        [ -n "$RUN_AS" ] && $RUN_AS "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt" --quiet --upgrade || "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt" --quiet --upgrade
    fi
    [ "$(uname -s)" = "Linux" ] && systemctl start probe-lmstudio 2>/dev/null || true
    print_success "Restauration terminée"
    echo ""
}

migrate() {
    print_header
    print_warning "Backup avant migration..."
    backup
    [ "$(uname -s)" = "Linux" ] && systemctl stop probe-lmstudio 2>/dev/null || true
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # Source = répertoire d'où copier. Si on lance depuis APP_DIR, utiliser PROBE_SOURCE_DIR si défini.
    SOURCE_DIR="$SCRIPT_DIR"
    if [ "$SCRIPT_DIR" = "$APP_DIR" ] && [ -n "${PROBE_SOURCE_DIR:-}" ]; then
        SOURCE_DIR="$(cd "$PROBE_SOURCE_DIR" && pwd)"
        print_info "Copie depuis PROBE_SOURCE_DIR=$SOURCE_DIR"
    elif [ "$SCRIPT_DIR" = "$APP_DIR" ]; then
        print_warning "Migration lancée depuis $APP_DIR : aucun fichier à copier (même répertoire)."
        print_info "Pour mettre à jour le code : lancez migrate depuis le dépôt source (probe/), ou définissez PROBE_SOURCE_DIR=/chemin/vers/probe"
    fi
    if [ "$SOURCE_DIR" != "$APP_DIR" ] && [ -f "$SOURCE_DIR/main.py" ]; then
        print_info "Copie du code depuis $SOURCE_DIR vers $APP_DIR..."
        if command -v rsync &>/dev/null; then
            rsync -a --delete --exclude='venv' --exclude='__pycache__' --exclude='*.pyc' --exclude='.git' --exclude='config.yaml' "$SOURCE_DIR/" "$APP_DIR/"
        else
            for item in "$SOURCE_DIR"/*; do
                base=$(basename "$item")
                [ "$base" = "venv" ] || [ "$base" = "config.yaml" ] && continue
                cp -a "$item" "$APP_DIR/"
            done
            rm -rf "$APP_DIR/__pycache__" "$APP_DIR/"*/.pycache 2>/dev/null || true
        fi
        [ "$(uname -s)" = "Linux" ] && chown -R "$APP_USER:$APP_USER" "$APP_DIR"
        print_success "Code copié"
    fi
    [ ! -d "$APP_DIR/venv" ] && $RUN_AS $PYTHON_CMD -m venv "$APP_DIR/venv" || true
    [ -f "$APP_DIR/requirements.txt" ] && ( [ -n "$RUN_AS" ] && $RUN_AS "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt" --quiet --upgrade || "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt" --quiet --upgrade ) && print_success "Dépendances mises à jour"
    [ "$(uname -s)" = "Linux" ] && [ -f "$APP_DIR/systemd/probe-lmstudio.service" ] && sed "s|%APP_DIR%|$APP_DIR|g; s|%SERVICE_USER%|$APP_USER|g" "$APP_DIR/systemd/probe-lmstudio.service" > /etc/systemd/system/probe-lmstudio.service && systemctl daemon-reload && print_success "Service systemd mis à jour"
    [ "$(uname -s)" = "Linux" ] && systemctl start probe-lmstudio 2>/dev/null || true
    print_success "Migration terminée!"
    echo ""
}

case "${1:-help}" in
    backup)  backup ;;
    restore) restore "$2" ;;
    migrate) migrate ;;
    list)
        print_header
        ls -lh "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -20 || print_warning "Aucun backup dans $BACKUP_DIR"
        ;;
    help|--help|-h)
        echo "Usage: sudo ./migrate.sh [backup|restore|migrate|list|help]"
        echo "  backup          Créer un backup (code, config)"
        echo "  restore <file>  Restaurer depuis un backup"
        echo "  migrate         Backup + copie code + deps + redémarrage"
        echo "  list            Lister les backups"
        echo ""
        echo "Si vous lancez migrate depuis $APP_DIR (répertoire installé), aucun fichier n'est copié."
        echo "Dans ce cas, lancez migrate depuis le dépôt source (probe/), ou :"
        echo "  PROBE_SOURCE_DIR=/chemin/vers/probe sudo ./migrate.sh migrate"
        exit 0
        ;;
    *)
        print_error "Commande inconnue: $1"; echo "Utilisez: ./migrate.sh help"; exit 1
        ;;
esac
