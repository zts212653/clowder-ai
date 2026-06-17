#!/usr/bin/env bash
# build-mac.sh — Produces macOS DMG installers for Clowder AI.
#
# Mirrors desktop/scripts/build-desktop.ps1 for macOS. Outputs two DMGs
# (arm64 + x64) under dist/:
#   CatCafe-0.10.1-arm64.dmg
#   CatCafe-0.10.1-x64.dmg
#
# Prerequisites on the build machine:
#   - macOS 13+ (Xcode Command Line Tools: xcode-select --install)
#   - pnpm, node (any LTS), bash, curl, tar, make
#   - For x64 Redis on Apple Silicon: Rosetta 2 (softwareupdate --install-rosetta)
#
# Usage:
#   ./desktop/scripts/build-mac.sh                 # full pipeline
#   ./desktop/scripts/build-mac.sh --skip-web      # reuse packages/web/.next
#   ./desktop/scripts/build-mac.sh --skip-deploy   # reuse bundled/deploy/
#   ./desktop/scripts/build-mac.sh --skip-redis    # reuse bundled/redis-darwin-*
#   ./desktop/scripts/build-mac.sh --skip-node     # reuse bundled/node-darwin-*
#   ./desktop/scripts/build-mac.sh --arch arm64    # build single arch only
#
# Signing: electron-builder signing is disabled (identity=null in
# desktop/package.json) to avoid EMFILE with large bundles. Ad-hoc signing
# is applied manually after electron-builder finishes (Step 6b).
# Gatekeeper shows "unidentified developer" instead of "damaged" — users
# right-click → Open on first launch. No Apple Developer account needed.

set -euo pipefail

# ─── Args ───────────────────────────────────────────────────────────────
SKIP_WEB=0
SKIP_DEPLOY=0
SKIP_REDIS=0
SKIP_NODE=0
ARCHS=("arm64" "x64")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-web)    SKIP_WEB=1; shift ;;
    --skip-deploy) SKIP_DEPLOY=1; shift ;;
    --skip-redis)  SKIP_REDIS=1; shift ;;
    --skip-node)   SKIP_NODE=1; shift ;;
    --arch)        ARCHS=("$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

# ─── Paths + helpers ────────────────────────────────────────────────────
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "${SCRIPT_DIR}/../.." && pwd )"
BUNDLED_DIR="${PROJECT_ROOT}/bundled"
DEPLOY_ROOT="${BUNDLED_DIR}/deploy"
DESKTOP_DIR="${PROJECT_ROOT}/desktop"
DIST_DIR="${PROJECT_ROOT}/dist"
ASSETS_DIR="${DESKTOP_DIR}/assets"

