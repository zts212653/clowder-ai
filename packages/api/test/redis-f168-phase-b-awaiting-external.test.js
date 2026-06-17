/**
 * F168 Phase B — Task 7: Redis-backed integration tests (awaiting_external e2e chain)
 *
 * Redis-backed — must run via `pnpm --filter @cat-cafe/api test:redis`.
 *
 * Two chains:
 *  A. awaiting_external → OWNER maintainer comment → silent-log + state stays awaiting_external
 *  B. awaiting_external → external (CONTRIBUTOR) comment → wake-owner + state restores to in_progress
 *
 * Verifies:
 *  1. CommunityEventLog.append + CommunityProjector.apply produce correct projection state
 *  2. decideDelivery() returns correct silent-log / wake-owner for each step
 *  3. lastExternalActivityAt is updated when external comment restores awaiting_external
 *  4. Rebuild consistency: rebuild from log equals incremental state
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function makeEvent(kind, subjectKey, overrides = {}) {
  return {
    sourceEventId: `${kind}-${Math.random().toString(36).slice(2)}`,
    subjectKey,
    kind,
    classification: 'state-changing',
    payload: {},
    at: Date.now(),
    ...overrides,
  };
}

function makeInformationalEvent(kind, subjectKey, authorAssociation, overrides = {}) {
  return makeEvent(kind, subjectKey, {
    classification: 'informational',
    payload: {
      commentId: Math.floor(Math.random() * 100_000),
      authorLogin: 'testuser',
      authorAssociation,
    },
    ...overrides,
  });
}

describe('F168 Phase B: awaiting_external e2e chain (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisCommunityEventLog;
  let RedisCommunityObjectStore;
  let CommunityProjector;
  let decideDelivery;
  let createRedisClient;
  let redis;
  let eventLog;
  let objectStore;
  let projector;
  let connected = false;

  const KEY_PATTERNS = ['community:events:*', 'community:object:*', 'community:objects:*'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F168-Phase-B-AwaitingExternal');

    const elMod = await import('../dist/domains/community/CommunityEventLog.js');
    RedisCommunityEventLog = elMod.RedisCommunityEventLog;

    const osMod = await import('../dist/domains/community/CommunityObjectStore.js');
    RedisCommunityObjectStore = osMod.RedisCommunityObjectStore;

    const pMod = await import('../dist/domains/community/community-projector.js');
    CommunityProjector = pMod.CommunityProjector;

    const dpMod = await import('../dist/domains/community/community-delivery-policy.js');
    decideDelivery = dpMod.decideDelivery;

    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient(REDIS_URL);
    await redis.ping();
    connected = true;

    eventLog = new RedisCommunityEventLog(redis);
    objectStore = new RedisCommunityObjectStore(redis);
    projector = new CommunityProjector(eventLog, objectStore);
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Chain A: awaiting_external + OWNER comment → silent, state stays
  // ─────────────────────────────────────────────────────────────────────────

  describe('Chain A: OWNER comment on awaiting_external → silent + state unchanged', () => {
    it('appends case.awaiting_external → state=awaiting_external, then OWNER comment stays in state', async () => {
      const sk = 'issue:owner/repo#101';

      // Setup: opened → routed → in_progress equivalent (using bootstrap to jump)
      const openedEvent = makeEvent('issue.opened', sk, { sourceEventId: 'ca-e1' });
      await eventLog.append(openedEvent);
      await projector.apply(openedEvent);

      // Jump to in_progress via case.routed (as close as we can get without a direct transition)
      const routedEvent = makeEvent('case.routed', sk, { sourceEventId: 'ca-e2' });
      await eventLog.append(routedEvent);
      await projector.apply(routedEvent);

      // Bootstrap jump to in_progress
      const bootstrapEvent = makeEvent('case.bootstrap', sk, {
        sourceEventId: 'ca-e3',
        payload: { mappedState: 'in_progress', originalState: 'in_progress' },
      });
      await eventLog.append(bootstrapEvent);
      await projector.apply(bootstrapEvent);

      // Verify in_progress before awaiting
      const inProgressProj = await objectStore.get(sk);
      assert.strictEqual(inProgressProj.state, 'in_progress');

      // Declare awaiting_external
      const awaitingEvent = makeEvent('case.awaiting_external', sk, {
        sourceEventId: 'ca-e4',
        payload: { reason: 'waiting for reporter to provide reproduction steps' },
      });
      await eventLog.append(awaitingEvent);
      await projector.apply(awaitingEvent);

      const awaitingProj = await objectStore.get(sk);
      assert.strictEqual(awaitingProj.state, 'awaiting_external', 'state must be awaiting_external after event');

      // OWNER comments — should be silent-log and NOT restore state
      const ownerCommentEvent = makeInformationalEvent('issue.commented', sk, 'OWNER', {
        sourceEventId: 'ca-e5',
        payload: { commentId: 1001, authorLogin: 'repoowner', authorAssociation: 'OWNER' },
      });
      await eventLog.append(ownerCommentEvent);
      await projector.apply(ownerCommentEvent);

      const afterOwnerCommentProj = await objectStore.get(sk);
      assert.strictEqual(
        afterOwnerCommentProj.state,
        'awaiting_external',
        'OWNER comment must NOT restore state — stays awaiting_external',
      );
      assert.ok(
        afterOwnerCommentProj.lastExternalActivityAt !== null,
        'lastExternalActivityAt must be updated on OWNER comment',
      );

      // Delivery policy check
      const deliveryDecision = decideDelivery({
        state: 'awaiting_external',
        eventKind: 'issue.commented',
        authorAssociation: 'OWNER',
      });
      assert.strictEqual(deliveryDecision, 'silent-log', 'OWNER comment must be silent-log');
    });

    it('MEMBER comment on awaiting_external is also silent-log + state stays', async () => {
      const sk = 'issue:owner/repo#102';

      // Bootstrap to awaiting_external directly
      const bootstrapEvent = makeEvent('case.bootstrap', sk, {
        sourceEventId: 'cb-e1',
        payload: { mappedState: 'awaiting_external', originalState: 'awaiting_external' },
      });
      await eventLog.append(bootstrapEvent);
      await projector.apply(bootstrapEvent);

      const memberCommentEvent = makeInformationalEvent('issue.commented', sk, 'MEMBER', {
        sourceEventId: 'cb-e2',
        payload: { commentId: 2001, authorLogin: 'teammember', authorAssociation: 'MEMBER' },
      });
      await eventLog.append(memberCommentEvent);
      await projector.apply(memberCommentEvent);

      const proj = await objectStore.get(sk);
      assert.strictEqual(proj.state, 'awaiting_external', 'MEMBER comment must not restore state');

      assert.strictEqual(
        decideDelivery({ state: 'awaiting_external', eventKind: 'issue.commented', authorAssociation: 'MEMBER' }),
        'silent-log',
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Chain B: awaiting_external + external comment → wake + state restores
  // ─────────────────────────────────────────────────────────────────────────

  describe('Chain B: external comment on awaiting_external → wake + in_progress restore', () => {
    it('CONTRIBUTOR comment restores awaiting_external → in_progress + lastExternalActivityAt updated', async () => {
      const sk = 'issue:owner/repo#201';

      // Bootstrap to awaiting_external
      const bootstrapEvent = makeEvent('case.bootstrap', sk, {
        sourceEventId: 'cc-e1',
        payload: { mappedState: 'awaiting_external', originalState: 'awaiting_external' },
      });
      await eventLog.append(bootstrapEvent);
      await projector.apply(bootstrapEvent);

      const beforeProj = await objectStore.get(sk);
      assert.strictEqual(beforeProj.state, 'awaiting_external');

      // External (CONTRIBUTOR) comments — should wake + restore state
      const at = Date.now() + 1000; // ensure it's different from bootstrap at
      const externalCommentEvent = makeInformationalEvent('issue.commented', sk, 'CONTRIBUTOR', {
        sourceEventId: 'cc-e2',
        at,
        payload: { commentId: 3001, authorLogin: 'reporter', authorAssociation: 'CONTRIBUTOR' },
      });
      await eventLog.append(externalCommentEvent);
      await projector.apply(externalCommentEvent);

      const afterProj = await objectStore.get(sk);
      assert.strictEqual(
        afterProj.state,
        'in_progress',
        'CONTRIBUTOR comment must restore awaiting_external → in_progress',
      );
      assert.strictEqual(
        afterProj.lastExternalActivityAt,
        at,
        'lastExternalActivityAt must be set to comment timestamp',
      );

      // Delivery policy: wake-owner
      assert.strictEqual(
        decideDelivery({
          state: 'awaiting_external',
          eventKind: 'issue.commented',
          authorAssociation: 'CONTRIBUTOR',
        }),
        'wake-owner',
        'external comment must trigger wake-owner delivery',
      );
    });

    it('NONE (anonymous) comment restores awaiting_external → in_progress', async () => {
      const sk = 'issue:owner/repo#202';

      const bootstrapEvent = makeEvent('case.bootstrap', sk, {
        sourceEventId: 'cd-e1',
        payload: { mappedState: 'awaiting_external', originalState: 'awaiting_external' },
      });
      await eventLog.append(bootstrapEvent);
      await projector.apply(bootstrapEvent);

      const noneCommentEvent = makeInformationalEvent('issue.commented', sk, 'NONE', {
        sourceEventId: 'cd-e2',
        payload: { commentId: 4001, authorLogin: 'anonuser', authorAssociation: 'NONE' },
      });
      await eventLog.append(noneCommentEvent);
      await projector.apply(noneCommentEvent);

      const proj = await objectStore.get(sk);
      assert.strictEqual(proj.state, 'in_progress', 'NONE association must restore state');

      assert.strictEqual(
        decideDelivery({ state: 'awaiting_external', eventKind: 'issue.commented', authorAssociation: 'NONE' }),
        'wake-owner',
      );
    });

    it('full chain: opened→awaiting_external→OWNER(silent)→CONTRIBUTOR(wake) rebuild is consistent', async () => {
      const sk = 'issue:owner/repo#301';

      const events = [
        makeEvent('issue.opened', sk, { sourceEventId: 'ce-e1' }),
        makeEvent('case.bootstrap', sk, {
          sourceEventId: 'ce-e2',
          payload: { mappedState: 'in_progress', originalState: 'in_progress' },
        }),
        makeEvent('case.awaiting_external', sk, {
          sourceEventId: 'ce-e3',
          payload: { reason: 'needs repro' },
        }),
        makeInformationalEvent('issue.commented', sk, 'OWNER', {
          sourceEventId: 'ce-e4',
          payload: { commentId: 5001, authorLogin: 'owner', authorAssociation: 'OWNER' },
        }),
        makeInformationalEvent('issue.commented', sk, 'CONTRIBUTOR', {
          sourceEventId: 'ce-e5',
          payload: { commentId: 5002, authorLogin: 'reporter', authorAssociation: 'CONTRIBUTOR' },
        }),
      ];

      for (const e of events) {
        await eventLog.append(e);
        await projector.apply(e);
      }

      const incrementalProj = await objectStore.get(sk);
      assert.strictEqual(
        incrementalProj.state,
        'in_progress',
        'final state must be in_progress after CONTRIBUTOR restores',
      );

      // Rebuild from log must produce same state
      await projector.rebuild(sk);
      const rebuiltProj = await objectStore.get(sk);
      assert.strictEqual(rebuiltProj.state, incrementalProj.state, 'rebuild must match incremental state');
      assert.strictEqual(
        rebuiltProj.appliedEventCount,
        incrementalProj.appliedEventCount,
        'appliedEventCount must match',
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Delivery policy: issue.labeled is always silent (label metadata)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Delivery policy: issue.labeled is always silent', () => {
    it('issue.labeled → silent-log regardless of state and authorAssociation', () => {
      const states = ['in_progress', 'awaiting_external', 'new', 'triaged'];
      for (const state of states) {
        assert.strictEqual(
          decideDelivery({ state, eventKind: 'issue.labeled', authorAssociation: 'CONTRIBUTOR' }),
          'silent-log',
          `issue.labeled must be silent-log from state: ${state}`,
        );
      }
    });
  });
});
