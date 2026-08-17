---
title: OpenCode + DeepSeek no-output recovery
status: external-review
issue: https://github.com/zts212653/clowder-ai/issues/1341
pr: https://github.com/zts212653/clowder-ai/pull/1342
created: 2026-08-12
---

# OpenCode + DeepSeek no-output recovery

## Summary

OpenCode + DeepSeek had two observed "no visible final answer" shapes. They share one root cause: the provider adapter treated CLI/tool completion as turn completion without verifying that the user-visible final assistant text had actually been produced.

This is not a DeepSeek capability failure. The missing piece is a completion-state check in `OpenCodeAgentService`.

## Phenotype A: pure silent completion

Observed shape:

1. OpenCode stdout emitted `step_start`.
2. stdout emitted no `text` and no `error`.
3. The assistant answer was still present in OpenCode local SQLite state.

Direct local evidence:

- The NDJSON sample contained only `type: "step_start"`.
- The `step_start.part` payload carried both `sessionID` and `messageID`.
- Querying OpenCode SQLite table `part` by that `sessionID + messageID` returned the assistant `text` part.

Recovery rule:

- When a completed OpenCode run has events but no text, no error, and no tool use, use the `step_start` `sessionID + messageID` as a read-only anchor into OpenCode SQLite.
- If assistant text is found, emit it as the visible response and do not surface `silent_completion`.
- If no text is found or SQLite is unavailable, preserve the existing `silent_completion` diagnostic path.

## Phenotype B: post-tool gap

Observed shape:

1. OpenCode emitted a short prelude text, for example "I will check the actual config first."
2. OpenCode emitted `tool_use`; the tool completed and had output.
3. The run ended without a final assistant `text` after the tool.

Teammate reproduction confirmation:

- Ragdoll/OpenCode + DeepSeek observed the event sequence `text -> tool_use -> step_finish/end` with no final text.
- The frontend therefore showed only the incomplete prelude or appeared to have no useful output.

Why the old logic missed it:

- `textEventCount > 0` made the turn look like it had user-visible text.
- `toolUseEmitted = true` correctly suppressed the older `silent_completion` warning for pure tool-only turns.
- The adapter did not compare event order, so it missed the specific case where the last meaningful event was a tool and no later text existed.

Recovery rule:

- At normal CLI completion, detect `textEventCount > 0 && lastToolEventIndex > lastTextEventIndex && !errorAlreadyYielded`.
- Run exactly one no-tool finalizer in the same OpenCode session using a dedicated `cat-cafe-no-tool-finalizer` agent.
- Deny all tools in the finalizer config. The finalizer may use only existing session state and a sanitized latest-tool-output summary.
- Emit the first finalizer text with `textMode: "replace"` so it replaces the incomplete prelude.
- If the finalizer produces no text or attempts a tool, emit a deterministic diagnostic fallback with the sanitized latest-tool-output summary.

## Non-goals and safety boundaries

- Do not rerun the whole OpenCode turn. A full rerun can repeat tool side effects.
- Do not use word-count thresholds to decide whether a prelude is "too short." The stable signal is event order: last meaningful event is tool and no later text.
- Do not mark pure `tool_use` completions as silent failures. Existing AC-G3 behavior remains valid.
- Do not hide real provider or CLI errors behind no-output recovery. Error paths continue to surface their original diagnostics.
- Do not invent semantic conclusions if the finalizer cannot produce text. Fall back to an explicit recovery diagnostic.

## Root cause

The adapter had a completion判定缺口:

- "A tool finished" is not the same as "the assistant finished its answer."
- "Some text appeared earlier" is not the same as "the final answer appeared after the last tool."
- "No stdout text" is not always "no answer exists," because OpenCode may have persisted the answer in its local SQLite session state.

The correct completion contract is:

1. If stdout contains final text after the last tool, stream it normally.
2. If stdout has no text but OpenCode persisted text for the current `sessionID + messageID`, recover that persisted text.
3. If stdout has prelude text, then a tool, then no final text, perform a single no-tool finalizer pass and replace the prelude.
4. If recovery cannot produce text, preserve explicit diagnostics instead of silently ending.

## Implementation

Code paths:

- `packages/api/src/domains/cats/services/agents/providers/OpenCodeAgentService.ts`
- `packages/api/src/domains/cats/services/agents/providers/opencode-recovery.ts`

- Tracks `lastTextEventIndex`, `lastToolEventIndex`, latest tool trace, and latest `step_start` message reference.
- Adds read-only SQLite recovery for phenotype A using `part.session_id + part.message_id`.
- Resolves OpenCode SQLite through an explicit override test seam, canonical `OPENCODE_DB`, XDG/platform data roots, and channel-named `opencode*.db` files.
- Adds a no-tool finalizer for phenotype B using `--session` and `--agent cat-cafe-no-tool-finalizer`.
- Denies all finalizer tool permissions through `OPENCODE_CONFIG_CONTENT` and treats any observed finalizer `tool_use` as a poisoned finalizer result.
- Buffers finalizer text until the finalizer completes without tool/error poison, then emits the first text with `textMode: "replace"`.
- Uses one central safe projector for latest tool output before including it in the finalizer prompt or deterministic fallback.
- Preserves deterministic fallback text only for finalizer failure, with secrets and absolute paths redacted.
- Serializes invocations for the same OpenCode session so a second turn cannot race a first turn's finalization window.

Regression tests:

- `packages/api/test/opencode-agent-service.test.js`
- `packages/api/test/opencode-recovery.test.js`

- Adds a red/green SQLite recovery case for `step_start`-only NDJSON.
- Updates the post-tool gap case to require a second no-tool finalizer invocation, session resume, deny-all permissions, and `textMode: "replace"`.
- Adds fail-closed finalizer poisoning, sanitized fallback, and same-session single-flight regression cases.
- Adds SQLite path-resolution, schema-drift, malformed-part, multi-part, and redaction tests at the recovery boundary.
- Keeps the older AC-G3 cases for true silent diagnostics and pure tool-only completion.

## Verification

Red evidence before the SQLite recovery implementation:

```text
node --import ./packages/api/test/helpers/setup-cat-registry.js --test --test-name-pattern "step_start-only NDJSON recovers" packages/api/test/opencode-agent-service.test.js
FAIL: expected "Recovered from OpenCode SQLite.", actual undefined
```

Green verification after the fix:

```text
pnpm --dir packages/api run build
node --import ./packages/api/test/helpers/setup-cat-registry.js --test --test-name-pattern "step_start-only NDJSON recovers" packages/api/test/opencode-agent-service.test.js
node --import ./packages/api/test/helpers/setup-cat-registry.js --test --test-name-pattern "post-tool completion gap" packages/api/test/opencode-agent-service.test.js
node --import ./packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/opencode-agent-service.test.js
```

Results:

- `packages/api` build passed.
- Target SQLite recovery test passed.
- Target post-tool finalizer test passed.
- Full `opencode-agent-service.test.js` passed: 41/41.
