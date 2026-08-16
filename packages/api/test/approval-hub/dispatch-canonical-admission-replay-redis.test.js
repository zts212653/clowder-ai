import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const HEAD_SHA = 'a'.repeat(40);
const REBUILD_MARKER_KEY = 'dispatch-proposal-canonical-admission-rebuild-completed-at';
const REDIS_KEYS = [
  'dispatch-proposal:*',
  'dispatch-proposal-user-pending:*',
  'dispatch-proposal-user-settled:*',
  'dispatch-proposal-clientmsg:*',
  'dispatch-proposal-lineage:*',
  'dispatch-proposal-canonical-admission:*',
  REBUILD_MARKER_KEY,
  'dispatch-proposal-negative-authorization:*',
  'dispatch-proposal-legacy-negative-authorization:*',
  'dispatch-proposal-negative-authorization-legacy-cutover',
  'dispatch-proposal-negative-authorization-legacy-rebuild-completed-at',
  'action:successor:*',
];

function reviewAction(overrides = {}) {
  return {
    subjectRef: 'pr:owner/repo#42',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    terminalPredicate: { kind: 'review_delivered', headSha: HEAD_SHA },
    ...overrides,
  };
}

function createInvocationRecordStore() {
  const records = [];
  return {
    create(input) {
      const record = { id: `child-${records.length}`, ...input };
      records.push(record);
      return { outcome: 'created', invocationId: record.id };
    },
    update() {},
    get() {
      return null;
    },
    getRecords() {
      return [...records];
    },
  };
}

function createRouter() {
  return {
    async *routeExecution() {
      yield* [];
    },
    getExecutions() {
      return [];
    },
  };
}

