#!/usr/bin/env bash
# Build a distributable Cat Café.app (A+ architecture)
# Produces: Tauri .app with embedded Node.js + Next standalone + API bundle
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"
STAGING="$DESKTOP_DIR/staging"
NODE_VERSION="22.15.0"
NODE_ARCH="darwin-arm64"
NODE_DIR="node-v${NODE_VERSION}-${NODE_ARCH}"
NODE_TARBALL="${NODE_DIR}.tar.gz"
NODE_CACHE="$DESKTOP_DIR/.node-cache"

echo "=== Cat Café Distributable Build ==="
echo "Project root: $PROJECT_ROOT"

# --- Step 0: Clean staging ---
rm -rf "$STAGING"
mkdir -p "$STAGING"/{node,web,api}

# --- Step 1: Download Node.js binary (cached) ---
echo ""
echo ">>> Step 1: Node.js binary ($NODE_VERSION arm64)"
mkdir -p "$NODE_CACHE"
if [ ! -f "$NODE_CACHE/node" ]; then
  echo "    Downloading Node.js $NODE_VERSION..."
  curl -sL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}" -o "$NODE_CACHE/${NODE_TARBALL}"
  tar -xzf "$NODE_CACHE/${NODE_TARBALL}" -C "$NODE_CACHE"
  mv "$NODE_CACHE/${NODE_DIR}/bin/node" "$NODE_CACHE/node"
  # Extract npm for CLI auto-install capability
  mkdir -p "$NODE_CACHE/npm"
  cp "$NODE_CACHE/${NODE_DIR}/bin/npm" "$NODE_CACHE/npm/npm"
  cp "$NODE_CACHE/${NODE_DIR}/bin/npx" "$NODE_CACHE/npm/npx"
  cp -R "$NODE_CACHE/${NODE_DIR}/lib/node_modules/npm" "$NODE_CACHE/npm/node_modules_npm"
  rm -rf "$NODE_CACHE/${NODE_DIR}" "$NODE_CACHE/${NODE_TARBALL}"
  echo "    Cached at $NODE_CACHE/"
else
  echo "    Using cached Node.js + npm"
fi
cp "$NODE_CACHE/node" "$STAGING/node/node"
chmod +x "$STAGING/node/node"
# Include npm/npx for first-run CLI setup
mkdir -p "$STAGING/node/lib/node_modules"
cp "$NODE_CACHE/npm/npm" "$STAGING/node/npm"
cp "$NODE_CACHE/npm/npx" "$STAGING/node/npx"
cp -R "$NODE_CACHE/npm/node_modules_npm" "$STAGING/node/lib/node_modules/npm"
chmod +x "$STAGING/node/npm" "$STAGING/node/npx"
echo "    Node + npm: $(du -sh "$STAGING/node" | cut -f1)"

# --- Step 2: Build Next.js standalone ---
echo ""
echo ">>> Step 2: Next.js standalone build"
cd "$PROJECT_ROOT"
NEXT_STANDALONE=1 FRONTEND_PORT=13003 API_SERVER_PORT=13004 \
  NEXT_PUBLIC_API_URL=http://localhost:13004 \
  pnpm --filter @cat-cafe/web build 2>&1 | tail -5

