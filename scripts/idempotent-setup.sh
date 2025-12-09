#!/bin/bash
#
# Idempotent Setup Script
#
# This script can be run multiple times safely. It:
# 1. Validates prerequisites (Node.js, Python, pnpm, PM2)
# 2. Pulls latest code from git (if in git repo)
# 3. Installs npm dependencies
# 4. Creates Python venv and installs dependencies
# 5. Builds all TypeScript packages
# 6. Runs database setup
# 7. Starts/restarts all services with PM2
#
# Prerequisites (should be installed by cloud-init):
# - Node.js v22
# - Python 3
# - pnpm
# - PM2
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
# Step 1: Validate Prerequisites
# =============================================================================
log_info "Validating prerequisites..."

# Check Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js is not installed. Please install Node.js v22 first."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    log_error "Node.js version is too old (need v22+, found v$NODE_VERSION)"
    exit 1
fi
log_info "✓ Node.js v$(node -v)"

# Check Python
if ! command -v python3 &> /dev/null; then
    log_error "Python 3 is not installed"
    exit 1
fi
log_info "✓ Python $(python3 --version | cut -d' ' -f2)"

# Check pnpm
if ! command -v pnpm &> /dev/null; then
    log_error "pnpm is not installed. Install with: npm install -g pnpm"
    exit 1
fi
log_info "✓ pnpm $(pnpm -v)"

# Check PM2
if ! command -v pm2 &> /dev/null; then
    log_error "PM2 is not installed. Install with: npm install -g pm2"
    exit 1
fi
log_info "✓ PM2 $(pm2 -v)"

log_info "All prerequisites met!"

# =============================================================================
# Step 2: Pull latest code (if in git repo)
# =============================================================================
if [ -d ".git" ]; then
    log_info "Fetching latest code..."

    # Store current commit hash
    OLD_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "none")

    # Fetch and reset to origin
    git fetch origin

    # Detect default branch
    DEFAULT_BRANCH=$(git remote show origin | grep "HEAD branch" | cut -d: -f2 | xargs 2>/dev/null || echo "master")
    if [ -z "$DEFAULT_BRANCH" ]; then
        DEFAULT_BRANCH="master"
    fi

    log_info "Resetting to origin/$DEFAULT_BRANCH..."
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
# Step 3: Install npm dependencies
# =============================================================================
log_info "Installing npm dependencies..."

# Use frozen lockfile if it exists, otherwise install normally
if [ -f "pnpm-lock.yaml" ]; then
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
else
    pnpm install
fi

log_info "✓ npm dependencies installed"

# =============================================================================
# Step 4: Set up Python virtual environment
# =============================================================================
VENV_DIR="$PROJECT_DIR/apps/python-scraper/.venv"

log_info "Setting up Python virtual environment..."

if [ ! -d "$VENV_DIR" ]; then
    log_info "Creating virtual environment at $VENV_DIR"
    python3 -m venv "$VENV_DIR"
    NEEDS_RESTART=true
fi

# Activate venv and install dependencies
log_info "Installing Python dependencies..."
. "$VENV_DIR/bin/activate"

# Upgrade pip quietly
pip install --quiet --upgrade pip

# Install requirements
REQUIREMENTS_FILE="$PROJECT_DIR/apps/python-scraper/requirements.txt"
if [ -f "$REQUIREMENTS_FILE" ]; then
    pip install --quiet -r "$REQUIREMENTS_FILE"
    log_info "✓ Python dependencies installed"
else
    log_warn "requirements.txt not found at $REQUIREMENTS_FILE"
fi

deactivate

# =============================================================================
# Step 5: Build TypeScript packages
# =============================================================================
log_info "Building TypeScript packages..."
pnpm build
log_info "✓ Build complete"
NEEDS_RESTART=true

# =============================================================================
# Step 6: Run database setup
# =============================================================================
log_info "Running database setup..."

# Check if .env file exists
if [ ! -f "$PROJECT_DIR/.env" ]; then
    log_warn "⚠ .env file not found"

    if [ -f "$PROJECT_DIR/.env.example" ]; then
        cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
        log_warn "Created .env from .env.example"
        log_warn "⚠ IMPORTANT: Edit .env file with your actual configuration!"
        log_warn "Then run this script again."
        exit 1
    else
        log_error ".env.example not found, cannot create .env"
        log_error "Please create .env file manually"
        exit 1
    fi
fi

# Create data directory if it doesn't exist
mkdir -p "$PROJECT_DIR/data"

# Run database setup
DB_SETUP_SCRIPT="$PROJECT_DIR/packages/db-setup/dist/index.js"
if [ -f "$DB_SETUP_SCRIPT" ]; then
    node "$DB_SETUP_SCRIPT"
    log_info "✓ Database setup complete"
else
    log_error "Database setup script not found at $DB_SETUP_SCRIPT"
    log_error "Make sure you ran 'pnpm build' first"
    exit 1
fi


log_info "Archiving old logs..."
pnpm logs:archive

# =============================================================================
# Step 7: Start or restart services with PM2
# =============================================================================
log_info "Managing PM2 services..."

# Create logs directory
mkdir -p "$PROJECT_DIR/logs"

# Check if PM2 config exists
PM2_CONFIG="$PROJECT_DIR/ecosystem.config.cjs"
if [ ! -f "$PM2_CONFIG" ]; then
    log_error "PM2 config not found at $PM2_CONFIG"
    exit 1
fi

# Always stop and start to pick up config changes
# pm2 restart doesn't reload the ecosystem config, only restarts existing processes
log_info "Stopping existing PM2 processes (if any)..."
pm2 delete all 2>/dev/null || true

log_info "Starting PM2 processes..."
pm2 start ecosystem.config.cjs

# Save PM2 process list
pm2 save --force

log_info "✓ PM2 services configured"

# =============================================================================
# Final status
# =============================================================================
echo ""
log_info "=========================================="
log_info "✓ Setup complete!"
log_info "=========================================="
echo ""

# Show PM2 status
log_info "PM2 Status:"
pm2 list

echo ""
log_info "Useful commands:"
log_info "  View logs:       pm2 logs"
log_info "  Restart all:     pm2 restart all"
log_info "  Stop all:        pm2 stop all"
log_info "  Monitor:         pm2 monit"
log_info "  Process info:    pm2 info <name>"
echo ""

# Show .env warning if it was just created
if [ "$NEEDS_RESTART" = true ] && [ -f "$PROJECT_DIR/.env.example" ]; then
    log_warn "Remember to configure your .env file with actual credentials!"
fi