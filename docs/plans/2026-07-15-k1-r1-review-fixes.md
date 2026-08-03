---
feature_ids: [F288]
topics: [plugin-messaging, contract-parity, snapshot-consistency, capability-handles]
doc_kind: implementation-plan
created: 2026-07-15
---

# K-1 R1 Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close Terra R1's three P1 findings without weakening K-1's existing Redis owner-token, append CAS, or event-retention guarantees.

**Architecture:** Make append authority flow through a persisted message-handle record derived from the original address handle; make snapshot consistency observable by persisting the latest fully-emitted output revision/sequence in the canonical plugin-message extra; make the handwritten candidate mirror reject every input that C-1's JSON Schema rejects. Snapshot uses a stable two-head fence plus the persisted output watermark and scans the complete thread, so it neither includes state beyond `resumeSequence` nor advances past omitted state.

**Tech Stack:** TypeScript, Node test runner, in-memory/Redis message stores, Redis-backed messaging stores.

---

### Task 1: Enforce C-1 input parity and MessageHandle authority

**Files:**
- Modify: `packages/api/src/domains/messaging/contract/types.ts`
- Modify: `packages/api/src/domains/messaging/contract/validate.ts`
- Modify: `packages/api/src/domains/messaging/stores/ports.ts`
- Modify: `packages/api/src/domains/messaging/handles.ts`
- Modify: `packages/api/src/domains/messaging/send-service.ts`
- Modify: `packages/api/src/domains/messaging/append-service.ts`
- Modify: `packages/api/src/domains/messaging/messaging-service.ts`
- Test: `packages/api/test/plugin-messaging-validate.test.js`
- Test: `packages/api/test/plugin-messaging-handles.test.js`
- Test: `packages/api/test/plugin-messaging-facade.test.js`

**Step 1: Write failing tests**

- Accept `{ handle: { kind: 'message', token }, operationId, elements }` and reject the former raw `messageId` request.
- Reject unknown properties at every closed C-1 input object and reject duplicate whisper targets.
- Prove send creates a message-handle binding and that append fails after either the message handle or its parent address handle is revoked.

**Step 2: Run tests to verify RED**

Run: `pnpm --filter @cat-cafe/api build && node --import packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/plugin-messaging-validate.test.js packages/api/test/plugin-messaging-handles.test.js packages/api/test/plugin-messaging-facade.test.js`

Expected: failures because `AppendElementsInput` still accepts `messageId`, unknown fields are discarded, and no message-handle resolver exists.

**Step 3: Implement the authority chain**

- Add `MessageHandle` and change `AppendElementsInput.messageId` to `AppendElementsInput.handle`.
- Add a `message_handle` `HandleRecord` carrying `messageId` and `parentHandleId`.
- Have successful send idempotently persist the message handle using the host-generated message ID as its token.
- Resolve append token → message record → live parent address handle before claiming the append ledger.
- Add exact-key validation matching C-1 `additionalProperties: false`; retain open payload objects only for `media_ref` and `rich_block`.

**Step 4: Run tests to verify GREEN**

Run the Step 2 command and require all selected tests to pass.

**Step 5: Commit**

Commit the authority and input-parity slice with a body explaining that raw message IDs bypassed revocation truth.

### Task 2: Make snapshot fencing complete and race-safe

**Files:**
- Modify: `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts`
- Modify: `packages/api/src/domains/messaging/envelope.ts`
- Modify: `packages/api/src/domains/messaging/send-service.ts`
- Modify: `packages/api/src/domains/messaging/append-service.ts`
- Modify: `packages/api/src/domains/messaging/event-stream.ts`
- Test: `packages/api/test/plugin-messaging-event-stream-snapshot.test.js`
- Test: `packages/api/test/plugin-messaging-send.test.js`
- Test: `packages/api/test/plugin-messaging-append.test.js`

**Step 1: Write failing tests**

- Pause send after message persistence and prove snapshot refuses to include the pending message below its future event sequence.
- Create more than 200 visible messages and prove snapshot returns the complete thread instead of silently advancing over the omitted prefix.
- Race an append revision against snapshot and prove the snapshot never exposes a revision whose append event lies after `resumeSequence`.

**Step 2: Run tests to verify RED**

Run the targeted snapshot/send/append tests and confirm the old single-head, fixed-200 implementation fails the new assertions.

**Step 3: Implement the stable snapshot watermark**

- Extend canonical plugin extra with `outputRevision` and `outputSequence`, updated only after the matching public output event is present.
- Repair prior append events before later revisions and advance the watermark with same-revision CAS.
- Snapshot reads head-before, scans the complete thread with `getByThreadAfter`, reads head-after, and retries unless heads match and every public plugin envelope is fully emitted at or below the fence.
- After a bounded number of active-race retries, fail with `RETRYABLE_INFLIGHT`; never return a partial snapshot.

**Step 4: Run tests to verify GREEN**

Run targeted tests and require all race regressions to pass.

**Step 5: Commit**

Commit the snapshot-consistency slice with a body explaining the persist-before-event window and fixed-limit omission.

### Task 3: Close remaining C-1 bounds drift and run the quality gate

**Files:**
- Modify: `packages/api/src/domains/messaging/contract/types.ts`
- Modify: `packages/api/src/domains/messaging/event-stream.ts`
- Test: `packages/api/test/plugin-messaging-validate.test.js`
- Test: `packages/api/test/plugin-messaging-event-stream.test.js`
- Test: `packages/api/test/plugin-messaging-append.test.js`
- Modify: `docs/features/F288-plugin-messaging-domain.md`
- Modify: `review-notes/2026-07-15-k1-plugin-messaging-review-request.md`

**Step 1: Write failing tests**

- Prove `read(..., { limit: 500 })` returns at most 32 events.
- Prove cumulative append cannot make an envelope exceed 32 elements.

**Step 2: Run tests to verify RED**

Run the targeted validation/event-stream/append tests and confirm the old 500/128 limits fail.

**Step 3: Align constants and documentation**

- Set read result maximum and per-message element maximum to C-1's 32.
- Update the feature/review evidence to identify the C-1 candidate SHA and the repaired boundaries.

**Step 4: Run full verification**

Run the K-1 non-Redis suite, isolated Redis K-1 suite, `pnpm check`, API lint/build, recursive build, and `git diff --check` in this worktree.

**Step 5: Commit and request review**

Commit the final parity slice, then request Terra to re-review the new HEAD against `01bf27fafdac9c7d64901ebc9568b45a9e5c8124`. Do not emit `shape-approved` before APPROVE.