WEB_STANDALONE="$PROJECT_ROOT/packages/web/.next/standalone"
# Copy standalone server — dereference pnpm symlinks for Tauri bundling
rsync -rL "$WEB_STANDALONE/" "$STAGING/web/"
# Hoist packages from .pnpm store to top-level (Tauri doesn't bundle symlinks)
echo "    Hoisting pnpm packages..."
for pkg_path in "$STAGING/web/node_modules/.pnpm"/*/node_modules/*; do
  [ ! -d "$pkg_path" ] && continue
  pkg_name=$(basename "$pkg_path")
  [[ "$pkg_name" == .* ]] && continue
  target="$STAGING/web/node_modules/$pkg_name"
  [ -d "$target" ] || cp -R "$pkg_path" "$target" 2>/dev/null
done
for scope_path in "$STAGING/web/node_modules/.pnpm"/*/node_modules/@*; do
  [ ! -d "$scope_path" ] && continue
  scope_name=$(basename "$scope_path")
  for pkg_path in "$scope_path"/*; do
    pkg_name=$(basename "$pkg_path")
    target="$STAGING/web/node_modules/$scope_name/$pkg_name"
    [ -d "$target" ] || { mkdir -p "$STAGING/web/node_modules/$scope_name"; cp -R "$pkg_path" "$target" 2>/dev/null; }
  done
done
# Copy static assets (not included in standalone)
mkdir -p "$STAGING/web/packages/web/.next/static"
cp -R "$PROJECT_ROOT/packages/web/.next/static/"* "$STAGING/web/packages/web/.next/static/"
# Copy public directory
if [ -d "$PROJECT_ROOT/packages/web/public" ]; then
  mkdir -p "$STAGING/web/packages/web/public"
  cp -R "$PROJECT_ROOT/packages/web/public/"* "$STAGING/web/packages/web/public/" 2>/dev/null || true
fi
echo "    Standalone size: $(du -sh "$STAGING/web" | cut -f1)"

# --- Step 3: Build & bundle API ---
echo ""
echo ">>> Step 3: API bundle (esbuild + npm externals)"
cd "$PROJECT_ROOT"
pnpm --filter @cat-cafe/shared build 2>&1 | tail -2
pnpm --filter @cat-cafe/api build 2>&1 | tail -2

# ESM compat banner: provide require(), __dirname, __filename for CJS deps
BANNER='import { createRequire as __cr } from "module"; import { fileURLToPath as __ftp } from "url"; import { dirname as __dn } from "path"; const require = __cr(import.meta.url); const __filename = __ftp(import.meta.url); const __dirname = __dn(__filename);'

# Bundle with esbuild — native addons + pino (worker threads) are external
echo "    Bundling API with esbuild..."
npx esbuild "$PROJECT_ROOT/packages/api/dist/index.js" \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=esm \
  --outfile="$STAGING/api/index.mjs" \
  --sourcemap=external \
  --external:better-sqlite3 \
  --external:sqlite-vec \
  --external:node-pty \
  --external:sharp \
  --external:puppeteer \
  --external:@huggingface/transformers \
  --external:pino \
  --external:pino-pretty \
  --external:thread-stream \
  --external:pino-abstract-transport \
  --external:sonic-boom \
  "--define:process.env.NODE_ENV=\"production\"" \
  "--banner:js=$BANNER" \
  2>&1 | tail -3

# Install external packages via npm into api/node_modules
echo "    Installing external native/runtime packages..."
NODE_BIN="$STAGING/node/node"
NPM_CLI="$STAGING/node/lib/node_modules/npm/bin/npm-cli.js"

cat > "$STAGING/api/package.json" << 'PKGJSON'
{
  "name": "cat-cafe-api-desktop",
  "private": true,
  "dependencies": {
    "better-sqlite3": "12.6.2",
    "pino": "9.14.0",
    "pino-pretty": "^13.0.0",
    "thread-stream": "^3.0.0",
    "pino-abstract-transport": "^2.0.0",
    "sonic-boom": "^4.0.0",
    "sharp": "^0.33.0",
    "node-pty": "^1.2.0-beta.12"
  }
}
PKGJSON

cd "$STAGING/api"
PATH="$STAGING/node:$PATH" "$NODE_BIN" "$NPM_CLI" install --omit=dev 2>&1 | tail -5

# Install sharp platform binaries
PATH="$STAGING/node:$PATH" "$NODE_BIN" "$NPM_CLI" install --os=darwin --cpu=arm64 @img/sharp-darwin-arm64 @img/sharp-libvips-darwin-arm64 2>&1 | tail -3

# Install pino-roll transport
PATH="$STAGING/node:$PATH" "$NODE_BIN" "$NPM_CLI" install pino-roll 2>&1 | tail -3

# Create stub packages for optional deps not needed in desktop
echo "    Creating stubs for optional packages..."
for pkg in puppeteer "@huggingface/transformers" sqlite-vec onnxruntime-node onnxruntime-web; do
  PKG_DIR="$STAGING/api/node_modules/$pkg"
  rm -rf "$PKG_DIR"
  mkdir -p "$PKG_DIR"
  echo "{\"name\":\"$pkg\",\"version\":\"0.0.0-desktop-stub\",\"main\":\"index.js\"}" > "$PKG_DIR/package.json"
  echo "module.exports = null;" > "$PKG_DIR/index.js"
  echo "    ✓ stub: $pkg"
done

# Create required directories
mkdir -p "$STAGING/uploads" "$STAGING/data/connector-media"

echo "    API total size: $(du -sh "$STAGING/api" | cut -f1)"

# --- Step 4: Create launcher scripts ---
echo ""
echo ">>> Step 4: Launcher scripts"

cat > "$STAGING/launch-web.sh" << 'WEBEOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$DIR/node/node"
export PORT="${FRONTEND_PORT:-13003}"
export HOSTNAME="127.0.0.1"
cd "$DIR/web/packages/web"
exec "$NODE" "$DIR/web/packages/web/server.js"
WEBEOF

cat > "$STAGING/launch-api.sh" << 'APIEOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$DIR/node/node"
export MEMORY_STORE=1
export API_SERVER_PORT="${API_SERVER_PORT:-13004}"
export FRONTEND_PORT="${FRONTEND_PORT:-13003}"
export CAT_CAFE_DESKTOP=1
# Listen on both IPv4 and IPv6 (WebKit resolves localhost to ::1)
export API_SERVER_HOST="::"
# Make agent CLIs (claude, codex) findable
export PATH="$HOME/.cat-cafe/cli/bin:$DIR/node:$PATH"
# Native addons in api/node_modules/ — resolved naturally via cd
cd "$DIR/api"
exec "$NODE" "$DIR/api/index.mjs"
APIEOF

chmod +x "$STAGING/launch-web.sh" "$STAGING/launch-api.sh"

# Copy first-run setup script
cp "$SCRIPT_DIR/first-run-setup.sh" "$STAGING/first-run-setup.sh"
chmod +x "$STAGING/first-run-setup.sh"

# --- Summary ---
echo ""
echo "=== Staging complete ==="
echo "    Total staging size: $(du -sh "$STAGING" | cut -f1)"
echo ""
ls -la "$STAGING/"
echo ""
echo "Next: run 'tauri build' to produce .app"
