#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="$PROJECT_DIR/cat-cafe-skills"

if [ ! -d "$SKILLS_DIR" ]; then
    echo -e "${RED}Error: cat-cafe-skills/ not found at $SKILLS_DIR${NC}"
    exit 1
fi

SKILLS=()
for SKILL_PATH in "$SKILLS_DIR"/*/; do
    SKILL_NAME=$(basename "$SKILL_PATH")
    [ "$SKILL_NAME" = "refs" ] && continue
    [ ! -f "$SKILL_PATH/SKILL.md" ] && continue
    SKILLS+=("$SKILL_NAME")
done

TOTAL_SKILLS=${#SKILLS[@]}

if [ "$TOTAL_SKILLS" -eq 0 ]; then
    echo -e "${RED}✗ No valid skills found in $SKILLS_DIR${NC}"
    echo "  (Each skill must have a SKILL.md file)"
    exit 1
fi

echo -e "${BOLD}Cat Café Skills Mount Check${NC}"
echo -e "Source: $SKILLS_DIR"
echo -e "Skills: $TOTAL_SKILLS"
echo ""

PROVIDERS=(
    "$HOME/.claude/skills:Claude"
    "$HOME/.codex/skills:Codex"
    "$HOME/.gemini/skills:Gemini"
)

HAS_ISSUES=false

for ENTRY in "${PROVIDERS[@]}"; do
    PROVIDER_DIR="${ENTRY%%:*}"
    PROVIDER_NAME="${ENTRY##*:}"

    MOUNTED=0
    MISSING=0
    BROKEN=0
    CONFLICTS=0

    echo -e "${CYAN}[$PROVIDER_NAME]${NC} $PROVIDER_DIR"

    if [ ! -d "$PROVIDER_DIR" ]; then
        echo -e "  ${RED}✗${NC} Directory does not exist"
        echo -e "  ${YELLOW}→ Run: pnpm sync:skills${NC}"
        HAS_ISSUES=true
        echo ""
        continue
    fi

    for SKILL_NAME in "${SKILLS[@]}"; do
        TARGET="$PROVIDER_DIR/$SKILL_NAME"
        EXPECTED="$SKILLS_DIR/$SKILL_NAME/"

        if [ -L "$TARGET" ]; then
            ACTUAL=$(readlink "$TARGET")
            if [ "$ACTUAL" = "$EXPECTED" ] || [ "$ACTUAL" = "${EXPECTED%/}" ]; then
                MOUNTED=$((MOUNTED + 1))
            else
                echo -e "  ${YELLOW}↻${NC} $SKILL_NAME → wrong target ($ACTUAL)"
                BROKEN=$((BROKEN + 1))
                HAS_ISSUES=true
            fi
        else
            if [ -e "$TARGET" ]; then
                echo -e "  ${RED}✗${NC} $SKILL_NAME — conflict (non-symlink exists)"
                echo -e "    ${YELLOW}→ Remove manually: rm -rf $TARGET${NC}"
                CONFLICTS=$((CONFLICTS + 1))
            else
                echo -e "  ${RED}✗${NC} $SKILL_NAME — not linked"
                MISSING=$((MISSING + 1))
            fi
            HAS_ISSUES=true
        fi
    done

    if [ $MISSING -eq 0 ] && [ $BROKEN -eq 0 ] && [ $CONFLICTS -eq 0 ]; then
        echo -e "  ${GREEN}✓${NC} All $MOUNTED/$TOTAL_SKILLS skills mounted"
    else
        echo -e "  Mounted: ${GREEN}$MOUNTED${NC}  Missing: ${RED}$MISSING${NC}  Broken: ${YELLOW}$BROKEN${NC}  Conflicts: ${RED}$CONFLICTS${NC}"
    fi
    echo ""
done

echo "──────────────────────────────"
if [ "$HAS_ISSUES" = true ]; then
    echo -e "${RED}Issues found.${NC}"
    echo -e "  Run ${BOLD}pnpm sync:skills${NC} to create missing symlinks."
    echo -e "  For conflicts, remove the blocking path first (see above)."
    exit 1
else
    echo -e "${GREEN}All skills properly mounted across all providers.${NC}"
    exit 0
fi