describe(
  'canonical admission preserves F167 replay and re-entry semantics',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  () => {
    let redis;
    let connected = false;
    let createRedisClient;
    let RedisDispatchProposalStore;
    let RedisActionSuccessorLeaseStore;
    let ActionSuccessorAdmissionService;
    let InvocationRegistry;
    let InvocationQueue;
    let MessageStore;
    let ThreadStore;
    let callbacksRoutes;
    let validateDispatchProposedAction;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, '#1291 canonical route replay');
      [
        { createRedisClient },
        { RedisDispatchProposalStore },
        { RedisActionSuccessorLeaseStore },
        { ActionSuccessorAdmissionService },
        { InvocationRegistry },
        { InvocationQueue },
        { MessageStore },
        { ThreadStore },
        { callbacksRoutes },
        { validateDispatchProposedAction },
      ] = await Promise.all([
        import('@cat-cafe/shared/utils'),
        import('../../dist/domains/approval-hub/stores/redis/RedisDispatchProposalStore.js'),
        import('../../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js'),
        import('../../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'),
        import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
        import('../../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
        import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
        import('../../dist/domains/cats/services/stores/ports/ThreadStore.js'),
        import('../../dist/routes/callbacks.js'),
        import('../../dist/domains/approval-hub/DispatchProposedAction.js'),
      ]);
      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        await redis.quit().catch(() => {});
      }
    });

    beforeEach(async (t) => {
      if (!connected) return t.skip('Redis not connected');
      await cleanupPrefixedRedisKeys(redis, REDIS_KEYS);
    });

    after(async () => {
      if (!connected) return;
      await cleanupPrefixedRedisKeys(redis, REDIS_KEYS);
      await redis.quit();
    });

    async function createFixture(t) {
      const registry = new InvocationRegistry();
      const invocationQueue = new InvocationQueue();
      const messageStore = new MessageStore();
      const threadStore = new ThreadStore();
      const proposalStore = new RedisDispatchProposalStore(redis);
      const invocationRecordStore = createInvocationRecordStore();
      const source = await threadStore.create('user-1', 'Source');
      const target = await threadStore.create('user-1', 'Target');
      const auditEvents = [];
      const broadcasts = [];
      await threadStore.addParticipants(source.id, ['opus']);
      await threadStore.addParticipants(target.id, ['sonnet']);

      const leaseStore = new RedisActionSuccessorLeaseStore(redis);
      const admissionService = new ActionSuccessorAdmissionService(leaseStore, {
        async resolve() {
          return { terminal: false, source: 'community_projection', state: 'active' };
        },
        async resolveFreshness(predicate) {
          return {
            status: 'verified',
            evidenceRef: `community:${predicate.subjectRef}:head:${HEAD_SHA}`,
            freshnessKey: predicate.freshnessKey,
          };
        },
      });
      const app = Fastify();
      await app.register(callbacksRoutes, {
        redis,
        registry,
        invocationQueue,
        messageStore,
        threadStore,
        dispatchProposalStore: proposalStore,
        invocationRecordStore,
        router: createRouter(),
        queueProcessor: { async tryAutoExecute() {} },
        socketManager: {
          broadcastAgentMessage(...args) {
            broadcasts.push(args);
          },
          broadcastToRoom() {},
          emitToUser() {},
        },
        approvalIngress: { async publish() {} },
        eventAuditLog: {
          async append(event) {
            auditEvents.push(event);
            return { id: `audit-${auditEvents.length}`, timestamp: Date.now(), ...event };
          },
        },
        actionSuccessorAdmissionService: admissionService,
      });
      await app.ready();
      t.after(() => app.close());
      const auth = await registry.create('user-1', 'opus', source.id);
      return {
        app,
        auth,
        auditEvents,
        broadcasts,
        invocationQueue,
        invocationRecordStore,
        leaseStore,
        messageStore,
        proposalStore,
        registry,
        source,
        target,
      };
    }

    async function post(fixture, clientMessageId, action, targetCats = ['sonnet']) {
      return fixture.app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: {
          'x-invocation-id': fixture.auth.invocationId,
          'x-callback-token': fixture.auth.callbackToken,
        },
        payload: {
          threadId: fixture.target.id,
          content: `@${targetCats[0]}\nReview the exact HEAD.`,
          targetCats,
          clientMessageId,
          action,
        },
      });
    }

    async function createCanonicalBlock(fixture, proposalId, overrides = {}) {
      const targetCats = overrides.targetCats ?? ['sonnet'];
      const validated = validateDispatchProposedAction(overrides.action ?? reviewAction(), targetCats);
      const { proposal } = await fixture.proposalStore.create({
        proposalId,
        sourceInvocationId: overrides.sourceInvocationId ?? `later-invocation-${proposalId}`,
        sourceThreadId: fixture.source.id,
        targetThreadId: fixture.target.id,
        senderCatId: 'opus',
        ownerUserId: 'user-1',
        content: 'A later proposal for the same review identity.',
        targetCats,
        clientMessageId: `proposal-${proposalId}`,
        proposedAction: validated.action,
        envelopeDigest: validated.envelopeDigest,
        createdAt: Date.now(),
      });
      return proposal;
    }

    async function createActionlessBlock(fixture, proposalId) {
      const { proposal } = await fixture.proposalStore.create({
        proposalId,
        sourceInvocationId: fixture.auth.invocationId,
        sourceThreadId: fixture.source.id,
        targetThreadId: fixture.target.id,
        senderCatId: 'opus',
        ownerUserId: 'user-1',
        content: 'A held proposal without a structured action.',
        targetCats: ['sonnet'],
        clientMessageId: `proposal-${proposalId}`,
        createdAt: Date.now(),
      });
      return proposal;
    }

    async function createLegacyActionlessBlock(fixture, proposalId, cutoverAt = Date.now()) {
      const proposal = await createActionlessBlock(fixture, proposalId);
      await redis.hdel(`dispatch-proposal:${proposalId}`, 'sourceInvocationId');
      await fixture.proposalStore.rebuildNegativeAuthorizationIndexes();
      await fixture.proposalStore.establishNegativeAuthorizationLegacyCutoverAt(cutoverAt);
      return proposal;
    }

    async function assertNoTargetSideEffects(fixture, clientMessageId) {
      assert.deepEqual(fixture.messageStore.getByThread(fixture.target.id, 20, 'user-1'), []);
      assert.deepEqual(fixture.invocationQueue.list(fixture.target.id, 'user-1'), []);
      assert.deepEqual(fixture.invocationRecordStore.getRecords(), []);
      assert.deepEqual(fixture.broadcasts, []);
      assert.equal(
        (await fixture.registry.getRecord(fixture.auth.invocationId)).clientMessageIds.has(clientMessageId),
        false,
      );
      assert.equal(await redis.scard('action:successor:all'), 0);
    }

    test('blocks a first-time review re-entry with a pending canonical decision before side effects', async (t) => {
      const fixture = await createFixture(t);
      await createCanonicalBlock(fixture, 'review-reentry-pending');

      const response = await post(
        fixture,
        'first-review-reentry',
        reviewAction({ reviewReentry: { reason: 'stale_or_blocking', evidenceRef: 'message:stale-review' } }),
      );

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().kind, 'dispatch_negative_authorization_blocked');
      await assertNoTargetSideEffects(fixture, 'first-review-reentry');
      assert.equal(fixture.auditEvents.length, 1);
      const [audit] = fixture.auditEvents;
      assert.equal(audit.type, 'dispatch_negative_authorization_blocked');
      assert.equal(audit.threadId, fixture.target.id);
      assert.deepEqual(audit.data.proposalIds, ['review-reentry-pending']);
      assert.deepEqual(audit.data.proposalStatuses, [{ proposalId: 'review-reentry-pending', status: 'pending' }]);
      assert.deepEqual(audit.data.blockedTargetCats, ['sonnet']);
      assert.equal(audit.data.sourceInvocationId, fixture.auth.invocationId);
      assert.equal(audit.data.clientMessageIdPresent, true);
      assert.equal(audit.data.clientMessageIdHash, createHash('sha256').update('first-review-reentry').digest('hex'));
      assert.equal(Object.hasOwn(audit.data, 'content'), false, 'audit must never retain message content');
    });

    test('blocks a first existing-standing claim with a pending canonical decision before side effects', async (t) => {
      const fixture = await createFixture(t);
      await createCanonicalBlock(fixture, 'existing-standing-pending', { targetCats: ['opus'] });

      const response = await post(
        fixture,
        'first-existing-standing',
        reviewAction({
          claimOrigin: 'existing_standing',
          groundingEvidenceRef: 'message:verified-standing',
        }),
        ['opus'],
      );

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().kind, 'dispatch_negative_authorization_blocked');
      await assertNoTargetSideEffects(fixture, 'first-existing-standing');
      assert.equal(fixture.auditEvents.length, 1);
      assert.deepEqual(fixture.auditEvents[0].data.proposalIds, ['existing-standing-pending']);
      assert.deepEqual(fixture.auditEvents[0].data.proposalStatuses, [
        { proposalId: 'existing-standing-pending', status: 'pending' },
      ]);
    });

    test('admits an unblocked first existing-standing claim through the atomic path', async (t) => {
      const fixture = await createFixture(t);

      const response = await post(
        fixture,
        'unblocked-existing-standing',
        reviewAction({
          claimOrigin: 'existing_standing',
          groundingEvidenceRef: 'message:verified-standing',
        }),
        ['opus'],
      );

      assert.equal(response.statusCode, 200);
      assert.equal(fixture.auditEvents.length, 0);
      const lease = await fixture.leaseStore.getByIdentity({
        tenantScope: 'user-1',
        subjectRef: 'pr:owner/repo#42',
        actionFamily: 'review',
        successorSlot: 'reviewer',
      });
      assert.equal(lease?.claimOrigin, 'existing_standing');
    });

    test('blocks a first structured claim behind a same-lineage held actionless proposal', async (t) => {
      const fixture = await createFixture(t);
      await createActionlessBlock(fixture, 'held-actionless-pending');

      const response = await post(fixture, 'first-structured-after-actionless', reviewAction());

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().kind, 'dispatch_negative_authorization_blocked');
      await assertNoTargetSideEffects(fixture, 'first-structured-after-actionless');
      assert.equal(fixture.auditEvents.length, 1);
      assert.deepEqual(fixture.auditEvents[0].data.proposalIds, ['held-actionless-pending']);
      assert.deepEqual(fixture.auditEvents[0].data.proposalStatuses, [
        { proposalId: 'held-actionless-pending', status: 'pending' },
      ]);
    });

    test('blocks a first structured claim behind a rejected actionless proposal', async (t) => {
      const fixture = await createFixture(t);
      await createActionlessBlock(fixture, 'held-actionless-rejected');
      assert.ok(await fixture.proposalStore.reject('held-actionless-rejected', 'user-1'));

      const response = await post(fixture, 'first-structured-after-actionless-rejection', reviewAction());

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().kind, 'dispatch_negative_authorization_blocked');
      await assertNoTargetSideEffects(fixture, 'first-structured-after-actionless-rejection');
      assert.equal(fixture.auditEvents.length, 1);
      assert.deepEqual(fixture.auditEvents[0].data.proposalIds, ['held-actionless-rejected']);
      assert.deepEqual(fixture.auditEvents[0].data.proposalStatuses, [
        { proposalId: 'held-actionless-rejected', status: 'rejected' },
      ]);
    });

    test('blocks a first structured claim behind a pre-cutover legacy held actionless proposal', async (t) => {
      const fixture = await createFixture(t);
      await createLegacyActionlessBlock(fixture, 'legacy-held-actionless-pending');

      const response = await post(fixture, 'first-structured-after-legacy-actionless', reviewAction());

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().kind, 'legacy_dispatch_lineage_unresolved');
      await assertNoTargetSideEffects(fixture, 'first-structured-after-legacy-actionless');
      assert.equal(fixture.auditEvents.length, 1);
      assert.deepEqual(fixture.auditEvents[0].data.proposalIds, ['legacy-held-actionless-pending']);
      assert.deepEqual(fixture.auditEvents[0].data.proposalStatuses, [
        { proposalId: 'legacy-held-actionless-pending', status: 'pending' },
      ]);
      assert.equal(fixture.auditEvents[0].data.legacyUnresolved, true);
      assert.equal(typeof fixture.auditEvents[0].data.legacyCutoverAt, 'number');
    });

    test('does not apply a legacy held proposal to a post-cutover structured claim', async (t) => {
      const fixture = await createFixture(t);
      await createLegacyActionlessBlock(fixture, 'legacy-post-cutover-actionless', 1);

      const response = await post(fixture, 'first-structured-post-legacy-cutover', reviewAction());

      assert.equal(response.statusCode, 200);
      assert.equal(fixture.auditEvents.length, 0);
      assert.equal(await redis.scard('action:successor:all'), 1);
    });

    test('retains legacy provenance in the audit when an exact blocker also denies the claim', async (t) => {
      const fixture = await createFixture(t);
      await createLegacyActionlessBlock(fixture, 'legacy-mixed-actionless');
      assert.ok(await fixture.proposalStore.reject('legacy-mixed-actionless', 'user-1'));
      await createActionlessBlock(fixture, 'exact-mixed-actionless');

      const response = await post(fixture, 'first-structured-after-mixed-actionless', reviewAction());

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().kind, 'dispatch_negative_authorization_blocked');
      await assertNoTargetSideEffects(fixture, 'first-structured-after-mixed-actionless');
      assert.equal(fixture.auditEvents.length, 1);
      assert.deepEqual(fixture.auditEvents[0].data.proposalIds, ['exact-mixed-actionless', 'legacy-mixed-actionless']);
      assert.deepEqual(fixture.auditEvents[0].data.proposalStatuses, [
        { proposalId: 'exact-mixed-actionless', status: 'pending' },
        { proposalId: 'legacy-mixed-actionless', status: 'rejected' },
      ]);
      assert.equal(fixture.auditEvents[0].data.legacyUnresolved, true);
      assert.equal(typeof fixture.auditEvents[0].data.legacyCutoverAt, 'number');
    });

    test('replays an already admitted dispatch despite a later canonical decision', async (t) => {
      const fixture = await createFixture(t);
      const clientMessageId = 'replay-before-later-proposal';
      const action = reviewAction();
      const first = await post(fixture, clientMessageId, action);
      assert.equal(first.statusCode, 200);
      assert.equal(await redis.scard('action:successor:all'), 1);
      await createCanonicalBlock(fixture, 'later-canonical-block');
      await redis.del(REBUILD_MARKER_KEY);

      const replay = await post(fixture, clientMessageId, action);

      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().status, 'duplicate');
      assert.equal(await redis.scard('action:successor:all'), 1);
      assert.equal(await redis.get(REBUILD_MARKER_KEY), null, 'replay must precede projection readiness');
    });

    test('continues an existing completed review lease despite an unrelated later proposal', async (t) => {
      const fixture = await createFixture(t);
      const first = await post(fixture, 'completed-review-lease', reviewAction());
      assert.equal(first.statusCode, 200);

      const lease = await fixture.leaseStore.getByIdentity({
        tenantScope: 'user-1',
        subjectRef: 'pr:owner/repo#42',
        actionFamily: 'review',
        successorSlot: 'reviewer',
      });
      assert.ok(lease);
      const completed = await fixture.leaseStore.commitOutcome(lease.leaseId, {
        generation: lease.generation,
        catId: 'sonnet',
        outcome: 'succeeded',
        evidenceRef: 'local-review:exact-head:a',
        now: Date.now(),
      });
      assert.equal(completed.outcome, 'recorded');
      assert.equal(completed.lease.status, 'completed');
      await createCanonicalBlock(fixture, 'unrelated-exact-block-after-completion', {
        sourceInvocationId: fixture.auth.invocationId,
        action: reviewAction({ subjectRef: 'pr:owner/unrelated#99' }),
      });
      await redis.del(REBUILD_MARKER_KEY);

      const continued = await post(
        fixture,
        'continued-review-lease',
        reviewAction({
          terminalPredicate: { kind: 'review_delivered', headSha: 'b'.repeat(40) },
          reviewReentry: {
            reason: 'stale_or_blocking',
            evidenceRef: 'message:stale-local-review-verdict',
          },
        }),
      );

      assert.equal(continued.statusCode, 200);
      const renewed = await fixture.leaseStore.get(lease.leaseId);
      assert.equal(renewed?.generation, 2);
      assert.equal(renewed?.dispatchId, 'cross-post:continued-review-lease');
      assert.equal(await redis.get(REBUILD_MARKER_KEY), null, 'existing lease must precede projection readiness');
    });
  },
);
