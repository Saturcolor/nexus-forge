#!/bin/bash

# ========================================
# Probe LM Studio - Installation (Linux / macOS)
# ========================================
# À installer sur la machine qui héberge LM Studio.
# Expose GET /health, GET /stats, GET /stats/stream (SSE).

set -euo pipefail

if [ "$(uname -s)" = "Linux" ] && [ "$EUID" -ne 0 ]; then
    echo "❌ Ce script doit être exécuté avec sudo sur Linux"
    echo "Usage: sudo ./install.sh"
    exit 1
fi

# Configuration
APP_DIR="${PROBE_APP_DIR:-/opt/openrouter-probe}"
# Par défaut, utiliser le user qui a lancé sudo (logname), ou l'utilisateur courant.
# Cela évite les problèmes de permissions quand LM Studio tourne sous le même user.
APP_USER="${PROBE_APP_USER:-$(logname 2>/dev/null || whoami)}"
PYTHON_CMD="python3"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}   Probe LM Studio - Installation${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""
}
print_success() { echo -e "${GREEN}✓ $1${NC}"; }
print_error()   { echo -e "${RED}✗ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠ $1${NC}"; }
print_info()   { echo -e "${CYAN}ℹ $1${NC}"; }

print_header

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 0. config.yaml depuis example si absent
if [ ! -f "$SCRIPT_DIR/config.yaml" ] && [ -f "$SCRIPT_DIR/config.yaml.example" ]; then
    cp "$SCRIPT_DIR/config.yaml.example" "$SCRIPT_DIR/config.yaml"
    print_success "config.yaml créé depuis config.yaml.example"
fi

# 1. Dépendances système
print_info "Vérification des dépendances..."
if ! command -v "$PYTHON_CMD" &>/dev/null; then
    print_error "Python 3 non trouvé"
    [ "$(uname -s)" = "Linux" ] && print_info "  sudo apt-get install python3 python3-venv python3-pip"
    exit 1
fi
print_success "Python trouvé"

# 2. Utilisateur (Linux)
if [ "$(uname -s)" = "Linux" ]; then
    if id "$APP_USER" &>/dev/null; then
        print_info "Service sous l'utilisateur existant : $APP_USER"
    else
        print_info "Création de l'utilisateur $APP_USER..."
        useradd -r -m -d "$APP_DIR" -s /bin/bash "$APP_USER"
        print_success "Utilisateur $APP_USER créé"
    fi
fi

# 3. Répertoire application
print_info "Création du répertoire $APP_DIR..."
mkdir -p "$APP_DIR"
[ "$(uname -s)" = "Linux" ] && chown -R "$APP_USER:$APP_USER" "$APP_DIR"
print_success "Répertoire créé"

# 4. Copie du code (depuis ce répertoire probe/)
if [ "$SCRIPT_DIR" != "$APP_DIR" ]; then
    print_info "Copie du code depuis $SCRIPT_DIR vers $APP_DIR..."
    rsync -a --delete \
          --exclude='venv' \
          --exclude='__pycache__' \
          --exclude='*.pyc' \
          --exclude='.git' \
          --exclude='*.log' \
          "$SCRIPT_DIR/" "$APP_DIR/" 2>/dev/null || cp -r "$SCRIPT_DIR"/* "$APP_DIR/" 2>/dev/null || true
    rm -rf "$APP_DIR/venv" 2>/dev/null || true
    [ "$(uname -s)" = "Linux" ] && chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    print_success "Code copié"
fi

# 5. Venv
print_info "Environnement virtuel Python..."
RUN_AS=""
[ "$(uname -s)" = "Linux" ] && RUN_AS="sudo -u $APP_USER"
if [ ! -d "$APP_DIR/venv" ]; then
    $RUN_AS $PYTHON_CMD -m venv "$APP_DIR/venv" || $PYTHON_CMD -m venv "$APP_DIR/venv"
    print_success "Venv créé"
fi

# 6. Dépendances Python
print_info "Installation des dépendances Python..."
if [ -f "$APP_DIR/requirements.txt" ]; then
    if [ -n "$RUN_AS" ]; then
        $RUN_AS "$APP_DIR/venv/bin/pip" install --upgrade pip --quiet 2>/dev/null || true
        $RUN_AS "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt" --quiet
    else
        "$APP_DIR/venv/bin/pip" install --upgrade pip --quiet 2>/dev/null || true
        "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt" --quiet
    fi
    print_success "Dépendances installées"
else
    print_warning "requirements.txt absent"
fi

# 7. config.yaml dans APP_DIR si absent
if [ ! -f "$APP_DIR/config.yaml" ] && [ -f "$APP_DIR/config.yaml.example" ]; then
    [ -n "$RUN_AS" ] && $RUN_AS cp "$APP_DIR/config.yaml.example" "$APP_DIR/config.yaml" || cp "$APP_DIR/config.yaml.example" "$APP_DIR/config.yaml"
    print_success "config.yaml créé dans $APP_DIR"
fi

# 8. Service systemd (Linux)
if [ "$(uname -s)" = "Linux" ] && [ -f "$APP_DIR/systemd/probe-lmstudio.service" ]; then
    print_info "Installation du service systemd..."
    sed "s|%APP_DIR%|$APP_DIR|g; s|%SERVICE_USER%|$APP_USER|g" "$APP_DIR/systemd/probe-lmstudio.service" > /etc/systemd/system/probe-lmstudio.service
    systemctl daemon-reload
    print_success "Service systemd installé (probe-lmstudio)"
else
    [ "$(uname -s)" = "Darwin" ] && print_info "macOS: lancez avec: cd $APP_DIR && ./venv/bin/python main.py"
fi

echo ""
print_success "Installation probe terminée!"
echo ""
print_info "Configuration: $APP_DIR/config.yaml"
print_info "Port par défaut: 9090"
echo ""
if [ "$(uname -s)" = "Linux" ]; then
    echo "  sudo systemctl enable probe-lmstudio"
    echo "  sudo systemctl start probe-lmstudio"
    echo "  curl http://localhost:9090/health"
    echo "  curl http://localhost:9090/stats"
else
    echo "  cd $APP_DIR && ./venv/bin/python main.py"
fi
echo ""
