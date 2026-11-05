#!/bin/bash
# sop-stage-bookmark.sh — F073 SOP Auto-Guardian
# Hook: PostToolUse (matcher: "Skill")
# Records which skill was loaded → tracks SOP stage for post-compact recovery.
#
# F073 P4 (AC-14): Calls shared HTTP API to store bookmark.
# Falls back to /tmp/ file when API is unreachable (AC-17 degradation).

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty')

# Extract skill name from tool input
SKILL_NAME=$(echo "$TOOL_INPUT" | jq -r '.skill // empty')

if [ -z "$SKILL_NAME" ] || [ "$SKILL_NAME" = "null" ]; then
  exit 0
fi

# Map skill to SOP stage (based on manifest development chain)
case "$SKILL_NAME" in
  feat-lifecycle)     SOP_STAGE="lifecycle" ;;
  writing-plans)      SOP_STAGE="planning" ;;
  worktree)           SOP_STAGE="worktree" ;;
  tdd)                SOP_STAGE="development" ;;
  debugging)          SOP_STAGE="debugging" ;;
  quality-gate)       SOP_STAGE="quality-gate" ;;
  request-review)     SOP_STAGE="review-request" ;;
  receive-review)     SOP_STAGE="review-response" ;;
  merge-gate)         SOP_STAGE="merge" ;;
  cross-cat-handoff)  SOP_STAGE="handoff" ;;
  *)                  SOP_STAGE="other:${SKILL_NAME}" ;;
esac

# F073 P4 (AC-14): Bounded best-effort callback through the installed carrier.
SCRIPT_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd) || exit 1
jq -n --arg sid "$SESSION_ID" --arg skill "$SKILL_NAME" --arg stage "$SOP_STAGE" \
  '{session_id: $sid, skill: $skill, sopStage: $stage}' | \
  node "$SCRIPT_ROOT/.claude/hooks/f24-compaction.mjs" sop-set >/dev/null 2>&1 || true

# AC-17 dual-write: always write /tmp/ file as degradation safety net.
# Even when API succeeds, local copy ensures recovery if API is unavailable at read time.
STAGE_FILE="/tmp/cat-cafe-sop-stage-${SESSION_ID}.json"
jq -n \
  --arg skill "$SKILL_NAME" \
  --arg stage "$SOP_STAGE" \
  --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{skill: $skill, sopStage: $stage, recordedAt: $time}' \
  > "$STAGE_FILE"

exit 0
