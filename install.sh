#!/bin/bash
set -e

CTX_DIR="$HOME/ctx"
BIN_DIR="$HOME/.local/bin"
CTX_BIN="$BIN_DIR/ctx"

echo "═══════════════════════════════════"
echo "  ctx — Universal Agent Resource Manager"
echo "  Installer"
echo "═══════════════════════════════════"
echo ""

# Check for bun, fallback to node
if command -v bun &>/dev/null; then
  RUNTIME="bun"
  echo "✓ Found bun $(bun --version)"
elif command -v node &>/dev/null; then
  RUNTIME="node"
  echo "✓ Found node $(node --version)"
  echo "  (bun recommended for better performance)"
else
  echo "✗ Neither bun nor node found."
  echo "  Install bun: curl -fsSL https://bun.sh/install | bash"
  echo "  Or install node: https://nodejs.org"
  exit 1
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
cd "$CTX_DIR"
if [ "$RUNTIME" = "bun" ]; then
  bun install
else
  npm install
fi

# Create bin directory
mkdir -p "$BIN_DIR"

# Create the ctx binary wrapper
cat > "$CTX_BIN" << 'WRAPPER'
#!/bin/bash
# ctx — Universal Agent Resource Manager
CTX_HOME="$HOME/ctx"

if command -v bun &>/dev/null; then
  exec bun run "$CTX_HOME/src/index.js" "$@"
else
  exec node "$CTX_HOME/src/index.js" "$@"
fi
WRAPPER

chmod +x "$CTX_BIN"

# Ensure ~/.local/bin is in PATH
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo ""
  echo "⚠ ~/.local/bin is not in your PATH."
  echo "  Add this to your shell profile (~/.bashrc or ~/.zshrc):"
  echo ""
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
fi

# Run setup
echo ""
echo "Running ctx setup..."
"$CTX_BIN" setup

echo ""
echo "═══════════════════════════════════"
echo "  Installation complete!"
echo "═══════════════════════════════════"
echo ""
echo "  Binary: $CTX_BIN"
echo "  Config: ~/.ctx/"
echo ""
echo "  Next steps:"
echo "    1. Ensure ~/.local/bin is in your PATH"
echo "    2. Run: ctx status"
echo "    3. Run: ctx --help"
echo ""
