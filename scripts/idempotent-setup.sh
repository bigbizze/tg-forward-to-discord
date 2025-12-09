#!/bin/bash
#
# Idempotent Setup Script
# 
# This script can be run multiple times safely. It:
# 1. Updates system packages
# 2. Installs Node.js v22 if not present
# 3. Installs Python 3 if not present
# 4. Installs pnpm globally if not present
# 5. Pulls latest code from git
# 6. Installs npm dependencies
# 7. Creates Python venv and installs dependencies
# 8. Builds all TypeScript packages
# 9. Runs database setup
# 10. Installs and configures PM2
# 11. Starts/restarts all services
#
# Usage:
#   chmod +x scripts/idempotent-setup.sh
#   ./scripts/idempotent-setup.sh
#
# Or via pnpm:
#   pnpm setup

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"
log_info "Working directory: $PROJECT_DIR"

# Track if we need to restart services
NEEDS_RESTART=false

# =============================================================================
# Step 1: Update system packages
# =============================================================================
log_info "Updating system packages..."
if command -v apt-get &> /dev/null; then
    sudo apt-get update -qq
    log_info "System packages updated"
else
    log_warn "apt-get not found, skipping system update"
fi

# =============================================================================
# Step 2: Install Node.js v22
# =============================================================================
log_info "Checking Node.js installation..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -ge 22 ]; then
        log_info "Node.js v$(node -v) is already installed"
    else
        log_warn "Node.js version is too old, upgrading..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
        NEEDS_RESTART=true
    fi
else
    log_info "Installing Node.js v22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    NEEDS_RESTART=true
fi

# =============================================================================
# Step 3: Install Python 3
# =============================================================================
log_info "Checking Python installation..."
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version | cut -d' ' -f2)
    log_info "Python $PYTHON_VERSION is already installed"
else
    log_info "Installing Python 3..."
    sudo apt-get install -y python3 python3-venv python3-pip
    NEEDS_RESTART=true
fi

# =============================================================================
# Step 4: Install pnpm
# =============================================================================
log_info "Checking pnpm installation..."
if command -v pnpm &> /dev/null; then
    log_info "pnpm $(pnpm -v) is already installed"
else
    log_info "Installing pnpm..."
    sudo npm install -g pnpm
    NEEDS_RESTART=true
fi

# =============================================================================
# Step 5: Pull latest code (if in git repo)
# =============================================================================
if [ -d ".git" ]; then
    log_info "Fetching latest code..."
    
    # Store current commit hash
    OLD_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "none")
    
    # Fetch and reset to origin/master (or main)
    git fetch origin
    
    # Detect default branch
    DEFAULT_BRANCH=$(git remote show origin | grep "HEAD branch" | cut -d: -f2 | xargs)
    if [ -z "$DEFAULT_BRANCH" ]; then
        DEFAULT_BRANCH="master"
    fi
    
    git reset --hard "origin/$DEFAULT_BRANCH"
    
    # Check if code changed
    NEW_COMMIT=$(git rev-parse HEAD)
    if [ "$OLD_COMMIT" != "$NEW_COMMIT" ]; then
        log_info "Code updated: $OLD_COMMIT -> $NEW_COMMIT"
        NEEDS_RESTART=true
    else
        log_info "Code is already up to date"
    fi
else
    log_warn "Not a git repository, skipping git pull"
fi

# =============================================================================
# Step 6: Install npm dependencies
# =============================================================================
log_info "Installing npm dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
log_info "npm dependencies installed"

# =============================================================================
# Step 7: Set up Python virtual environment
# =============================================================================
VENV_DIR="$PROJECT_DIR/apps/python-scraper/.venv"

log_info "Setting up Python virtual environment..."
if [ ! -d "$VENV_DIR" ]; then
    log_info "Creating virtual environment at $VENV_DIR"
    python3 -m venv "$VENV_DIR"
    NEEDS_RESTART=true
fi

log_info "Installing Python dependencies..."
. "$VENV_DIR/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -r "$PROJECT_DIR/apps/python-scraper/requirements.txt"
deactivate
log_info "Python dependencies installed"

# =============================================================================
# Step 8: Build TypeScript packages
# =============================================================================
log_info "Building TypeScript packages..."
pnpm build
log_info "Build complete"
NEEDS_RESTART=true

# =============================================================================
# Step 9: Run database setup
# =============================================================================
log_info "Running database setup..."

# Check if .env file exists
if [ ! -f "$PROJECT_DIR/.env" ]; then
    log_warn ".env file not found, copying from .env.example"
    if [ -f "$PROJECT_DIR/.env.example" ]; then
        cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
        log_warn "Please edit .env file with your actual configuration!"
    else
        log_error ".env.example not found, cannot create .env"
    fi
fi

# Run database setup
node "$PROJECT_DIR/packages/db-setup/dist/index.js"
log_info "Database setup complete"

# =============================================================================
# Step 10: Install and configure PM2
# =============================================================================
log_info "Checking PM2 installation..."
if command -v pm2 &> /dev/null; then
    log_info "PM2 $(pm2 -v) is already installed"
else
    log_info "Installing PM2..."
    sudo npm install -g pm2
    NEEDS_RESTART=true
fi

# Create logs directory
mkdir -p "$PROJECT_DIR/logs"

# =============================================================================
# Step 11: Start or restart services
# =============================================================================
if [ "$NEEDS_RESTART" = true ]; then
    log_info "Starting/restarting PM2 services..."
    
    # Check if processes are already running
    if pm2 list | grep -q "express-server\|discord-bot\|python-scraper"; then
        log_info "Restarting existing PM2 processes..."
        pm2 restart ecosystem.config.cjs
    else
        log_info "Starting PM2 processes..."
        pm2 start ecosystem.config.cjs
    fi
    
    # Save PM2 process list
    pm2 save
    
    # Set up PM2 to start on boot (if not already done)
    if ! systemctl is-enabled pm2-$(whoami) &>/dev/null 2>&1; then
        log_info "Setting up PM2 startup script..."
        pm2 startup systemd -u $(whoami) --hp $HOME || true
    fi
    
    log_info "PM2 services started"
else
    log_info "No restart needed"
fi

# =============================================================================
# Final status
# =============================================================================
echo ""
log_info "=========================================="
log_info "Setup complete!"
log_info "=========================================="
echo ""
log_info "PM2 Status:"
pm2 list

echo ""
log_info "To view logs: pm2 logs"
log_info "To restart: pm2 restart all"
log_info "To stop: pm2 stop all"
