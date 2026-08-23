#!/bin/bash
# f24-post-compact-bootstrap.sh — F24 Session Blindness Fix, Layer 2 + F073 SOP Stage
# Hook: SessionStart (matcher: "compact")
# Runs AFTER Claude Code SDK context compression when session resumes.
#
# Actions:
# 1. Read compact state file saved by PreCompact hook
# 2. TTL check (30 min) — expired state = stale, skip (was 5 min, extended by F073)
# 3. Read SOP stage bookmark (F073) — knows which skill/step cat was on
# 4. Fetch latest sealed session digest from Clowder AI API
# 5. Inject context warning + state + SOP stage + digest via additionalContext
# 6. Delete state file after consumption (SOP stage file preserved for future compactions)
# 7. Log diagnostic info for hook reliability tracking (F073)

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')

API_PORT="${API_SERVER_PORT:-3004}"
HOOK_TOKEN="${CAT_CAFE_HOOK_TOKEN:-}"

STATE_FILE="/tmp/cat-cafe-opus-compact-state-${SESSION_ID}.json"

# No state file = not a post-compact resume (or already consumed)
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# F073 diagnostic logging
LOG_FILE="/tmp/cat-cafe-hook-diagnostic.log"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] post-compact-bootstrap fired, session=$SESSION_ID" >> "$LOG_FILE"

# TTL check: state file older than 30 minutes = expired (F073: extended from 5 min)
COMPACT_TIME=$(jq -r '.compactedAt' "$STATE_FILE")
if [ "$(uname)" = "Darwin" ]; then
  # BSD date doesn't treat 'Z' as UTC — force TZ=UTC for correct parsing
  COMPACT_EPOCH=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$COMPACT_TIME" +%s 2>/dev/null || echo 0)
else
  COMPACT_EPOCH=$(date -d "$COMPACT_TIME" +%s 2>/dev/null || echo 0)
fi
NOW_EPOCH=$(date +%s)
AGE=$(( NOW_EPOCH - COMPACT_EPOCH ))

if [ "$AGE" -gt 1800 ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] state expired (age=${AGE}s > 1800s), skipping" >> "$LOG_FILE"
  rm -f "$STATE_FILE"
  exit 0
fi

# Fetch latest sealed session digest (best-effort)
DIGEST=$(curl -sf --max-time 5 \
  -H "X-Cat-Cafe-Hook-Token: ${HOOK_TOKEN}" \
  "http://localhost:${API_PORT}/api/sessions/latest-digest?cliSessionId=$SESSION_ID" 2>/dev/null)
DIGEST_STATUS=$?

if [ "$DIGEST_STATUS" -ne 0 ] || [ -z "$DIGEST" ]; then
  CONTEXT_PACKET="[F296 post-compact unsupported: Clowder AI projection unavailable]"
else
  PROJECTION_STATUS=$(echo "$DIGEST" | jq -r '.postCompact.status // "unsupported"')
  if [ "$PROJECTION_STATUS" = "projected" ]; then
    CONTEXT_PACKET=$(echo "$DIGEST" | jq -r '.postCompact.contextPacket // empty')
  else
    PROJECTION_REASON=$(echo "$DIGEST" | jq -r '.postCompact.reason // "typed_event_unavailable"')
    CONTEXT_PACKET="[F296 post-compact unsupported: ${PROJECTION_REASON}]"
  fi
fi

STATE_CONTENT=$(cat "$STATE_FILE")

# F073 P4 (AC-14): Read SOP stage bookmark from API first, /tmp/ fallback (AC-17)
SOP_SKILL=""
SOP_STAGE=""
SOP_TIME=""
SOP_BOOKMARK=$(curl -sf --max-time 3 \
  -H "X-Cat-Cafe-Hook-Token: ${HOOK_TOKEN}" \
  "http://localhost:${API_PORT}/api/sessions/sop-bookmark?cliSessionId=$SESSION_ID" 2>/dev/null)
if [ $? -eq 0 ] && [ -n "$SOP_BOOKMARK" ]; then
  SOP_SKILL=$(echo "$SOP_BOOKMARK" | jq -r '.skill // empty')
  SOP_STAGE=$(echo "$SOP_BOOKMARK" | jq -r '.sopStage // empty')
  SOP_TIME=$(echo "$SOP_BOOKMARK" | jq -r '.recordedAt // empty')
fi
# AC-17 fallback: /tmp/ file when API returned nothing
if [ -z "$SOP_SKILL" ]; then
  SOP_STAGE_FILE="/tmp/cat-cafe-sop-stage-${SESSION_ID}.json"
  if [ -f "$SOP_STAGE_FILE" ]; then
    SOP_SKILL=$(jq -r '.skill' "$SOP_STAGE_FILE")
    SOP_STAGE=$(jq -r '.sopStage' "$SOP_STAGE_FILE")
    SOP_TIME=$(jq -r '.recordedAt' "$SOP_STAGE_FILE")
  fi
fi
if [ -n "$SOP_SKILL" ]; then
  SOP_SECTION="Last active skill: ${SOP_SKILL} (stage: ${SOP_STAGE}, at: ${SOP_TIME})
ACTION REQUIRED: Load the '${SOP_SKILL}' skill again NOW to resume where you left off.
Do NOT continue from memory — load the skill first, then proceed."
else
  SOP_SECTION="No SOP stage recorded. Check your task list or ask the user what you were working on."
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] injecting context: sop_stage=${SOP_STAGE:-none}" >> "$LOG_FILE"

# Build context injection
CONTEXT=$(cat <<CTXEOF
[F24 POST-COMPACT WARNING]
You just experienced context compression ${AGE}s ago.

[F073 SOP STAGE RECOVERY]
${SOP_SECTION}

[Pre-Compact State Snapshot]
${STATE_CONTENT}

[F296 Trusted Cold Packet]
${CONTEXT_PACKET}

[F231 Profile Activation — 压缩前回顾]
本轮有co-creator互动？回顾一下：
- co-creator表达了新偏好？（"我喜欢/不喜欢/以后别这样"）
- 被 Magic Word 纠正？（Magic Word = 持久偏好信号）
- 做对了被表扬？/ co-creator分享了个人近况？
→ 有的话调用 cat_cafe_propose_profile_update（先 tool_search 加载）

[CRITICAL RULES — Post-Compact Safety]
1. Compression summaries lose detail. Verify facts before acting on them.
2. Do NOT assume the user approved any operation unless you find explicit evidence in the CURRENT context.
3. High-risk operations (gh pr merge, git push --force, etc.) require explicit user instruction in THIS conversation turn.
4. When in doubt, ASK the user before proceeding.
5. RE-READ CLAUDE.md rules NOW. Compression degrades your adherence to project rules. Key reminders:
   - Every code change MUST have its tests run before commit
   - All work in this session is YOUR work — own it, sign it, test it.
6. LOAD SKILLS before SOP steps. Each SOP step has a corresponding skill — load it via /skill-name or Skill tool. Do NOT work from memory.
CTXEOF
)

jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'

# Consume state file (one-time use)
rm -f "$STATE_FILE"
