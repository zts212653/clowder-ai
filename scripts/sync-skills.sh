#!/bin/bash

# ============================================================
# Sync Cat Café Skills — Create user-level symlinks
# 同步猫猫咖啡技能 — 创建用户级 symlink
#
# Creates symlinks from ~/.{claude,codex,gemini}/skills/
# to the project's cat-cafe-skills/ source directory.
#
# Per ADR-009: each skill gets its own symlink (no directory-level link).
#
# Usage: ./scripts/sync-skills.sh [--dry-run]
# Exit code: 0 = all ok, 1 = conflicts found
# ============================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="$PROJECT_DIR/cat-cafe-skills"

DRY_RUN=false
if [ "$1" = "--dry-run" ]; then
    DRY_RUN=true
    echo -e "${YELLOW}[dry-run] No changes will be made${NC}"
    echo ""
fi

if [ ! -d "$SKILLS_DIR" ]; then
    echo -e "${RED}Error: cat-cafe-skills/ not found at $SKILLS_DIR${NC}"
    exit 1
fi

# Provider skill directories (user-level)
PROVIDERS=(
    "$HOME/.claude/skills"
    "$HOME/.codex/skills"
    "$HOME/.gemini/skills"
)

# Directories to skip (not skills)
SKIP_DIRS="refs"

TOTAL_CREATED=0
TOTAL_SKIPPED=0
TOTAL_UPDATED=0
TOTAL_CONFLICTS=0

for PROVIDER_DIR in "${PROVIDERS[@]}"; do
    PROVIDER_NAME=$(basename "$(dirname "$PROVIDER_DIR")")
    echo -e "${CYAN}[$PROVIDER_NAME]${NC} → $PROVIDER_DIR"

    if [ "$DRY_RUN" = false ]; then
        mkdir -p "$PROVIDER_DIR"
    fi

    for SKILL_PATH in "$SKILLS_DIR"/*/; do
        SKILL_NAME=$(basename "$SKILL_PATH")

        # Skip non-skill directories
        if echo "$SKIP_DIRS" | grep -qw "$SKILL_NAME"; then
            continue
        fi

        # Skip if no SKILL.md (not a real skill)
        if [ ! -f "$SKILL_PATH/SKILL.md" ]; then
            continue
        fi

        TARGET="$PROVIDER_DIR/$SKILL_NAME"

        if [ -L "$TARGET" ]; then
            # Symlink exists — check if it points to the right place
            CURRENT=$(readlink "$TARGET")
            if [ "$CURRENT" = "$SKILL_PATH" ] || [ "$CURRENT" = "${SKILL_PATH%/}" ]; then
                echo -e "  ${GREEN}✓${NC} $SKILL_NAME (already linked)"
                TOTAL_SKIPPED=$((TOTAL_SKIPPED + 1))
            else
                # Points elsewhere — update it
                if [ "$DRY_RUN" = false ]; then
                    ln -sf "$SKILL_PATH" "$TARGET"
                fi
                echo -e "  ${YELLOW}↻${NC} $SKILL_NAME (updated: was → $CURRENT)"
                TOTAL_UPDATED=$((TOTAL_UPDATED + 1))
            fi
        elif [ -e "$TARGET" ]; then
            # Non-symlink file/dir exists — don't overwrite
            echo -e "  ${RED}✗${NC} $SKILL_NAME (conflict: non-symlink exists at $TARGET)"
            echo -e "    ${YELLOW}→ Remove manually: rm -rf $TARGET${NC}"
            TOTAL_CONFLICTS=$((TOTAL_CONFLICTS + 1))
        else
            # Create new symlink
            if [ "$DRY_RUN" = false ]; then
                ln -s "$SKILL_PATH" "$TARGET"
            fi
            echo -e "  ${GREEN}+${NC} $SKILL_NAME"
            TOTAL_CREATED=$((TOTAL_CREATED + 1))
        fi
    done

    echo ""
done

echo "──────────────────────────────"
echo -e "Created: ${GREEN}$TOTAL_CREATED${NC}  Updated: ${YELLOW}$TOTAL_UPDATED${NC}  Unchanged: $TOTAL_SKIPPED  Conflicts: ${RED}$TOTAL_CONFLICTS${NC}"

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}[dry-run] Re-run without --dry-run to apply.${NC}"
fi

if [ "$TOTAL_CONFLICTS" -gt 0 ]; then
    echo -e "${RED}$TOTAL_CONFLICTS conflict(s) found. Remove conflicting paths and re-run.${NC}"
    exit 1
fi
