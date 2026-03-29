#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$DIR/node/node"
export PORT="${FRONTEND_PORT:-13003}"
export HOSTNAME="127.0.0.1"
cd "$DIR/web/packages/web"
exec "$NODE" "$DIR/web/packages/web/server.js"
