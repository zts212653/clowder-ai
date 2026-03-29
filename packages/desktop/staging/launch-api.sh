#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$DIR/node/node"
export MEMORY_STORE=1
export API_SERVER_PORT="${API_SERVER_PORT:-13004}"
export FRONTEND_PORT="${FRONTEND_PORT:-13003}"
export CAT_CAFE_DESKTOP=1
# Listen on both IPv4 and IPv6 (WebKit resolves localhost to ::1)
export API_SERVER_HOST="::"
# Make agent CLIs (claude, codex) findable; include homebrew for native deps
export PATH="$HOME/.cat-cafe/cli/bin:$DIR/node:/opt/homebrew/bin:/usr/local/bin:$PATH"

# --- Inherit proxy settings from user's shell profile ---
# GUI apps on macOS don't inherit shell env vars. Source the user's profile
# to pick up proxy settings (http_proxy, https_proxy, etc.) needed for
# CLI subprocesses to reach external APIs (e.g. Anthropic, OpenAI).
for rc in "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  if [ -f "$rc" ]; then
    # Source in subshell-safe way: only extract export lines to avoid side effects
    eval "$(grep -E '^\s*export\s+(http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY|all_proxy|ALL_PROXY|no_proxy|NO_PROXY|CLASH_)=' "$rc" 2>/dev/null)"
    break
  fi
done

# Native addons in api/node_modules/ — resolved naturally via cd
cd "$DIR/api"
exec "$NODE" "$DIR/api/index.mjs"
