import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { handleGenerateNow, handleTriggerNow } from '../../dist/routes/eval-hub.js';
import { setupHarnessFeedback, setupRawArtifacts } from './eval-manual-trigger-fixtures.js';

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
          invokeTriggerProvider: { get: () => ({ trigger: () => 'dispatched' }) },
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
          invokeTriggerProvider: { get: () => ({ trigger: () => 'dispatched' }) },
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
                return 'dispatched';
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
      assert.equal(result.triggerOutcome, 'dispatched');
      assert.equal(result.messageId, 'msg-thread_eval_a2a');

      // 砚砚 R0 P1: trigger MUST be called — NOT just messageStore.append.
      assert.equal(messageStoreCalls.length, 1);
      assert.equal(messageStoreCalls[0].userId, 'scheduler');
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
  // handleGenerateNow — domain validation order + security + eval:a2a only
  // ==========================================================================
  describe('handleGenerateNow', () => {
    // 砚砚 R1 P2-a: validation order — unknown = 400 (not 501)
    it('returns 400 for unknown domainId (eval:totally-unknown) — NOT 501', async () => {
      const result = await handleGenerateNow(
        { harnessFeedbackRoot: root },
        {
          domainId: 'eval:totally-unknown',
          userId: 'test-user',
          verdictId: 'test',
          snapshotName: 'foo.yaml',
          attributionName: 'bar.yaml',
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
      assert.match(result.error, /eval:totally-unknown.*not registered/);
    });

    // 砚砚 R0 P1: 501 unsupported_generator for all registered-but-no-generator domains
    it('returns 501 unsupported_generator for all non-a2a registered domains (NO stub)', async () => {
      for (const domainId of ['eval:memory', 'eval:sop', 'eval:task-outcome', 'eval:capability-wakeup']) {
        const result = await handleGenerateNow(
          { harnessFeedbackRoot: root },
          {
            domainId,
            userId: 'test-user',
            verdictId: 'test',
            snapshotName: 'foo.yaml',
            attributionName: 'bar.yaml',
          },
        );
        assert.ok('error' in result, `${domainId} expected error`);
        assert.equal(result.status, 501, `${domainId} expected 501`);
        assert.equal(result.error, 'unsupported_generator', `${domainId} expected unsupported_generator`);
        assert.match(result.detail, /registered/, `${domainId} detail must confirm registered`);
      }
    });

    it('returns 400 when required body fields missing for eval:a2a', async () => {
      const result = await handleGenerateNow(
        { harnessFeedbackRoot: root },
        {
          domainId: 'eval:a2a',
          userId: 'test-user',
          snapshotName: 'foo.yaml',
          attributionName: 'bar.yaml',
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
    });

    // Cloud codex R3 P2: non-string body fields → 400 (NOT 500 from basename throw)
    it('returns 400 for non-string body field values (NOT 500 from basename throw)', async () => {
      const nonStringValues = [{ malicious: true }, 123, null, ['x'], true];
      for (const value of nonStringValues) {
        for (const field of ['verdictId', 'snapshotName', 'attributionName']) {
          const input = {
            domainId: 'eval:a2a',
            userId: 'test-user',
            verdictId: 'test',
            snapshotName: 'foo.yaml',
            attributionName: 'bar.yaml',
          };
          input[field] = value;
          const result = await handleGenerateNow({ harnessFeedbackRoot: root }, input);
          assert.ok('error' in result, `${field}=${JSON.stringify(value)} expected error`);
          assert.equal(result.status, 400, `${field}=${JSON.stringify(value)} must be 400 not 500`);
        }
      }
    });

    // Cloud codex R4 P2: slug-invalid verdictId → 400 (NOT 500 from generator throw)
    it('returns 400 for slug-invalid verdictId (NOT 500 from generator)', async () => {
      const slugViolations = ['Test-Foo', 'test_foo', '-leading', 'foo.bar', 'foo bar', 'foo/bar'];
      for (const value of slugViolations) {
        const result = await handleGenerateNow(
          { harnessFeedbackRoot: root },
          {
            domainId: 'eval:a2a',
            userId: 'test-user',
            verdictId: value,
            snapshotName: 'foo.yaml',
            attributionName: 'bar.yaml',
          },
        );
        assert.ok('error' in result, `'${value}' expected error`);
        assert.equal(result.status, 400, `'${value}' must be 400 not 500`);
        assert.match(result.error, /safe slug/i, `'${value}' error must mention safe slug`);
      }
    });

    // 砚砚 R1 P1: path traversal in snapshotName/attributionName → 400 before any readFileSync
    it('returns 400 before basename() for path-traversal in snapshotName/attributionName', async () => {
      const traversalValues = ['../etc/passwd', '/etc/passwd', 'subdir/leak.yaml', '', '..', '.'];
      for (const value of traversalValues) {
        for (const field of ['snapshotName', 'attributionName']) {
          const input = {
            domainId: 'eval:a2a',
            userId: 'test-user',
            verdictId: 'test',
            snapshotName: 'foo.yaml',
            attributionName: 'bar.yaml',
          };
          input[field] = value;
          const result = await handleGenerateNow({ harnessFeedbackRoot: root }, input);
          assert.ok('error' in result, `${field}='${value}' expected rejection`);
          assert.equal(result.status, 400, `${field}='${value}' must be 400 not 500`);
          assert.match(result.error, new RegExp(field), `${field}='${value}' error must call out ${field}`);
        }
      }
    });

    it('returns 500 when generator throws (valid basenames but missing files)', async () => {
      const result = await handleGenerateNow(
        { harnessFeedbackRoot: root },
        {
          domainId: 'eval:a2a',
          userId: 'test-user',
          verdictId: 'test-missing-files',
          snapshotName: 'nonexistent-snapshot.yaml',
          attributionName: 'nonexistent-attribution.yaml',
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 500);
      assert.match(result.error, /Generator failed/);
    });

    // 砚砚 R0 P1: e2e roundtrip — generated verdict appears in Hub summary
    it('eval:a2a generates verdict + roundtrips through loadEvalHubSummary()', async () => {
      const { snapshotName, attributionName } = setupRawArtifacts(root, '2026-06-04');
      const verdictId = '2026-06-04-eval-a2a-roundtrip-test';

      const result = await handleGenerateNow(
        { harnessFeedbackRoot: root },
        {
          domainId: 'eval:a2a',
          userId: 'test-user',
          verdictId,
          snapshotName,
          attributionName,
        },
      );

      assert.ok(!('error' in result), `Expected success, got: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true);
      assert.equal(result.domainId, 'eval:a2a');
      assert.equal(result.verdictId, verdictId);
      assert.ok(result.verdictPath.endsWith(`${verdictId}.md`));
      assert.ok(result.bundleDir.includes(verdictId));
      assert.equal(result.hubRoundtrip.ok, true, `roundtrip failed: ${JSON.stringify(result.hubRoundtrip)}`);
      assert.ok(result.hubRoundtrip.itemCount >= 1);
    });

    // Cloud codex R10 P1 + 砚砚收敛 A: idempotency — duplicate verdictId → 409, no overwrite
    it('rejects duplicate verdictId with 409 + does NOT overwrite (砚砚 R10)', async () => {
      const { snapshotName, attributionName } = setupRawArtifacts(root, '2026-06-05');
      const verdictId = '2026-06-05-eval-a2a-idempotency-test';
      const input = { domainId: 'eval:a2a', userId: 'test-user', verdictId, snapshotName, attributionName };
      const first = await handleGenerateNow({ harnessFeedbackRoot: root }, input);
      assert.ok(!('error' in first), `first should succeed: ${JSON.stringify(first)}`);
      const original = readFileSync(first.verdictPath, 'utf8');
      const second = await handleGenerateNow({ harnessFeedbackRoot: root }, input);
      assert.ok('error' in second);
      assert.equal(second.status, 409);
      assert.equal(second.error, 'verdict_already_exists');
      assert.match(second.detail, /forbidden|data integrity/i);
      assert.equal(readFileSync(first.verdictPath, 'utf8'), original, 'verdict must NOT be overwritten');
    });

    // 砚砚收敛 A: length limits — prevent DoS via huge inputs
    it('rejects oversized verdictId/snapshotName/attributionName with 400 (砚砚 R10)', async () => {
      const big = 'a'.repeat(300);
      const base = {
        domainId: 'eval:a2a',
        userId: 'test-user',
        verdictId: 'ok',
        snapshotName: 'foo.yaml',
        attributionName: 'bar.yaml',
      };
      for (const field of ['verdictId', 'snapshotName', 'attributionName']) {
        const value = field === 'verdictId' ? big : `${big}.yaml`;
        const result = await handleGenerateNow({ harnessFeedbackRoot: root }, { ...base, [field]: value });
        assert.ok('error' in result, `${field}=oversized expected rejection`);
        assert.equal(result.status, 400, `${field}=oversized must be 400`);
        assert.match(result.error, new RegExp(field), `${field} error must call out ${field}`);
      }
    });
  });
});