bold()  { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
ok()    { printf "  \033[0;32m[OK]\033[0m %s\n" "$*"; }
warn()  { printf "  \033[0;33m[!!]\033[0m %s\n" "$*"; }
err()   { printf "  \033[0;31m[ERR]\033[0m %s\n" "$*" >&2; }
die()   { err "$*"; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "build-mac.sh must run on macOS (detected: $(uname -s))"

# ─── Step 1: Build web app ──────────────────────────────────────────────
bold "Step 1/6 — Build web application"
if [[ $SKIP_WEB -eq 0 ]]; then
  cd "$PROJECT_ROOT"
  if ! pnpm install --frozen-lockfile; then
    warn "frozen-lockfile failed, retrying with pnpm install"
    pnpm install
  fi
  pnpm run build
  ok "Web application built"
else
  ok "Skipped (--skip-web)"
fi

# ─── Step 2: pnpm deploy runtime packages ──────────────────────────────
bold "Step 2/6 — pnpm deploy runtime packages"
if [[ $SKIP_DEPLOY -eq 0 ]]; then
  mkdir -p "$BUNDLED_DIR"
  rm -rf "$DEPLOY_ROOT"
  mkdir -p "$DEPLOY_ROOT"
  cd "$PROJECT_ROOT"
  for pkg in api web mcp-server; do
    echo "  Deploying @cat-cafe/$pkg ..."
    CAT_CAFE_SKIP_NODE_RUNTIME_GUARD=1 \
      pnpm --filter "@cat-cafe/$pkg" --prod --config.node-linker=hoisted deploy "${DEPLOY_ROOT}/${pkg}" \
      || die "pnpm deploy @cat-cafe/$pkg failed"
  done
  # Web's .next build output is outside the package's "files" field,
  # so pnpm deploy doesn't copy it. Inject manually.
  webNextSrc="${PROJECT_ROOT}/packages/web/.next"
  webNextDst="${DEPLOY_ROOT}/web/.next"
  if [[ -d "$webNextSrc" ]]; then
    rm -rf "$webNextDst"
    cp -R "$webNextSrc" "$webNextDst"
    ok "Copied packages/web/.next -> bundled/deploy/web/.next"
  else
    die "packages/web/.next not found — did 'pnpm run build' run?"
  fi
  ok "Deploy artifacts ready under bundled/deploy/"
else
  [[ -d "$DEPLOY_ROOT" ]] || die "bundled/deploy/ missing. Run without --skip-deploy first."
  ok "Skipped (--skip-deploy)"
fi

# ─── Step 3: Bundle Node.js portable (both archs) ──────────────────────
bold "Step 3/6 — Bundle Node.js portable (arm64 + x64)"
# Detect build-machine Node version so native modules (better-sqlite3) ABI
# matches the bundled runtime. Same rationale as the Windows build.
BUILD_NODE_VERSION="$(node --version 2>/dev/null || echo '')"
if [[ -z "$BUILD_NODE_VERSION" ]]; then
  warn "node not on PATH; defaulting to v22.12.0"
  BUILD_NODE_VERSION="v22.12.0"
fi
BUILD_NODE_MAJOR="${BUILD_NODE_VERSION#v}"
BUILD_NODE_MAJOR="${BUILD_NODE_MAJOR%%.*}"
echo "  Build-machine Node: ${BUILD_NODE_VERSION} (major=${BUILD_NODE_MAJOR})"

download_node() {
  local arch="$1"  # arm64 | x64
  local dest="${BUNDLED_DIR}/node-darwin-${arch}"
  if [[ $SKIP_NODE -eq 1 && -x "${dest}/bin/node" ]]; then
    ok "node-darwin-${arch} reused (--skip-node)"
    return
  fi
  if [[ -x "${dest}/bin/node" ]]; then
    local existing; existing="$("${dest}/bin/node" --version 2>/dev/null || echo '')"
    local existing_major="${existing#v}"; existing_major="${existing_major%%.*}"
    if [[ "$existing_major" == "$BUILD_NODE_MAJOR" ]]; then
      ok "node-darwin-${arch} already present (${existing})"
      return
    fi
    warn "node-darwin-${arch} version ${existing} != build ${BUILD_NODE_VERSION}, re-downloading"
    rm -rf "$dest"
  fi
  mkdir -p "$dest"
  local archive="node-${BUILD_NODE_VERSION}-darwin-${arch}"
  local url="https://nodejs.org/dist/${BUILD_NODE_VERSION}/${archive}.tar.gz"
  echo "  Downloading ${archive} ..."
  curl -fsSL "$url" | tar xz -C "$dest" --strip-components=1 || die "Node ${arch} download failed"
  [[ -x "${dest}/bin/node" ]] || die "node binary missing in ${dest} after extract"
  ok "node-darwin-${arch} bundled"
}

for arch in "${ARCHS[@]}"; do
  download_node "$arch"
done

# ─── Step 4: Build Redis portable (both archs) ─────────────────────────
bold "Step 4/6 — Build Redis portable from source"
# No official pre-compiled macOS binary exists for Redis. We compile from
# source (~30s per arch on modern Mac). For the non-native arch we use
# `arch -x86_64` (requires Rosetta 2 on Apple Silicon hosts).
REDIS_VERSION="7.4.1"
REDIS_URL="https://download.redis.io/releases/redis-${REDIS_VERSION}.tar.gz"

build_redis() {
  local arch="$1"  # arm64 | x64
  local out="${BUNDLED_DIR}/redis-darwin-${arch}"
  if [[ $SKIP_REDIS -eq 1 && -x "${out}/redis-server" ]]; then
    ok "redis-darwin-${arch} reused (--skip-redis)"
    return
  fi
  if [[ -x "${out}/redis-server" ]]; then
    ok "redis-darwin-${arch} already present (${REDIS_VERSION})"
    return
  fi
  local host_arch; host_arch="$(uname -m)"  # arm64 | x86_64
  local need_rosetta=0
  if [[ "$arch" == "x64" && "$host_arch" == "arm64" ]]; then
    need_rosetta=1
    if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
      warn "Rosetta 2 not installed; skipping x64 Redis. Run: softwareupdate --install-rosetta"
      return
    fi
  fi
  mkdir -p "$out"
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  echo "  Downloading redis ${REDIS_VERSION} source ..."
  curl -fsSL "$REDIS_URL" | tar xz -C "$tmp" --strip-components=1 || die "Redis source download failed"
  echo "  Compiling redis for ${arch} ..."
  local jobs; jobs="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
  local make_prefix=""
  if [[ $need_rosetta -eq 1 ]]; then make_prefix="arch -x86_64"; fi
  ( cd "$tmp" && $make_prefix make distclean >/dev/null 2>&1 || true )
  ( cd "$tmp" && $make_prefix make -j"$jobs" BUILD_TLS=no USE_SYSTEMD=no ) || die "Redis build for ${arch} failed"
  cp "$tmp/src/redis-server" "$tmp/src/redis-cli" "$out/"
  chmod +x "${out}/redis-server" "${out}/redis-cli"
  ok "redis-darwin-${arch} built (${REDIS_VERSION})"
}

for arch in "${ARCHS[@]}"; do
  build_redis "$arch"
done

# ─── Step 5: (macOS skips CLI tarball bundling) ──────────────────────────
bold "Step 5/6 — CLI tools (skipped on macOS)"
# macOS DMG has no post-install execution phase (unlike Windows Inno Setup),
# so bundling CLI tarballs (claude, codex) would just waste ~60 MB in the DMG
# without ever being installed. macOS users install CLIs via Homebrew / npm /
# official installers. Windows build-desktop.ps1 handles CLI bundling separately.
ok "Skipped — macOS DMG does not auto-install CLI tools"

# ─── Step 6a: Generate icon.icns from icon.png (one-time) ──────────────
bold "Step 6/6 — Assets + electron-builder"
ICNS="${ASSETS_DIR}/icon.icns"
PNG="${ASSETS_DIR}/icon.png"
if [[ ! -f "$ICNS" ]]; then
  [[ -f "$PNG" ]] || die "assets/icon.png missing — cannot generate icon.icns"
  echo "  Generating icon.icns from icon.png ..."
  iconset="$(mktemp -d)/icon.iconset"
  mkdir -p "$iconset"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$PNG" --out "${iconset}/icon_${s}x${s}.png" >/dev/null
    sips -z "$((s*2))" "$((s*2))" "$PNG" --out "${iconset}/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$ICNS"
  rm -rf "$(dirname "$iconset")"
  ok "icon.icns generated"
else
  ok "icon.icns already present"
fi

# ─── Step 6b: electron-builder + hdiutil — produces DMG per arch ──────
cd "$DESKTOP_DIR"
  if [[ ! -d node_modules ]]; then
    echo "  Installing desktop dependencies ..."
    npm install --include=dev || die "npm install failed in desktop/"
  fi

# electron-builder writes into desktop/dist/. Force a clean output dir.
rm -rf "${DESKTOP_DIR}/dist"

# Build .app bundles only (--dir). electron-builder's built-in dmgbuild
# under-allocates disk image size when afterPack injects large node_modules,
# causing "No space left on device". We create DMGs ourselves via hdiutil.
EB_ARGS=("--mac" "dir")
for arch in "${ARCHS[@]}"; do
  EB_ARGS+=("--$arch")
done
echo "  Running: npx electron-builder ${EB_ARGS[*]}"
npx electron-builder "${EB_ARGS[@]}" || die "electron-builder failed"

# Ad-hoc sign each .app bundle AFTER electron-builder finishes.
# electron-builder's built-in signing (identity="-") opens every file in
# the bundle simultaneously, hitting EMFILE when afterPack injects 3 full
# node_modules trees (~10k+ files). Setting identity=null in package.json
# skips EB's signing; we sign here with codesign --deep, which handles its
# own file-descriptor management and never hits EMFILE.
# Ad-hoc signing changes "damaged" → "unidentified developer" on macOS
# Gatekeeper — users right-click → Open on first launch.
for arch in "${ARCHS[@]}"; do
  case "$arch" in
    arm64) app_dir="${DESKTOP_DIR}/dist/mac-arm64" ;;
    x64) app_dir="${DESKTOP_DIR}/dist/mac" ;;
    *) continue ;;
  esac
  app_bundle="${app_dir}/Clowder AI.app"
  if [[ -d "$app_bundle" ]]; then
    echo "  Ad-hoc signing ${arch} bundle ..."
    codesign -s - --deep --force "$app_bundle" || die "codesign ${arch} failed"
    # --strict rejects symlinks inside the bundle (scripts/node_modules →
    # ../packages/api/node_modules), so use basic --deep verification only.
    codesign --verify --deep "$app_bundle" || die "codesign verify ${arch} failed"
    ok "Ad-hoc signed and verified ${arch}"
  fi
