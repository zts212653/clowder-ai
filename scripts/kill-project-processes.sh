#!/bin/bash
# Kill all processes related to a specific project directory
# Usage: ./scripts/kill-project-processes.sh <project-path>
# Example: ./scripts/kill-project-processes.sh /home/yuhan/cat-cafe-runtime

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Default project path (can be overridden by argument)
PROJECT_PATH="${1:-/home/yuhan/cat-cafe-runtime}"

# Resolve to absolute path
PROJECT_PATH="$(cd "$PROJECT_PATH" 2>/dev/null && pwd)" || {
    echo -e "${RED}Error: Directory not found: $PROJECT_PATH${NC}" >&2
    exit 1
}

echo -e "${YELLOW}Scanning for processes related to:${NC} $PROJECT_PATH"
echo ""

# Find all processes related to the project directory
# This matches: node, tsx, next, esbuild, pnpm processes that contain the project path
PIDS=$(ps aux | grep -E "(node|tsx|next|esbuild|pnpm)" | grep -E "$PROJECT_PATH" | grep -v grep | awk '{print $2}' || true)

# Also find related child processes that might be in node_modules but not show full path
# Check for processes with CWD in the project
PIDS_CWD=$(for pid in $(ps aux | awk '{print $2}'); do
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
    if [[ "$cwd" == "$PROJECT_PATH"* ]]; then
        echo "$pid"
    fi
done || true)

# Combine and deduplicate PIDs
ALL_PIDS=$(echo "$PIDS $PIDS_CWD" | tr ' ' '\n' | sort -u | grep -v '^$' || true)

if [ -z "$ALL_PIDS" ]; then
    echo -e "${GREEN}No processes found for: $PROJECT_PATH${NC}"
    exit 0
fi

# Count processes
COUNT=$(echo "$ALL_PIDS" | wc -l)

echo -e "${YELLOW}Found $COUNT process(es):${NC}"
echo ""

# Show process details
for pid in $ALL_PIDS; do
    CMD=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || echo "(unknown)")
    # Truncate long commands
    CMD_SHORT="${CMD:0:100}"
    if [ ${#CMD} -gt 100 ]; then
        CMD_SHORT="$CMD_SHORT..."
    fi
    echo -e "  ${RED}PID $pid:${NC} $CMD_SHORT"
done

echo ""
echo -e "${YELLOW}Attempting graceful shutdown (SIGTERM)...${NC}"

# Send SIGTERM first for graceful shutdown
KILLED_COUNT=0
for pid in $ALL_PIDS; do
    if kill -TERM "$pid" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Sent SIGTERM to PID $pid"
        ((KILLED_COUNT++)) || true
    else
        echo -e "  ${YELLOW}⚠${NC} Could not signal PID $pid (already dead?)"
    fi
done

echo ""
echo -e "${YELLOW}Waiting for processes to exit (max 5 seconds)...${NC}"

# Wait for processes to exit
for i in {1..10}; do
    sleep 0.5
    REMAINING=""
    for pid in $ALL_PIDS; do
        if kill -0 "$pid" 2>/dev/null; then
            REMAINING="$REMAINING $pid"
        fi
    done
    ALL_PIDS="$REMAINING"
    if [ -z "$ALL_PIDS" ]; then
        echo -e "${GREEN}All processes exited gracefully.${NC}"
        exit 0
    fi
done

# Force kill any remaining processes
if [ -n "$ALL_PIDS" ]; then
    echo ""
    echo -e "${RED}Some processes did not exit. Forcing with SIGKILL...${NC}"
    for pid in $ALL_PIDS; do
        if kill -KILL "$pid" 2>/dev/null; then
            echo -e "  ${RED}✗${NC} Force killed PID $pid"
        fi
    done
fi

echo ""
echo -e "${GREEN}Done. Killed $KILLED_COUNT process(es).${NC}"
