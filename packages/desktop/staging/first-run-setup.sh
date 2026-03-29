#!/usr/bin/env bash
# Cat Café Desktop — First-run CLI setup
# Installs claude-code and codex CLI to ~/.cat-cafe/cli/ using embedded Node.js
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$DIR/node/node"
NPM="$DIR/node/npm"
CLI_HOME="$HOME/.cat-cafe/cli"
SETUP_MARKER="$HOME/.cat-cafe/.desktop-setup-done"
LOG="$HOME/.cat-cafe/setup.log"

# Skip if already completed
if [ -f "$SETUP_MARKER" ]; then
  exit 0
fi

mkdir -p "$CLI_HOME" "$HOME/.cat-cafe"

echo "[Cat Café Setup] $(date)" >> "$LOG"
echo "  Node: $NODE" >> "$LOG"
echo "  CLI_HOME: $CLI_HOME" >> "$LOG"

# Fix npm shebang to use our embedded node
export PATH="$DIR/node:$PATH"

install_cli() {
  local pkg="$1"
  local cmd="$2"

  # Check if already available in system PATH or our CLI_HOME
  if command -v "$cmd" &>/dev/null; then
    echo "  ✓ $cmd already installed ($(command -v "$cmd"))" >> "$LOG"
    return 0
  fi

  if [ -x "$CLI_HOME/bin/$cmd" ]; then
    echo "  ✓ $cmd already in $CLI_HOME/bin/" >> "$LOG"
    return 0
  fi

  echo "  Installing $pkg..." >> "$LOG"
  "$NODE" "$DIR/node/lib/node_modules/npm/bin/npm-cli.js" install \
    --prefix "$CLI_HOME" \
    --global \
    "$pkg" \
    >> "$LOG" 2>&1 || {
    echo "  ✗ Failed to install $pkg (see $LOG)" >> "$LOG"
    return 1
  }
  echo "  ✓ $pkg installed to $CLI_HOME" >> "$LOG"
}

echo "  Installing agent CLIs..." >> "$LOG"

# Install Claude Code CLI
install_cli "@anthropic-ai/claude-code" "claude" || true

# Install Codex CLI
install_cli "@openai/codex" "codex" || true

# Mark setup as done
echo "$(date)" > "$SETUP_MARKER"
echo "[Cat Café Setup] Complete" >> "$LOG"
