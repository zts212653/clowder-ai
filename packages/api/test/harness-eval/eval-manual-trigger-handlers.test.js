import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { handleGenerateNow, handleTriggerNow } from '../../dist/routes/eval-hub.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';

describe('Eval Manual Trigger Handlers (F192 OQ-21)', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ==========================================================================
  // handleTriggerNow — true wake via late-bound invokeTrigger
  // ==========================================================================
  describe('handleTriggerNow', () => {
    it('returns 503 when invokeTriggerProvider.get() returns null', async () => {
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => null },
          messageStore: { append: async () => ({ id: 'msg-1' }) },
        },
        { domainId: 'eval:a2a', userId: 'test-user' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 503);
      assert.match(result.error, /invokeTrigger not ready/);
    });

    it('returns 503 when messageStore not provided', async () => {
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'enqueued' }) },
        },
        { domainId: 'eval:a2a', userId: 'test-user' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 503);
      assert.match(result.error, /messageStore/);
    });

    it('returns 400 for unknown domainId', async () => {
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'enqueued' }) },
          messageStore: { append: async () => ({ id: 'msg-1' }) },
        },
        { domainId: 'eval:nonexistent', userId: 'test-user' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
      assert.match(result.error, /eval:nonexistent.*not registered/);
    });

    it('真 wake: calls invokeTrigger.trigger() with correct args and returns 200', async () => {
      const triggerCalls = [];
      const messageStoreCalls = [];

      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: {
            get: () => ({
              trigger: (...args) => {
                triggerCalls.push(args);
                return 'enqueued';
              },
            }),
          },
          messageStore: {
            append: async (msg) => {
              messageStoreCalls.push(msg);
              return { id: `msg-${msg.threadId}` };
            },
          },
        },
        { domainId: 'eval:a2a', userId: 'test-user' },
      );

      assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true);
      assert.equal(result.domainId, 'eval:a2a');
      assert.equal(result.threadId, 'thread_eval_a2a');
      assert.equal(result.evalCatId, 'codex');
      assert.equal(result.invocationTriggered, true);
      assert.equal(result.triggerOutcome, 'enqueued');
      assert.equal(result.messageId, 'msg-thread_eval_a2a');

      // 砚砚 R0 P1: trigger MUST be called — NOT just messageStore.append.
      assert.equal(messageStoreCalls.length, 1);
      assert.equal(messageStoreCalls[0].userId, 'test-user');
      assert.match(messageStoreCalls[0].content, /manual trigger by test-user/);
      assert.equal(triggerCalls.length, 1);
      const [threadId, catId, userId, reason, msgId] = triggerCalls[0];
      assert.equal(threadId, 'thread_eval_a2a');
      assert.equal(catId, 'codex');
      assert.equal(userId, 'test-user');
      assert.match(reason, /Manual eval trigger.*eval:a2a/);
      assert.equal(msgId, 'msg-thread_eval_a2a');
    });

    it('returns success with triggerOutcome: enqueued when thread busy', async () => {
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'enqueued' }) },
          messageStore: { append: async () => ({ id: 'msg-busy' }) },
        },
        { domainId: 'eval:a2a', userId: 'test-user' },
      );
      assert.ok(!('error' in result));
      assert.equal(result.triggerOutcome, 'enqueued');
    });

    // Cloud codex R2 P2: 'full' outcome must surface as 503, not silent success
    it('returns 503 invocation_queue_full when trigger() returns "full"', async () => {
      const messageStoreCalls = [];
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'full' }) },
          messageStore: {
            append: async (msg) => {
              messageStoreCalls.push(msg);
              return { id: 'msg-dropped' };
            },
          },
        },
        { domainId: 'eval:a2a', userId: 'test-user' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 503);
      assert.equal(result.error, 'invocation_queue_full');
      assert.match(result.detail, /queue/);
      assert.match(result.detail, /retry/i);
      assert.equal(messageStoreCalls.length, 1, 'message delivered even though wake dropped');
    });
  });

  // ==========================================================================
  // KD-17 snapshot-first error paths (eval:harness-ledger manual trigger)
  // ==========================================================================
  describe('handleTriggerNow KD-17 harness-ledger error paths', () => {
    it('returns 503 when guardRejectionLog provider is absent for eval:harness-ledger', async () => {
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'dispatched' }) },
          messageStore: { append: async () => ({ id: 'msg-hl' }) },
          // guardRejectionLog intentionally absent
        },
        { domainId: 'eval:harness-ledger', userId: 'test-user' },
      );
      assert.ok('error' in result, 'must return error when provider absent');
      assert.equal(result.status, 503);
      assert.equal(result.error, 'harness_ledger_snapshot_unavailable');
      assert.ok(result.detail.includes('KD-17'), 'detail should reference KD-17');
    });

    it('returns 503 when snapshot production throws (Redis error)', async () => {
      const throwingLog = {
        queryWindowStrictComplete: async () => {
          throw new Error('READONLY: Redis failover');
        },
        queryWindowStrict: async () => {
          throw new Error('READONLY: Redis failover');
        },
        queryWindow: async () => [],
      };
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'dispatched' }) },
          messageStore: { append: async () => ({ id: 'msg-hl-err' }) },
          guardRejectionLog: throwingLog,
        },
        { domainId: 'eval:harness-ledger', userId: 'test-user' },
      );
      assert.ok('error' in result, 'must return error when snapshot throws');
      assert.equal(result.status, 503);
      assert.equal(result.error, 'harness_ledger_snapshot_failed');
      assert.ok(result.detail.includes('Redis failover'), 'detail should contain error message');
    });

    it('invokes eval cat with evidence when snapshot succeeds', async () => {
      const successEvents = [
        { eventId: 'e1', kind: 'hold_ball_429', guardId: 'guard-1', timestamp: Date.now(), rawPayload: {} },
      ];
      const successLog = {
        queryWindowStrictComplete: async () => ({ events: successEvents, truncated: false }),
        queryWindowStrict: async () => successEvents,
        queryWindow: async () => [],
      };
      const messageStoreCalls = [];
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'dispatched' }) },
          messageStore: {
            append: async (msg) => {
              messageStoreCalls.push(msg);
              return { id: 'msg-hl-ok' };
            },
          },
          guardRejectionLog: successLog,
        },
        { domainId: 'eval:harness-ledger', userId: 'test-user' },
      );
      assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true);
      assert.equal(result.domainId, 'eval:harness-ledger');

      // Delivered content must contain pre-computed evidence
      assert.equal(messageStoreCalls.length, 1);
      const content = messageStoreCalls[0].content;
      assert.ok(content.includes('Pre-computed Guard Rejection Snapshot'), 'content should contain evidence');
      assert.ok(content.includes('evalRunId'), 'content should contain evalRunId');

      // KD-17 last-hop: exact sourceRefs JSON must be in the delivered content.
      // Eval cat copies this block verbatim — no ISO→epoch conversion needed.
      assert.ok(content.includes('"windowStartMs"'), 'should contain exact windowStartMs');
      assert.ok(content.includes('"windowEndMs"'), 'should contain exact windowEndMs');
      const allJsonBlocks = [...content.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)];
      const sourceRefsBlock = allJsonBlocks.find((m) => m[1].includes('"prompt-segments"'));
      assert.ok(sourceRefsBlock, 'should have fenced JSON with sourceRefs');
      const sourceRefs = JSON.parse(sourceRefsBlock[1]);
      assert.equal(sourceRefs.kind, 'prompt-segments');
      assert.equal(typeof sourceRefs.windowStartMs, 'number', 'windowStartMs must be number');
      assert.equal(typeof sourceRefs.windowEndMs, 'number', 'windowEndMs must be number');
      assert.ok(sourceRefs.windowEndMs > sourceRefs.windowStartMs, 'window must be valid');
      assert.ok(/^hlr-\d+-[a-f0-9]{8}$/.test(sourceRefs.evalRunId), 'evalRunId must match safe format');
    });
  });

  // ==========================================================================
  // F257 sub-item 1: zero events → skip invocation (eval:harness-ledger)
  // ==========================================================================
  describe('handleTriggerNow F257 zero-event skip', () => {
    it('returns TriggerNowSkipped when snapshot has zero events (not an error)', async () => {
      const emptyLog = {
        queryWindowStrictComplete: async () => ({ events: [], truncated: false }),
        queryWindowStrict: async () => [],
        queryWindow: async () => [],
      };
      const triggerCalls = [];
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: {
            get: () => ({
              trigger: (...args) => {
                triggerCalls.push(args);
                return 'dispatched';
              },
            }),
          },
          messageStore: { append: async () => ({ id: 'msg-zero' }) },
          guardRejectionLog: emptyLog,
        },
        { domainId: 'eval:harness-ledger', userId: 'test-user' },
      );

      // Must return ok + skipped (not an error, not a success with invocation)
      assert.ok(!('error' in result), `expected skip, got error: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'zero_events_in_window');
      assert.ok(result.evalRunId, 'should include evalRunId for audit trail');
      assert.ok(/^hlr-\d+-[a-f0-9]{8}$/.test(result.evalRunId), 'evalRunId format');
      assert.ok(result.windowSummary.includes('0 events'), 'windowSummary should mention 0 events');

      // Eval cat must NOT be triggered (nothing to evaluate)
      assert.equal(triggerCalls.length, 0, 'invokeTrigger must NOT be called on zero events');
    });

    it('still invokes eval cat when snapshot has events (>0)', async () => {
      // Sanity check: non-zero events should proceed normally
      const sanityEvents = [{ eventId: 'e1', kind: 'hold_ball_429', guardId: 'guard-1', timestamp: Date.now() }];
      const successLog = {
        queryWindowStrictComplete: async () => ({ events: sanityEvents, truncated: false }),
        queryWindowStrict: async () => sanityEvents,
        queryWindow: async () => [],
      };
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'dispatched' }) },
          messageStore: { append: async () => ({ id: 'msg-with-events' }) },
          guardRejectionLog: successLog,
        },
        { domainId: 'eval:harness-ledger', userId: 'test-user' },
      );

      // Should NOT be skipped
      assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true);
      assert.ok(!('skipped' in result), 'should NOT be skipped when events exist');
      assert.equal(result.invocationTriggered, true);
    });
  });

  // ==========================================================================
  // sol R10 P2-2 #2: manual trigger → snapshot query owner propagation
  // ==========================================================================
  describe('handleTriggerNow owner propagation (sol R10 P2-2)', () => {
    it('passes input.userId as ownerUserId to snapshot query', async () => {
      const queryCalls = [];
      const spyLog = {
        queryWindowStrictComplete: async (opts) => {
          queryCalls.push(opts);
          return { events: [], truncated: false };
        },
        queryWindowStrict: async () => [],
        queryWindow: async () => [],
      };

      await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'dispatched' }) },
          messageStore: { append: async () => ({ id: 'msg-owner' }) },
          guardRejectionLog: spyLog,
        },
        { domainId: 'eval:harness-ledger', userId: 'specific-owner-42' },
      );

      assert.equal(queryCalls.length, 1, 'queryWindowStrictComplete must be called exactly once');
      assert.equal(
        queryCalls[0].ownerUserId,
        'specific-owner-42',
        'snapshot query must receive input.userId as ownerUserId',
      );
    });
  });

  // ==========================================================================
  // Sol R5 P2: escalationKind propagation — TriggerNowInput → snapshot seam
  // ==========================================================================
  describe('handleTriggerNow escalationKind propagation (sol R5 P2)', () => {
    it('uncertainty_probe: persisted snapshot has escalationKind + content has warning', async () => {
      const events = [
        {
          eventId: 'e1',
          kind: 'route_decision_skip',
          guardId: 'a2a_route_decision_skip',
          timestamp: Date.now(),
          rawPayload: {},
        },
      ];
      const log = {
        queryWindowStrictComplete: async () => ({ events, truncated: false }),
        queryWindowStrict: async () => events,
        queryWindow: async () => [],
      };
      const messageStoreCalls = [];
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'dispatched' }) },
          messageStore: {
            append: async (msg) => {
              messageStoreCalls.push(msg);
              return { id: 'msg-probe' };
            },
          },
          guardRejectionLog: log,
        },
        { domainId: 'eval:harness-ledger', userId: 'test-user', escalationKind: 'uncertainty_probe' },
      );
      assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);

      // Verify persisted snapshot has escalationKind
      const { join } = await import('node:path');
      const { readdirSync } = await import('node:fs');
      const snapshotsDir = join(root, 'run-snapshots');
      const files = readdirSync(snapshotsDir).filter((f) => f.endsWith('.json'));
      // Find the latest snapshot (sorted by filename which starts with hlr-<timestamp>)
      const latestFile = files.sort().pop();
      assert.ok(latestFile, 'snapshot file must exist');
      const snapshot = JSON.parse(readFileSync(join(snapshotsDir, latestFile), 'utf8'));
      assert.equal(snapshot.escalationKind, 'uncertainty_probe', 'persisted snapshot must carry escalationKind');

      // Verify content has UNCERTAINTY PROBE warning (summary injection)
      assert.equal(messageStoreCalls.length, 1);
      const content = messageStoreCalls[0].content;
      assert.ok(content.includes('UNCERTAINTY PROBE'), 'content must include UNCERTAINTY PROBE warning');
    });

    it('confirmed: persisted snapshot has escalationKind + content has no probe warning', async () => {
      const events = [
        {
          eventId: 'e2',
          kind: 'route_decision_skip',
          guardId: 'a2a_route_decision_skip',
          timestamp: Date.now(),
          rawPayload: {},
        },
      ];
      const log = {
        queryWindowStrictComplete: async () => ({ events, truncated: false }),
        queryWindowStrict: async () => events,
        queryWindow: async () => [],
      };
      const messageStoreCalls = [];
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'dispatched' }) },
          messageStore: {
            append: async (msg) => {
              messageStoreCalls.push(msg);
              return { id: 'msg-confirmed' };
            },
          },
          guardRejectionLog: log,
        },
        { domainId: 'eval:harness-ledger', userId: 'test-user', escalationKind: 'confirmed' },
      );
      assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);

      // Verify persisted snapshot has escalationKind
      const { join } = await import('node:path');
      const { readdirSync } = await import('node:fs');
      const snapshotsDir = join(root, 'run-snapshots');
      const files = readdirSync(snapshotsDir).filter((f) => f.endsWith('.json'));
      const latestFile = files.sort().pop();
      assert.ok(latestFile, 'snapshot file must exist');
      const snapshot = JSON.parse(readFileSync(join(snapshotsDir, latestFile), 'utf8'));
      assert.equal(snapshot.escalationKind, 'confirmed', 'persisted snapshot must carry confirmed');

      // Verify content does NOT have probe warning
      assert.equal(messageStoreCalls.length, 1);
      const content = messageStoreCalls[0].content;
      assert.ok(!content.includes('UNCERTAINTY PROBE'), 'confirmed must NOT include probe warning');
    });

    it('absent: persisted snapshot has no escalationKind when not provided', async () => {
      const events = [
        {
          eventId: 'e3',
          kind: 'route_decision_skip',
          guardId: 'a2a_route_decision_skip',
          timestamp: Date.now(),
          rawPayload: {},
        },
      ];
      const log = {
        queryWindowStrictComplete: async () => ({ events, truncated: false }),
        queryWindowStrict: async () => events,
        queryWindow: async () => [],
      };
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => ({ trigger: () => 'dispatched' }) },
          messageStore: { append: async () => ({ id: 'msg-absent' }) },
          guardRejectionLog: log,
        },
        { domainId: 'eval:harness-ledger', userId: 'test-user' },
      );
      assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);

      // Verify persisted snapshot has NO escalationKind
      const { join } = await import('node:path');
      const { readdirSync } = await import('node:fs');
      const snapshotsDir = join(root, 'run-snapshots');
      const files = readdirSync(snapshotsDir).filter((f) => f.endsWith('.json'));
      const latestFile = files.sort().pop();
      assert.ok(latestFile, 'snapshot file must exist');
      const snapshot = JSON.parse(readFileSync(join(snapshotsDir, latestFile), 'utf8'));
      assert.equal(snapshot.escalationKind, undefined, 'no escalationKind when not provided');
    });
  });

  // ==========================================================================
  // handleGenerateNow — retired product-worktree writer
  // ==========================================================================
  describe('handleGenerateNow', () => {
    it('always returns 410 before reading evidence or writing product Git files', async () => {
      const result = await handleGenerateNow(
        { harnessFeedbackRoot: root },
        {
          domainId: 'eval:a2a',
          userId: 'test-user',
          verdictId: 'legacy-verdict',
          snapshotName: '../must-not-read.yaml',
          attributionName: '../must-not-read.yaml',
        },
      );

      assert.equal(result.status, 410);
      assert.equal(result.error, 'generate_now_sunset');
      assert.match(result.detail, /durable artifact store/i);
      assert.match(result.detail, /does not create Git commits, branches, or PRs/i);
    });
  });
});
