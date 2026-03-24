#!/bin/bash
# Quick kill script for project processes
# Usage: ./scripts/kill-all.sh [project-path]
#
# Automatically detects project root if run from scripts/ directory,
# or accepts an optional project path argument.

set -euo pipefail

# Auto-detect project root (script is in scripts/ subdirectory)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Extract project name from directory name
PROJECT_NAME="$(basename "$PROJECT")"

echo "🔍 Finding $PROJECT_NAME processes..."
echo "   Project path: $PROJECT"
echo ""

# Find PIDs by cmdline (most reliable)
# Use -F for fixed string matching to handle special characters in paths
PIDS=$(ps aux | grep -E "(node|tsx|next|esbuild)" | grep -F "$PROJECT" | grep -v grep | awk '{print $2}' || true)

# Also check by cwd (catches subprocesses)
for pid in $(ps aux | awk '{print $2}'); do
    if [ -d "/proc/$pid" ]; then
        cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
        if [[ "$cwd" == "$PROJECT"* ]]; then
            PIDS="$PIDS $pid"
        fi
    fi
done

PIDS=$(echo "$PIDS" | tr ' ' '\n' | sort -u | grep -v '^$' || true)

if [ -z "$PIDS" ]; then
    echo "✅ No $PROJECT_NAME processes found"
    exit 0
fi

COUNT=$(echo "$PIDS" | wc -l)
echo "🔪 Found $COUNT process(es): $PIDS"
echo ""
echo "Killing..."

for pid in $PIDS; do
    kill "$pid" 2>/dev/null && echo "  ✓ Killed PID $pid" || echo "  ✗ Failed to kill PID $pid"
done

echo ""
echo "✅ Done"
