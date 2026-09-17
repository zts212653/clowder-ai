#!/bin/bash
# f24-pre-compact.sh — F24 Session Blindness Fix, Layer 1
# Hook: PreCompact (matcher: "manual|auto")
# Runs BEFORE Claude Code SDK context compression.
#
# Actions:
# 1. Call Clowder AI API to seal the F24 session (best-effort)
# 2. Save compact state file for SessionStart hook to consume
# 3. Write recent-compact marker for PreToolUse guard
# 4. Return systemMessage warning

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
TRIGGER=$(echo "$INPUT" | jq -r '.trigger')

# F073 diagnostic logging
LOG_FILE="/tmp/cat-cafe-hook-diagnostic.log"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] pre-compact fired, session=$SESSION_ID, trigger=$TRIGGER" >> "$LOG_FILE"

API_PORT="${API_SERVER_PORT:-3004}"
INVOCATION_ID="${CAT_CAFE_INVOCATION_ID:-}"
CALLBACK_TOKEN="${CAT_CAFE_CALLBACK_TOKEN:-}"

# 1. Seal the F24 session via Clowder AI API
SEAL_HTTP_CODE=$(curl -sf --max-time 5 -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:${API_PORT}/api/sessions/seal" \
  -H "Content-Type: application/json" \
  -H "X-Invocation-Id: ${INVOCATION_ID}" \
  -H "X-Callback-Token: ${CALLBACK_TOKEN}" \
  -d "{\"cliSessionId\": \"$SESSION_ID\", \"reason\": \"claude-code-compact-$TRIGGER\"}")
SEAL_EXIT=$?

if [ "$SEAL_EXIT" -ne 0 ] || [ "$SEAL_HTTP_CODE" -lt 200 ] || [ "$SEAL_HTTP_CODE" -ge 300 ]; then
  SEAL_WARNING="F24 seal failed (exit=$SEAL_EXIT, HTTP $SEAL_HTTP_CODE). Session history may not be saved."
else
  SEAL_WARNING=""
fi

# 2. Save compact state file (session_id isolated)
STATE_FILE="/tmp/cat-cafe-opus-compact-state-${SESSION_ID}.json"
jq -n \
  --arg sid "$SESSION_ID" \
  --arg trigger "$TRIGGER" \
  --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg sealStatus "${SEAL_WARNING:-ok}" \
  '{sessionId: $sid, trigger: $trigger, compactedAt: $time, sealStatus: $sealStatus}' \
  > "$STATE_FILE"

# 3. Write recent-compact marker (for PreToolUse guard, session_id isolated)
MARKER_FILE="/tmp/cat-cafe-opus-recent-compact-${SESSION_ID}.marker"
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER_FILE"

# 4. Return systemMessage
WARNING_PREFIX=""
if [ -n "$SEAL_WARNING" ]; then
  WARNING_PREFIX="WARNING: ${SEAL_WARNING} | "
fi

jq -n --arg msg "${WARNING_PREFIX}Context is about to be compressed. F24 has saved session state. After compression, verify critical context is intact." \
  '{systemMessage: $msg}'