done

# Create DMGs from .app bundles using hdiutil (handles large bundles reliably).
# Each DMG contains the .app plus an /Applications symlink so users can
# drag-to-install instead of accidentally running from the mounted volume.
mkdir -p "$DIST_DIR"
VERSION="$(node -p "require('./package.json').version")"
for arch in "${ARCHS[@]}"; do
  case "$arch" in
    arm64) app_dir="${DESKTOP_DIR}/dist/mac-arm64" ;;
    x64) app_dir="${DESKTOP_DIR}/dist/mac" ;;
    *) die "Unsupported macOS arch: ${arch}" ;;
  esac
  dmg_name="CatCafe-${VERSION}-${arch}.dmg"
  dmg_out="${DIST_DIR}/${dmg_name}"
  if [[ ! -d "$app_dir" ]]; then
    die "Expected app bundle directory not found for ${arch}: ${app_dir}"
  fi
  # Stage .app + /Applications symlink in a temp directory for the DMG.
  dmg_staging="$(mktemp -d)"
  cp -R "${app_dir}/Clowder AI.app" "$dmg_staging/"
  ln -s /Applications "$dmg_staging/Applications"
  echo "  Creating ${dmg_name} via hdiutil ..."
  rm -f "$dmg_out"
  hdiutil create -volname "Clowder AI" -srcfolder "$dmg_staging" -ov -format UDZO "$dmg_out" \
    || die "hdiutil create failed for ${arch}"
  rm -rf "$dmg_staging"
  ok "Created ${dmg_name}"
done

echo ""
echo "  ========================================"
echo "  Installer(s) ready!"
for dmg in "${DIST_DIR}"/CatCafe-*-*.dmg; do
  [[ -f "$dmg" ]] || continue
  size_mb="$(stat -f "%z" "$dmg" 2>/dev/null | awk '{printf "%.2f", $1/1024/1024}')"
  echo "  $(basename "$dmg")  (${size_mb} MB)"
done
echo ""
echo "  First-launch (ad-hoc signed): right-click the app → Open"
echo "  ========================================"
