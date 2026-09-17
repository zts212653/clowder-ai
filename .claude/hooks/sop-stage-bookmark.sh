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

# F073 P4 (AC-14): Try shared HTTP API (best-effort, fire-and-forget)
API_PORT="${API_SERVER_PORT:-3004}"
INVOCATION_ID="${CAT_CAFE_INVOCATION_ID:-}"
CALLBACK_TOKEN="${CAT_CAFE_CALLBACK_TOKEN:-}"

if [ -n "$INVOCATION_ID" ] && [ -n "$CALLBACK_TOKEN" ]; then
  curl -sf -o /dev/null \
    -X POST "http://localhost:${API_PORT}/api/sessions/sop-bookmark" \
    -H "Content-Type: application/json" \
    -H "X-Invocation-Id: ${INVOCATION_ID}" \
    -H "X-Callback-Token: ${CALLBACK_TOKEN}" \
    -d "{\"cliSessionId\": \"$SESSION_ID\", \"skill\": \"$SKILL_NAME\", \"sopStage\": \"$SOP_STAGE\"}" \
    --connect-timeout 2 --max-time 5 2>/dev/null || true
fi

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
