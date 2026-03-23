#!/bin/bash
# Quick kill script for cat-cafe-runtime processes
# Usage: ./scripts/kill-all.sh

PROJECT="/home/yuhan/cat-cafe-runtime"
PROJECT_NAME="cat-cafe-runtime"

echo "🔍 Finding $PROJECT_NAME processes..."

# Find PIDs by cmdline (most reliable)
PIDS=$(ps aux | grep -E "(node|tsx|next|esbuild)" | grep "$PROJECT" | grep -v grep | awk '{print $2}' || true)

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
