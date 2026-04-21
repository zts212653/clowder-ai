#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$PROJECT_DIR/.githooks"

cd "$PROJECT_DIR"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "Missing .githooks directory at $HOOKS_DIR" >&2
  exit 1
fi

for hook in pre-commit pre-rebase; do
  if [ ! -f "$HOOKS_DIR/$hook" ]; then
    echo "Missing hook template: $HOOKS_DIR/$hook" >&2
    exit 1
  fi
  chmod +x "$HOOKS_DIR/$hook"
done

git config core.hooksPath .githooks
git config merge.conflictStyle zdiff3

echo "✓ Installed Git guards"
echo "  - core.hooksPath=.githooks"
echo "  - merge.conflictStyle=zdiff3"
