#!/bin/bash
# ctx installer — Universal Agent Resource Manager
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}→${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; exit 1; }

# Parse flags
REMOTE_URL=""
for arg in "$@"; do
  case $arg in
    --remote=*) REMOTE_URL="${arg#*=}" ;;
    --remote) shift; REMOTE_URL="$1"; shift ;;
  esac
done

# Detect Termux
IS_TERMUX=false
if [ -n "$TERMUX_VERSION" ] || [ "$(uname -o 2>/dev/null)" = "Android" ] || [ -d "/data/data/com.termux" ] || [ "$PREFIX" = "/data/data/com.termux/files/usr" ]; then
  IS_TERMUX=true
  warn "Detected Termux (Android)"
fi

# Detect update vs fresh install
CTX_BIN="$HOME/.local/bin/ctx"
IS_UPDATE=false
if [ -f "$CTX_BIN" ]; then
  IS_UPDATE=true
  warn "Existing ctx installation detected — updating..."
fi

# Check for node/bun
PKG_MANAGER=""
if command -v bun &>/dev/null; then
  PKG_MANAGER="bun"
elif command -v node &>/dev/null; then
  PKG_MANAGER="node"
else
  if [ "$IS_TERMUX" = true ]; then
    error "Neither bun nor node found. Install with: pkg install nodejs"
  else
    error "Neither bun nor node found. Install Node.js first."
  fi
fi

echo ""
echo "═══════════════════════════════════"
echo "  ctx — Universal Agent Resource Manager"
echo "═══════════════════════════════════"
echo ""
echo "  Package manager: $PKG_MANAGER"
echo "  Install mode:    $([ "$IS_UPDATE" = true ] && echo 'update' || echo 'fresh')"
echo ""

# Go to ctx directory
cd "$HOME/ctx" 2>/dev/null || error "Directory ~/ctx not found. Clone ctx first."

# Install dependencies
echo "Installing dependencies..."
if [ "$PKG_MANAGER" = "bun" ]; then
  bun install --frozen-lockfile 2>/dev/null || bun install
else
  npm install --production 2>/dev/null || npm install
fi

# Ensure ~/.local/bin exists and is in PATH
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

# Create wrapper script
cat > "$CTX_BIN" << 'WRAPPER'
#!/bin/bash
exec node "$HOME/ctx/src/index.js" "$@"
WRAPPER
chmod +x "$CTX_BIN"

info "Installed ctx binary at $CTX_BIN"

# Check PATH
if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
  warn "Add ~/.local/bin to your PATH:"
  warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  warn "Add to ~/.bashrc or ~/.zshrc for persistence."
fi

# Run setup
echo ""
echo "Running ctx setup..."
node "$HOME/ctx/src/index.js" setup

# Configure sync remote if provided
if [ -n "$REMOTE_URL" ]; then
  echo ""
  warn "Configuring sync remote: $REMOTE_URL"
  "$CTX_BIN" sync init "$REMOTE_URL"
fi

# On fresh install with Termux, ask about sync remote
if [ "$IS_UPDATE" = false ] && [ "$IS_TERMUX" = true ] && [ -z "$REMOTE_URL" ]; then
  echo ""
  echo "Do you have a ctx sync remote? (y/N)"
  read -r response < /dev/tty
  if [[ "$response" =~ ^[Yy] ]]; then
    echo "Enter git remote URL:"
    read -r remote < /dev/tty
    if [ -n "$remote" ]; then
      "$CTX_BIN" sync init "$remote"
    fi
  fi
fi

echo ""
echo "═══════════════════════════════════"
echo "  Installation complete!"
echo "═══════════════════════════════════"
echo ""
echo "  Run: ctx --help"
echo "  Run: ctx status"
echo ""
