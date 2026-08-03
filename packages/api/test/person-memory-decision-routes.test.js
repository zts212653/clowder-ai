import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f276-decision-routes-test:';

describe('F276 person-memory decision routes', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let app;
  let redis;
  let store;
  let connected = false;
  const sourceMessageRef = { kind: 'message', threadId: 'thread_people', messageId: 'msg_people' };

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F276 decision routes');
    const [routeMod, storeMod, redisMod] = await Promise.all([
      import('../dist/routes/person-memory-decision-routes.js'),
      import('../dist/domains/memory/people/RedisPersonMemoryStore.js'),
      import('@cat-cafe/shared/utils'),
    ]);
    redis = redisMod.createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    store = new storeMod.RedisPersonMemoryStore(redis);
    app = Fastify();
    routeMod.registerPersonMemoryDecisionRoutes(app, {
      store,
      socketManager: { emitToUser() {} },
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (connected) await cleanupClientKeyspace(redis);
  });

  async function seed(candidateId = 'person_candidate_route') {
    const input = {
      candidateId,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      sourceMessageRef,
      personDraft: { displayName: '黄挺', privateAliases: ['黄挺'] },
      claimDrafts: [
        {
          draftId: 'person_draft_fact',
          payload: {
            kind: 'reported_fact',
            predicate: 'organization_unit',
            value: '终端用户计算开发部',
            assertedBy: 'owner',
          },
          normalizedDraft: '黄挺属于终端用户计算开发部',
          sourceRole: 'owner_explicit',
          evidenceExcerpt: '黄挺是终端用户计算开发部',
          decision: 'pending',
        },
      ],
      remainingDraftIds: ['person_draft_fact'],
      retention: 'owner_controlled_no_ttl',
      createdAt: 100,
    };
    await store.stageCandidate(input);
    await store.commitEnvelope(candidateId, {
      canonicalProposalId: candidateId,
      sourceFeatureId: 'F276',
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      originRef: sourceMessageRef,
      approvalCardRef: { threadId: 'thread_people', messageId: `card_${candidateId}` },
      createdAt: 100,
    });
    return input;
  }

  const inject = (method, url, payload, owner = 'owner-1') =>
    app.inject({
      method,
      url,
      headers: { 'x-cat-cafe-user': owner, 'content-type': 'application/json' },
      ...(payload ? { payload } : {}),
    });

  it('materializes the exact selected draft and replays the same decision receipt', async () => {
    const input = await seed();
    const payload = {
      selectedDraftIds: ['person_draft_fact'],
      decisionId: 'decision_route_1',
    };
    const first = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/approve`, payload);
    assert.equal(first.statusCode, 200);
    const receipt = JSON.parse(first.body);
    assert.equal(receipt.status, 'materialized');
    assert.equal(receipt.materializedClaimIds.length, 1);

    const replay = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/approve`, payload);
    assert.equal(replay.statusCode, 200);
    assert.equal(JSON.parse(replay.body).deduped, true);
    assert.deepEqual(JSON.parse(replay.body).materializedClaimIds, receipt.materializedClaimIds);

    const hydrated = await inject('GET', `/api/person-memory-proposals/${input.candidateId}`);
    assert.equal(JSON.parse(hydrated.body).decisionReceipt.decisionId, payload.decisionId);
  });

  it('undoes only the latest exact decision and returns an idempotent receipt', async () => {
    const input = await seed('person_candidate_undo_route');
    const approved = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/approve`, {
      selectedDraftIds: ['person_draft_fact'],
      decisionId: 'decision_route_undo',
    });
    assert.equal(approved.statusCode, 200);

    const payload = { decisionId: 'decision_route_undo', requestId: 'undo_route_1' };
    const first = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/undo`, payload);
    const replay = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/undo`, payload);
    assert.equal(first.statusCode, 200);
    assert.equal(JSON.parse(first.body).status, 'withdrawn');
    assert.equal(JSON.parse(first.body).verdict, 'undone');
    assert.equal(JSON.parse(replay.body).deduped, true);

    const hydrated = await inject('GET', `/api/person-memory-proposals/${input.candidateId}`);
    assert.equal(JSON.parse(hydrated.body).status, 'withdrawn');
    assert.equal(JSON.parse(hydrated.body).undoReceipt.requestId, payload.requestId);
  });

  it('returns the same not_available shape for absent and cross-owner candidates', async () => {
    await seed();
    const absent = await inject('GET', '/api/person-memory-proposals/person_candidate_absent');
    const crossOwner = await inject('GET', '/api/person-memory-proposals/person_candidate_route', undefined, 'other');
    assert.equal(absent.statusCode, 404);
    assert.equal(crossOwner.statusCode, 404);
    assert.deepEqual(JSON.parse(absent.body), JSON.parse(crossOwner.body));
  });

  it('hydrates only the server-anchored approval card message', async () => {
    const input = await seed('person_candidate_hydration_route');
    const response = await inject('GET', `/api/person-memory-proposals/${input.candidateId}`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      proposalId: input.candidateId,
      status: 'pending_approval',
      remainingDraftIds: ['person_draft_fact'],
      publicationState: 'anchored',
      approvalCardMessageId: `card_${input.candidateId}`,
    });
  });

  it('keeps not-now visible and lets the owner reject it later', async () => {
    const input = await seed('person_candidate_not_now_route');
    const paused = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/not-now`, {
      decisionId: 'pause_1',
    });
    assert.equal(paused.statusCode, 200);
    assert.equal(JSON.parse(paused.body).status, 'not_now');

    const rejected = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/reject`, {
      decisionId: 'reject_1',
      feedback: { reasonCode: 'wrong_lane' },
    });
    assert.equal(rejected.statusCode, 200);
    assert.equal(JSON.parse(rejected.body).status, 'rejected');
    assert.deepEqual((await store.getCandidateForOwner(input.ownerUserId, input.candidateId)).latestHumanDisposition, {
      reasonCode: 'wrong_lane',
    });
  });

  it('enforces the F276 catalog and rejects public identity spoofing without mutation', async () => {
    const notNow = await seed('person_candidate_reject_not_now_reason');
    const spoofed = await seed('person_candidate_reject_spoofed_identity');

    const invalidReason = await inject('POST', `/api/person-memory-proposals/${notNow.candidateId}/reject`, {
      decisionId: 'reject_not_now_reason',
      feedback: { reasonCode: 'not_now' },
    });
    assert.equal(invalidReason.statusCode, 400);
    assert.equal((await store.getCandidateForOwner(notNow.ownerUserId, notNow.candidateId)).state, 'pending_approval');

    const spoof = await inject('POST', `/api/person-memory-proposals/${spoofed.candidateId}/reject`, {
      decisionId: 'reject_spoofed_identity',
      feedback: { reasonCode: 'wrong', ownerUserId: 'attacker' },
    });
    assert.equal(spoof.statusCode, 400);
    assert.equal(
      (await store.getCandidateForOwner(spoofed.ownerUserId, spoofed.candidateId)).state,
      'pending_approval',
    );
  });

  it('replays exact feedback but conflicts on a changed reject decision', async () => {
    const input = await seed('person_candidate_reject_replay');
    const payload = { decisionId: 'reject_replay_1', feedback: { reasonCode: 'bad_evidence' } };

    assert.equal(
      (await inject('POST', `/api/person-memory-proposals/${input.candidateId}/reject`, payload)).statusCode,
      200,
    );
    const replay = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/reject`, payload);
    assert.equal(replay.statusCode, 200);
    assert.equal(JSON.parse(replay.body).deduped, true);

    const conflict = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/reject`, {
      decisionId: payload.decisionId,
      feedback: { reasonCode: 'wrong' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(
      (await store.getCandidateForOwner(input.ownerUserId, input.candidateId)).latestHumanDisposition,
      payload.feedback,
    );
  });

  it('does not present legacy or broken ledger truth as a successful reject replay', async () => {
    const input = await seed('person_candidate_reject_invariant_route');
    const originalReject = store.rejectCandidate.bind(store);
    store.rejectCandidate = async () => ({ outcome: 'legacy_disposition_unmigrated' });
    const legacy = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/reject`, {
      decisionId: 'reject_legacy_route',
      feedback: { reasonCode: 'wrong' },
    });
    assert.equal(legacy.statusCode, 409);
    assert.deepEqual(JSON.parse(legacy.body), { error: 'legacy_disposition_unmigrated' });

    store.rejectCandidate = async () => ({ outcome: 'invariant_failure' });
    const broken = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/reject`, {
      decisionId: 'reject_invariant_route',
      feedback: { reasonCode: 'wrong' },
    });
    assert.equal(broken.statusCode, 500);
    assert.deepEqual(JSON.parse(broken.body), { error: 'disposition_invariant_failure' });
    store.rejectCandidate = originalReject;
  });

  it('does not turn a materialized proposal into a feedback rejection', async () => {
    const input = await seed('person_candidate_reject_materialized');
    await inject('POST', `/api/person-memory-proposals/${input.candidateId}/approve`, {
      selectedDraftIds: ['person_draft_fact'],
      decisionId: 'materialize_before_reject',
    });

    const rejected = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/reject`, {
      decisionId: 'reject_after_materialize',
      feedback: { reasonCode: 'wrong' },
    });
    assert.equal(rejected.statusCode, 409);
    assert.equal((await store.getCandidateForOwner(input.ownerUserId, input.candidateId)).state, 'materialized');
  });

  it('lets the owner cancel a pending proposal without treating it as rejection', async () => {
    const input = await seed('person_candidate_withdraw_route');
    const first = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/withdraw`, {
      decisionId: 'withdraw_1',
    });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(JSON.parse(first.body), {
      proposalId: input.candidateId,
      status: 'withdrawn',
    });

    const replay = await inject('POST', `/api/person-memory-proposals/${input.candidateId}/withdraw`, {
      decisionId: 'withdraw_1',
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(JSON.parse(replay.body).deduped, true);
  });
});
