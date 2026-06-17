/**
 * CommunityObjectStore + projector tests (F168 Phase A — Task 4)
 * Redis-backed — must use isolated ephemeral Redis (run via test:redis).
 *
 * Core scenarios:
 * 1. append event sequence → projector.apply → projection state correct
 * 2. rebuild(subjectKey) → deep-equal to incremental apply result
 * 3. closure_invariant rejection → projection unchanged, lastRejectedEvent set
 * 4. rebuildAll → consistent across all subjects
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function makeEvent(kind, overrides = {}) {
  return {
    sourceEventId: `${kind}-${Math.random().toString(36).slice(2)}`,
    subjectKey: 'issue:owner/repo#42',
    kind,
    classification: 'state-changing',
    payload: {},
    at: Date.now(),
    ...overrides,
  };
}

describe('CommunityObjectStore + projector (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let CommunityEventLog;
  let CommunityObjectStore;
  let CommunityProjector;
  let createRedisClient;
  let redis;
  let eventLog;
  let objectStore;
  let projector;
  let connected = false;

  const KEY_PATTERNS = ['community:events:*', 'community:object:*', 'community:objects:*'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'CommunityProjector');

    const elMod = await import('../dist/domains/community/CommunityEventLog.js');
    CommunityEventLog = elMod.RedisCommunityEventLog;

    const osMod = await import('../dist/domains/community/CommunityObjectStore.js');
    CommunityObjectStore = osMod.RedisCommunityObjectStore;

    const pMod = await import('../dist/domains/community/community-projector.js');
    CommunityProjector = pMod.CommunityProjector;

    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient(REDIS_URL);
    await redis.ping();
    connected = true;

    eventLog = new CommunityEventLog(redis);
    objectStore = new CommunityObjectStore(redis);
    projector = new CommunityProjector(eventLog, objectStore);
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  // -----------------------------------------------------------------------
  // Basic event sequence → projection state
  // -----------------------------------------------------------------------

  describe('apply — basic state transitions', () => {
    it('issue.opened → projection state=new', async () => {
      const event = makeEvent('issue.opened', {
        subjectKey: 'issue:owner/repo#1',
        sourceEventId: 'open-1',
      });
      await eventLog.append(event);
      await projector.apply(event);
      const proj = await objectStore.get('issue:owner/repo#1');
      assert.ok(proj, 'projection should exist');
      assert.strictEqual(proj.state, 'new');
      assert.strictEqual(proj.appliedEventCount, 1);
    });

    it('full sequence opened→triaged→routed→pr.merged→reported→closed', async () => {
      const sk = 'issue:owner/repo#99';
      const events = [
        makeEvent('issue.opened', { subjectKey: sk, sourceEventId: 'e1' }),
        makeEvent('case.triaged', { subjectKey: sk, sourceEventId: 'e2' }),
        makeEvent('case.routed', { subjectKey: sk, sourceEventId: 'e3' }),
        makeEvent('pr.merged', { subjectKey: sk, sourceEventId: 'e4' }),
        makeEvent('case.reported', { subjectKey: sk, sourceEventId: 'e5' }),
        makeEvent('issue.closed', { subjectKey: sk, sourceEventId: 'e6' }),
      ];

      for (const e of events) {
        await eventLog.append(e);
        await projector.apply(e);
      }

      const proj = await objectStore.get(sk);
      assert.strictEqual(proj.state, 'closed');
      assert.strictEqual(proj.appliedEventCount, 6);
      assert.ok(proj.lastPublicCommentAt !== null, 'reported should set lastPublicCommentAt');
    });
  });

  // -----------------------------------------------------------------------
  // Closure invariant rejection
  // -----------------------------------------------------------------------

  describe('apply — closure invariant', () => {
    it('fixed→closed without reported leaves state=fixed and sets lastRejectedEvent', async () => {
      const sk = 'issue:owner/repo#55';
      const open = makeEvent('issue.opened', { subjectKey: sk, sourceEventId: 'r1' });
      const merged = makeEvent('pr.merged', { subjectKey: sk, sourceEventId: 'r2' });
      const closed = makeEvent('issue.closed', { subjectKey: sk, sourceEventId: 'r3' });

      await eventLog.append(open);
      await projector.apply(open);
      await eventLog.append(merged);
      await projector.apply(merged);
      await eventLog.append(closed);
      await projector.apply(closed);

      const proj = await objectStore.get(sk);
      assert.strictEqual(proj.state, 'fixed', 'state must not advance to closed');
      assert.ok(proj.lastRejectedEvent !== null, 'lastRejectedEvent must be recorded');
      assert.strictEqual(proj.lastRejectedEvent.sourceEventId, 'r3');
      // event is still in the log
      const logEvents = await eventLog.read(sk);
      assert.strictEqual(logEvents.length, 3, 'rejected event stays in log');
    });
  });

  // -----------------------------------------------------------------------
  // Rebuild consistency
  // -----------------------------------------------------------------------

  describe('rebuild consistency', () => {
    it('rebuild(subjectKey) produces same projection as incremental apply', async () => {
      const sk = 'issue:owner/repo#77';
      const events = [
        makeEvent('issue.opened', { subjectKey: sk, sourceEventId: 'rb1' }),
        makeEvent('case.triaged', { subjectKey: sk, sourceEventId: 'rb2' }),
        makeEvent('case.declined', { subjectKey: sk, sourceEventId: 'rb3' }),
      ];
      for (const e of events) {
        await eventLog.append(e);
        await projector.apply(e);
      }
      const beforeRebuild = await objectStore.get(sk);

      // rebuild from scratch
      await projector.rebuild(sk);
      const afterRebuild = await objectStore.get(sk);

      // createdAt/updatedAt will differ (rebuild resets them) — compare state
      assert.strictEqual(afterRebuild.state, beforeRebuild.state);
      assert.strictEqual(afterRebuild.appliedEventCount, beforeRebuild.appliedEventCount);
    });

    it('rebuildAll: PR linkedIssues populated from issue bootstrap, order-independent', async () => {
      const issueSk = 'issue:owner/repo#42';
      const prSk = 'pr:owner/repo#10';

      // issue bootstrap with linkedPrNumbers: [10]
      await eventLog.append(makeEvent('issue.opened', { subjectKey: issueSk, sourceEventId: 'oi-42' }));
      await eventLog.append({
        sourceEventId: 'boot-42',
        subjectKey: issueSk,
        kind: 'case.bootstrap',
        classification: 'state-changing',
        payload: {
          ownerThreadId: 'thread-1',
          ownerRole: 'codex',
          originalRecord: { linkedPrNumbers: [10] },
          mappedState: 'new',
          originalState: 'open',
        },
        at: Date.now(),
      });
      await eventLog.append(makeEvent('pr.opened', { subjectKey: prSk, sourceEventId: 'pr-10' }));

      // Two consecutive rebuildAll calls — second call may observe reversed subject order
      await projector.rebuildAll();
      await projector.rebuildAll();

      const prProj = await objectStore.get(prSk);
      assert.ok(prProj, 'PR projection must exist after rebuildAll');
      assert.deepStrictEqual(prProj.linkedIssues, [42], 'PR must have linkedIssues=[42] regardless of rebuild order');

      const issueProj = await objectStore.get(issueSk);
      assert.ok(issueProj, 'issue projection must exist');
      assert.deepStrictEqual(issueProj.linkedPrs, [10], 'issue must have linkedPrs=[10]');
    });

    it('rebuildAll: cross-populate does NOT regress PR updatedAt to bootstrap event time', async () => {
      const issueSk = 'issue:owner/repo#42';
      const prSk = 'pr:owner/repo#10';
      const BOOTSTRAP_TIME = 1000;
      const MERGE_TIME = 5000; // later than bootstrap

      await eventLog.append({
        sourceEventId: 'oi-42-t',
        subjectKey: issueSk,
        kind: 'issue.opened',
        classification: 'state-changing',
        payload: {},
        at: BOOTSTRAP_TIME,
      });
      await eventLog.append({
        sourceEventId: 'boot-42-t',
        subjectKey: issueSk,
        kind: 'case.bootstrap',
        classification: 'state-changing',
        payload: {
          ownerThreadId: 'thread-1',
          ownerRole: 'codex',
          originalRecord: { linkedPrNumbers: [10] },
          mappedState: 'new',
          originalState: 'open',
        },
        at: BOOTSTRAP_TIME,
      });
      await eventLog.append({
        sourceEventId: 'pr-10-opened-t',
        subjectKey: prSk,
        kind: 'pr.opened',
        classification: 'state-changing',
        payload: {},
        at: MERGE_TIME - 1000,
      });
      await eventLog.append({
        sourceEventId: 'pr-10-merged-t',
        subjectKey: prSk,
        kind: 'pr.merged',
        classification: 'state-changing',
        payload: {},
        at: MERGE_TIME,
      });

      await projector.rebuildAll();

      const prProj = await objectStore.get(prSk);
      assert.ok(prProj, 'PR projection must exist');
      assert.strictEqual(prProj.state, 'fixed', 'PR must be fixed after pr.merged');
      assert.ok(
        prProj.updatedAt >= MERGE_TIME,
        `PR updatedAt (${prProj.updatedAt}) must NOT regress below merge time (${MERGE_TIME})`,
      );
      assert.deepStrictEqual(prProj.linkedIssues, [42], 'PR must still have linkedIssues=[42]');
    });

    it('rebuildAll: linked issue receives pr.merged cascade even when PR merged before link was restored', async () => {
      // Regression: pass 1 replays pr.merged with linkedIssues=[] (link not yet restored),
      // pass 2 restores the link but never re-fires the cascade.
      // After rebuildAll the issue should be 'fixed', not 'new'.
      const issueSk = 'issue:owner/repo#42';
      const prSk = 'pr:owner/repo#10';
      const BOOTSTRAP_TIME = 1000;
      const MERGE_TIME = 5000;

      // Issue: opened + bootstrap (links PR #10)
      await eventLog.append({
        sourceEventId: 'oi-42-cascade',
        subjectKey: issueSk,
        kind: 'issue.opened',
        classification: 'state-changing',
        payload: {},
        at: BOOTSTRAP_TIME,
      });
      await eventLog.append({
        sourceEventId: 'boot-42-cascade',
        subjectKey: issueSk,
        kind: 'case.bootstrap',
        classification: 'state-changing',
        payload: {
          ownerThreadId: 'thread-1',
          ownerRole: 'codex',
          originalRecord: { linkedPrNumbers: [10] },
          mappedState: 'new',
          originalState: 'open',
        },
        at: BOOTSTRAP_TIME,
      });

      // PR: opened then merged (before link restoration in pass 2)
      await eventLog.append({
        sourceEventId: 'pr-10-opened-cascade',
        subjectKey: prSk,
        kind: 'pr.opened',
        classification: 'state-changing',
        payload: {},
        at: MERGE_TIME - 1000,
      });
      await eventLog.append({
        sourceEventId: 'pr-10-merged-cascade',
        subjectKey: prSk,
        kind: 'pr.merged',
        classification: 'state-changing',
        payload: { title: 'Fix issue #42' },
        at: MERGE_TIME,
      });

      await projector.rebuildAll();

      const issueProj = await objectStore.get(issueSk);
      assert.ok(issueProj, 'issue projection must exist');
      assert.strictEqual(
        issueProj.state,
        'fixed',
        `issue #42 must be 'fixed' after pr.merged cascade, got '${issueProj.state}'`,
      );

      const prProj = await objectStore.get(prSk);
      assert.ok(prProj, 'PR projection must exist');
      assert.strictEqual(prProj.state, 'fixed', 'PR must be fixed');
      assert.deepStrictEqual(prProj.linkedIssues, [42], 'PR must have linkedIssues=[42]');
    });

    it('rebuildAll processes all subjects', async () => {
      const subjects = ['issue:org/r#10', 'issue:org/r#20', 'pr:org/r#30'];
      let i = 0;
      for (const sk of subjects) {
        await eventLog.append(makeEvent('issue.opened', { subjectKey: sk, sourceEventId: `all-${i++}` }));
      }
      await projector.rebuildAll();
      for (const sk of subjects) {
        const proj = await objectStore.get(sk);
        assert.ok(proj, `projection should exist for ${sk}`);
        assert.strictEqual(proj.state, 'new');
      }
    });
  });

  // -----------------------------------------------------------------------
  // P1-4: case.bootstrap — linkedPrNumbers cross-population (F168)
  // -----------------------------------------------------------------------

  describe('apply — case.bootstrap linkedPrNumbers cross-populate (P1-4)', () => {
    it('case.bootstrap sets linkedPrs on issue projection from originalRecord.linkedPrNumbers', async () => {
      const sk = 'issue:owner/repo#77';
      const bootstrapEvent = makeEvent('case.bootstrap', {
        subjectKey: sk,
        payload: {
          mappedState: 'routed',
          originalState: 'open',
          ownerThreadId: 'thread-77',
          ownerRole: 'codex',
          originalRecord: {
            linkedPrNumbers: [10, 20],
          },
        },
      });

      await eventLog.append(bootstrapEvent);
      await projector.apply(bootstrapEvent);

      const issueProj = await objectStore.get(sk);
      assert.ok(issueProj, 'issue projection should exist');
      assert.deepStrictEqual(
        [...issueProj.linkedPrs].sort((a, b) => a - b),
        [10, 20],
        'issue projection should have linkedPrs populated from originalRecord.linkedPrNumbers',
      );
    });

    it('case.bootstrap cross-populates linkedIssues on each linked PR projection', async () => {
      const sk = 'issue:owner/repo#88';
      const bootstrapEvent = makeEvent('case.bootstrap', {
        subjectKey: sk,
        payload: {
          mappedState: 'routed',
          originalState: 'open',
          originalRecord: {
            linkedPrNumbers: [55],
          },
        },
      });

      await eventLog.append(bootstrapEvent);
      await projector.apply(bootstrapEvent);

      // PR projection for pr:owner/repo#55 should have linkedIssues: [88]
      const prProj = await objectStore.get('pr:owner/repo#55');
      assert.ok(prProj, 'PR projection should be created/updated by cross-populate');
      assert.ok(
        prProj.linkedIssues.includes(88),
        'PR projection linkedIssues should include the bootstrapped issue number',
      );
    });

    it('case.bootstrap with no linkedPrNumbers leaves linkedPrs empty', async () => {
      const sk = 'issue:owner/repo#99';
      const bootstrapEvent = makeEvent('case.bootstrap', {
        subjectKey: sk,
        payload: {
          mappedState: 'new',
          originalState: 'open',
          originalRecord: {}, // no linkedPrNumbers
        },
      });

      await eventLog.append(bootstrapEvent);
      await projector.apply(bootstrapEvent);

      const proj = await objectStore.get(sk);
      assert.ok(proj, 'issue projection should exist');
      assert.deepStrictEqual(
        proj.linkedPrs,
        [],
        'linkedPrs should be empty when originalRecord has no linkedPrNumbers',
      );
    });
  });

  // -----------------------------------------------------------------------
  // case.waived side-effect
  // -----------------------------------------------------------------------

  describe('apply — case.waived side-effect', () => {
    it('case.waived stores closureWaiver on projection', async () => {
      const sk = 'issue:owner/repo#66';
      const open = makeEvent('issue.opened', { subjectKey: sk, sourceEventId: 'w1' });
      const merged = makeEvent('pr.merged', { subjectKey: sk, sourceEventId: 'w2' });
      const waived = makeEvent('case.waived', {
        subjectKey: sk,
        sourceEventId: 'w3',
        payload: { reason: 'stale', actor: 'maintainer', evidence: 'https://example.com' },
      });

      await eventLog.append(open);
      await projector.apply(open);
      await eventLog.append(merged);
      await projector.apply(merged);
      await eventLog.append(waived);
      await projector.apply(waived);

      const proj = await objectStore.get(sk);
      assert.ok(proj.closureWaiver !== null, 'waiver should be stored');
      assert.strictEqual(proj.closureWaiver.reason, 'stale');
      assert.strictEqual(proj.state, 'fixed', 'state unchanged by waiver');
    });
  });

  // -----------------------------------------------------------------------
  // Task 3 (Phase B): pr.opened body → linkedIssues + cascade fix
  // -----------------------------------------------------------------------

  describe('Task 3 (Phase B) — pr.opened body parsing + cascade', () => {
    it('pr.opened with Fixes #N body sets linkedIssues on PR projection', async () => {
      const issueSk = 'issue:owner/repo#200';
      const prSk = 'pr:owner/repo#10';

      // Issue must exist first
      const issueOpen = makeEvent('issue.opened', { subjectKey: issueSk, sourceEventId: 'p3-i1' });
      await eventLog.append(issueOpen);
      await projector.apply(issueOpen);

      // PR opened with closing keyword in body
      const prOpen = makeEvent('pr.opened', {
        subjectKey: prSk,
        sourceEventId: 'p3-pr1',
        payload: { title: 'Fix the thing', body: 'Fixes #200' },
      });
      await eventLog.append(prOpen);
      await projector.apply(prOpen);

      const prProj = await objectStore.get(prSk);
      assert.ok(prProj, 'PR projection must exist');
      assert.deepStrictEqual(prProj.linkedIssues, [200], 'linkedIssues must be populated from body');
    });

    it('pr.opened body → merged → cascade fixes linked issue (dead-穴 fix)', async () => {
      const issueSk = 'issue:owner/repo#201';
      const prSk = 'pr:owner/repo#11';

      // Issue opened
      const issueOpen = makeEvent('issue.opened', { subjectKey: issueSk, sourceEventId: 'p3-i2' });
      await eventLog.append(issueOpen);
      await projector.apply(issueOpen);

      // PR opened with body "Fixes #201"
      const prOpen = makeEvent('pr.opened', {
        subjectKey: prSk,
        sourceEventId: 'p3-pr2',
        payload: { title: 'Fix issue 201', body: 'Fixes #201' },
      });
      await eventLog.append(prOpen);
      await projector.apply(prOpen);

      // PR merged — cascade should fire because linkedIssues is now populated
      const prMerged = makeEvent('pr.merged', {
        subjectKey: prSk,
        sourceEventId: 'p3-pr2-merged',
        payload: { title: 'Fix issue 201' },
      });
      await eventLog.append(prMerged);
      await projector.apply(prMerged);

      // Issue 201 should now be fixed
      const issueProj = await objectStore.get(issueSk);
      assert.ok(issueProj, 'issue projection must exist');
      assert.strictEqual(issueProj.state, 'fixed', 'linked issue must be in fixed state after PR merge');
    });

    it('rebuildAll: pr.opened body cascade is order-independent (issue before PR and PR before issue)', async () => {
      const issueSk = 'issue:owner/repo#202';
      const prSk = 'pr:owner/repo#12';

      // Seed events into log
      const issueOpen = makeEvent('issue.opened', { subjectKey: issueSk, sourceEventId: 'p3-oi1' });
      const prOpen = makeEvent('pr.opened', {
        subjectKey: prSk,
        sourceEventId: 'p3-opr1',
        payload: { title: 'Fix 202', body: 'Fixes #202' },
      });
      const prMerged = makeEvent('pr.merged', {
        subjectKey: prSk,
        sourceEventId: 'p3-opr1-merged',
        payload: { title: 'Fix 202' },
      });
      await eventLog.append(issueOpen);
      await eventLog.append(prOpen);
      await eventLog.append(prMerged);

      // Run rebuildAll — order of subjects is non-deterministic; both paths must converge
      await projector.rebuildAll();

      const issueProj = await objectStore.get(issueSk);
      assert.ok(issueProj, 'issue projection must exist after rebuildAll');
      assert.strictEqual(issueProj.state, 'fixed', 'issue must be fixed after rebuildAll (order-independent)');

      // updatedAt must not regress from the cascaded pr.merged timestamp
      const mergedProj = await objectStore.get(prSk);
      assert.ok(mergedProj, 'PR projection must exist after rebuildAll');
      assert.strictEqual(mergedProj.state, 'fixed', 'PR must be in fixed state');
    });
  });
});
