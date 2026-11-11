import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { F276ApprovalAdapter } from '../dist/domains/approval-hub/adapters/F276ApprovalAdapter.js';
import { FINISH_HARD_FORGET_LUA } from '../dist/domains/memory/people/person-memory-forget-lua.js';
import { PersonMemoryKeys } from '../dist/domains/memory/people/person-memory-keys.js';
import { RedisPersonMemoryStore } from '../dist/domains/memory/people/RedisPersonMemoryStore.js';
import { personMemoryOwnerReadRoutes } from '../dist/routes/person-memory-owner-read.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

describe('owner proposal forget', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  let app, redis, store;
  const owner = 'owner-1';
  const origin = 'http://localhost:3003';
  const requestId = `person_forget_${'1'.repeat(32)}`;
  const endpoint = (id) => `/api/person-memory-proposals/${id}/forget`;
  const headers = (session = owner) => ({ origin, 'x-test-session': session, 'x-csrf-token': 'csrf-test' });
  before(async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'owner proposal forget');
    redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: 'owner-proposal-forget-test:' });
    await redis.ping();
    store = new RedisPersonMemoryStore(redis);
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = request.headers['x-test-session'];
      request.sessionBindingId = 'test-session';
      request.sessionCsrfToken = 'csrf-test';
    });
    await app.register(personMemoryOwnerReadRoutes, { ownerUserId: owner, store, messageStore: {}, threadStore: {} });
    await app.ready();
  });
  after(async () => {
    await app?.close();
    if (redis) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });
  beforeEach(async () => cleanupClientKeyspace(redis));
  async function seed(id, replacesProposalId, ownerUserId = owner) {
    const sourceMessageRef = { kind: 'message', threadId: 'thread_forget', messageId: `source_${id}` };
    const input = {
      candidateId: id,
      ownerUserId,
      requesterCatId: 'codex61-sol',
      sourceMessageRef,
      personDraft: { displayName: 'Sample person', privateAliases: ['Sample person'] },
      claimDrafts: [
        {
          draftId: 'person_draft_fact',
          payload: { kind: 'reported_fact', predicate: 'team', value: 'sample', assertedBy: 'owner' },
          normalizedDraft: 'Sample person joins sample',
          sourceRole: 'owner_explicit',
          evidenceExcerpt: 'Sample person joins sample',
          decision: 'pending',
        },
      ],
      remainingDraftIds: ['person_draft_fact'],
      retention: 'owner_controlled_no_ttl',
      createdAt: Date.now(),
      ...(replacesProposalId ? { replacesProposalId } : {}),
    };
    await store.stageCandidate(input);
    await store.commitEnvelope(id, {
      canonicalProposalId: id,
      sourceFeatureId: 'F276',
      ownerUserId,
      requesterCatId: input.requesterCatId,
      originRef: sourceMessageRef,
      approvalCardRef: { threadId: 'thread_forget', messageId: `card_${id}` },
      createdAt: input.createdAt,
    });
    return id;
  }
  const withdraw = (id, who = owner) => store.withdrawCandidate(who, id, Date.now());
  const inspect = (id, auth = headers()) => app.inject({ method: 'GET', url: endpoint(id), headers: auth });
  const forget = (id, expectedRevision, auth = headers(), extra = {}) =>
    app.inject({
      method: 'POST',
      url: endpoint(id),
      headers: auth,
      payload: { requestId, expectedRevision, confirmed: true, ...extra },
    });

  it('preflights the exact terminal lineage and replays its durable receipt after deletion', async () => {
    const root = await seed('person_candidate_forget_root');
    const leaf = await seed('person_candidate_forget_leaf', root);
    await withdraw(leaf);
    const other = await seed('person_candidate_keep');
    await withdraw(other);
    const preflight = await inspect(root);
    assert.equal(preflight.statusCode, 200);
    const preview = preflight.json();
    assert.equal(preview.outcome, 'eligible');
    assert.equal(preview.count, 2);
    assert.match(preview.revision, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(preview.proposalIds, [root, leaf]);
    const response = await forget(root, preview.revision);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().outcome, 'purged');
    assert.equal(response.json().receipt.purgedSurfaceCounts.candidates, 2);
    assert.equal(await store.getCandidateForOwner(owner, root), null);
    assert.equal(await store.getCandidateForOwner(owner, leaf), null);
    assert.ok(await store.getCandidateForOwner(owner, other));
    assert.deepEqual((await forget(root, preview.revision)).json(), response.json());
    assert.deepEqual((await forget(root, `sha256:${'0'.repeat(64)}`)).json(), response.json());
    const restarted = new RedisPersonMemoryStore(redis);
    assert.deepEqual(
      await restarted.hardForgetProposal({
        ownerUserId: owner,
        proposalId: root,
        requestId,
        expectedRevision: preview.revision,
        requestedAt: Date.now(),
      }),
      response.json(),
    );
    assert.equal(await redis.ttl(PersonMemoryKeys.proposalForgetReceipt(owner, root, requestId)), -1);
    assert.deepEqual((await inspect(root)).json(), { outcome: 'absent' });
  });

  it('requires the owner browser session, CSRF and explicit confirmation; callback identities cannot delete', async () => {
    const id = await seed('person_candidate_auth');
    await withdraw(id);
    assert.equal((await inspect(id, { 'x-cat-cafe-user': owner })).statusCode, 401);
    assert.equal((await inspect(id, headers('other-owner'))).statusCode, 403);
    const preview = (await inspect(id)).json();
    for (const invalid of [
      { ...headers(), 'x-csrf-token': 'wrong' },
      { ...headers(), 'x-callback-token': 'cat-token' },
      { ...headers(), origin: 'https://evil.invalid' },
      { 'x-cat-cafe-user': owner },
    ]) {
      assert.ok([401, 403].includes((await forget(id, preview.revision, invalid)).statusCode));
    }
    assert.equal((await forget(id, preview.revision, headers(), { confirmed: false })).statusCode, 400);
    assert.ok(await store.getCandidateForOwner(owner, id));
    const foreign = await seed('person_candidate_foreign', undefined, 'other-owner');
    await withdraw(foreign, 'other-owner');
    assert.deepEqual((await inspect(foreign)).json(), { outcome: 'absent' });
  });

  it('keeps inspection read-only and allows a fresh confirmation after an atomic race refuses deletion', async () => {
    const id = await seed('person_candidate_finish_race');
    await withdraw(id);
    const keysBefore = (await redis.keys('*')).sort();
    const preview = (await inspect(id)).json();
    assert.deepEqual((await redis.keys('*')).sort(), keysBefore);
    let release, reached;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const ready = new Promise((resolve) => {
      reached = resolve;
    });
    const client = new Proxy(redis, {
      get(target, property) {
        if (property === 'eval')
          return async (...args) => {
            if (args[0] === FINISH_HARD_FORGET_LUA) {
              reached();
              await gate;
            }
            return target.eval(...args);
          };
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const pending = new RedisPersonMemoryStore(client).hardForgetProposal({
      ownerUserId: owner,
      proposalId: id,
      requestId,
      expectedRevision: preview.revision,
      requestedAt: Date.now(),
    });
    await ready;
    const key = PersonMemoryKeys.candidate(owner, id),
      raw = JSON.parse(await redis.get(key));
    await redis.set(key, JSON.stringify({ ...raw, closedAt: raw.closedAt + 1 }));
    release();
    assert.equal((await pending).outcome, 'conflict');
    const nextPreview = (await inspect(id)).json();
    const response = await forget(id, nextPreview.revision, headers(), {
      requestId: `person_forget_${'2'.repeat(32)}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().outcome, 'purged');
  });

  it('shares qualification for pending, partially materialized, bound and broken chains', async () => {
    const root = await seed('person_candidate_pending_root');
    const leaf = await seed('person_candidate_pending_leaf', root);
    assert.equal((await inspect(root)).json().outcome, 'conflict');
    await withdraw(leaf);
    const raw = JSON.parse(await redis.get(PersonMemoryKeys.candidate(owner, leaf)));
    for (const change of [
      { state: 'partially_materialized' },
      { targetPersonId: 'person_bound_sample' },
      { replacesProposalId: 'person_candidate_missing' },
      { publication: { state: 'tombstoned', reason: 'test' } },
    ]) {
      await redis.set(PersonMemoryKeys.candidate(owner, leaf), JSON.stringify({ ...raw, ...change }));
      const preview = (await inspect(root)).json();
      assert.ok(['conflict', 'person_bound'].includes(preview.outcome), JSON.stringify(preview));
    }
    await redis.set(PersonMemoryKeys.candidate(owner, leaf), JSON.stringify(raw));
    assert.equal((await inspect(root)).json().outcome, 'eligible');
    await redis.set(PersonMemoryKeys.candidatePerson(owner, leaf), 'person_retained_binding');
    assert.equal((await inspect(root)).json().outcome, 'person_bound');
  });

  it('rejects a changed scope instead of sweeping in a new successor', async () => {
    const root = await seed('person_candidate_version_root');
    await withdraw(root);
    const preview = (await inspect(root)).json();
    const key = PersonMemoryKeys.candidate(owner, root);
    const raw = JSON.parse(await redis.get(key));
    await redis.set(key, JSON.stringify({ ...raw, closedAt: raw.closedAt + 1 }));
    const response = await forget(root, preview.revision);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().outcome, 'stale_revision');
    assert.ok(await store.getCandidateForOwner(owner, root));
  });

  it('discovers published legacy closures in the same owner index without exposing staged or tombstoned records', async () => {
    const id = await seed('person_candidate_legacy');
    await withdraw(id);
    const key = PersonMemoryKeys.candidate(owner, id);
    const raw = JSON.parse(await redis.get(key));
    await redis.set(key, JSON.stringify({ ...raw, publication: { state: 'legacy_unanchored' } }));
    await redis.zrem(PersonMemoryKeys.settled(owner), id);
    const adapter = new F276ApprovalAdapter(store);
    let result;
    for (let n = 0; n < 5; n++) {
      try {
        result = await adapter.listSettledPage(owner, { limit: 30 });
        break;
      } catch (error) {
        if (error.code !== 'APPROVAL_HISTORY_PREPARING') throw error;
      }
    }
    assert.equal(result.records[0]?.proposalId, id);
    assert.equal(result.records[0].navigation.state, 'legacy_unanchored');
    assert.ok(!JSON.stringify(result.records).includes('Sample person'));
    assert.equal((await inspect(id)).json().outcome, 'eligible');
    for (const state of ['staged', 'tombstoned']) {
      await redis.set(key, JSON.stringify({ ...raw, publication: { state } }));
      assert.equal((await inspect(id)).json().outcome, 'conflict');
    }
  });
});
