import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import {
  DEFERRED_RECEIPT_OWNER_FORGET_PREPARE_LUA,
  DEFERRED_RECEIPT_WITHDRAW_LUA,
} from '../dist/domains/memory/deferred-person-memory-redis-contract.js';
import { PersonMemoryKeys } from '../dist/domains/memory/people/person-memory-keys.js';
import { REDACT_ITEM_LUA } from '../dist/domains/memory/people/person-memory-lifecycle-lua.js';
import {
  personClaimOwnerRevision,
  personInteractionOwnerRevision,
} from '../dist/domains/memory/people/person-memory-owner-revision.js';
import { RedisPersonMemoryStore } from '../dist/domains/memory/people/RedisPersonMemoryStore.js';
import { RedisDeferredPersonMemoryReceiptStore } from '../dist/domains/memory/RedisDeferredPersonMemoryReceiptStore.js';
import { personMemoryOwnerReadRoutes } from '../dist/routes/person-memory-owner-read.js';
import {
  auth,
  claim,
  event,
  origin,
  owner,
  personId,
  relationship,
  requestId,
  source,
} from './helpers/person-owner-maintenance-records.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

describe('owner person maintenance', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  let redis, people, deferred, app;
  async function makeApp(extra = {}) {
    const instance = Fastify();
    instance.addHook('onRequest', async (request) => {
      request.sessionUserId = request.headers['x-test-session'];
      request.sessionBindingId = 'session-maintenance';
      request.sessionCsrfToken = 'csrf-maintenance';
    });
    await instance.register(personMemoryOwnerReadRoutes, {
      ownerUserId: owner,
      store: people,
      deferredReceiptStore: deferred,
      messageStore: {},
      threadStore: {},
      ...extra,
    });
    await instance.ready();
    return instance;
  }
  const body = (item = { kind: 'claim', id: claim.claimId }) => ({
    action: 'redact_item',
    item,
    requestId,
    expectedRevision: item.kind === 'claim' ? personClaimOwnerRevision(claim) : personInteractionOwnerRevision(event),
    confirmed: true,
  });
  const redact = (payload = body(), headers = auth) =>
    app.inject({ method: 'POST', url: `/api/memory/people/${personId}/actions`, headers, payload });
  const act = (receiptId, action, expectedRevision, headers = auth) =>
    app.inject({
      method: 'POST',
      url: `/api/memory/people/deferred/${receiptId}/actions`,
      headers,
      payload: { action, requestId, expectedRevision, confirmed: true },
    });
  async function page() {
    let cursor = '0';
    const entries = new Map();
    do {
      const response = await app.inject({
        url: `/api/memory/people/deferred?limit=20&cursor=${cursor}`,
        headers: auth,
      });
      assert.equal(response.statusCode, 200, response.body);
      const data = response.json();
      for (const entry of data.entries) entries.set(entry.receiptId, entry);
      cursor = data.nextCursor;
    } while (cursor);
    return [...entries.values()];
  }
  async function seedDeferred(char = 'b', ready = false, ownerUserId = owner) {
    const result = await deferred.stage({
      receiptId: `deferred_person_${char.repeat(32)}`,
      ownerUserId,
      requesterCatId: 'codex61-sol',
      invocationId: 'invocation-maintenance',
      originMessageRef: source,
      subject: 'Sample subject',
      normalizedSubject: 'sample subject',
      registryBinding: { kind: 'registered_person', ref: personId },
      sourceCoordinates: [{ kind: 'message', sourceRef: source, resolvedDigest: 'c'.repeat(64) }],
      sourceBundleDigest: 'd'.repeat(64),
      dedupeHash: char.repeat(64),
      ready,
      createdAt: 10,
    });
    assert.equal(result.outcome, 'created');
    return result.receipt;
  }
  before(async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'owner maintenance');
    redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: 'owner-maintenance-test:' });
    await redis.ping();
    people = new RedisPersonMemoryStore(redis);
    deferred = new RedisDeferredPersonMemoryReceiptStore(redis);
    app = await makeApp();
  });
  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
    await redis.set(PersonMemoryKeys.claim(owner, claim.claimId), JSON.stringify(claim));
    await redis.set(PersonMemoryKeys.event(owner, event.eventId), JSON.stringify(event));
    await redis.set(PersonMemoryKeys.relationship(owner, relationship.relationshipId), JSON.stringify(relationship));
    await redis.set(PersonMemoryKeys.currentClaim(owner, personId, 'team'), claim.claimId);
  });
  after(async () => {
    await app?.close();
    if (redis) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });
  it('redacts the exact claim without needing a live source and replays before revision checks', async () => {
    const response = await redact();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().outcome, 'applied');
    const record = JSON.parse(await redis.get(PersonMemoryKeys.claim(owner, claim.claimId)));
    assert.equal(record.status, 'redacted');
    assert.deepEqual(record.payload, { kind: 'redacted' });
    assert.deepEqual(record.sourceRefs, []);
    assert.equal(await redis.get(PersonMemoryKeys.currentClaim(owner, personId, 'team')), null);
    assert.equal((await redact()).json().outcome, 'replayed');
    assert.equal(JSON.parse(await redis.get(PersonMemoryKeys.event(owner, event.eventId))).headline, event.headline);
    assert.equal(await redis.ttl(PersonMemoryKeys.redaction(owner, requestId)), -1);
  });
  it('requires browser owner/CSRF and explicit confirmation on both write paths', async () => {
    const receipt = await seedDeferred();
    for (const headers of [
      { origin },
      { ...auth, 'x-test-session': 'other' },
      { ...auth, 'x-csrf-token': 'wrong' },
      { ...auth, 'x-callback-token': 'cat-token' },
    ]) {
      assert.ok([401, 403].includes((await redact(body(), headers)).statusCode));
      assert.ok(
        [401, 403].includes((await act(receipt.receiptId, 'forget', `sha256:${'0'.repeat(64)}`, headers)).statusCode),
      );
    }
    assert.equal((await redact({ ...body(), confirmed: false })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/memory/people/deferred' })).statusCode, 401);
    assert.equal(
      (await app.inject({ url: '/api/memory/people/deferred', headers: { ...auth, 'x-test-session': 'other' } }))
        .statusCode,
      403,
    );
  });
  it('refuses a stale redaction and a foreign-person event without changing either record', async () => {
    assert.equal((await redact({ ...body(), expectedRevision: `sha256:${'0'.repeat(64)}` })).statusCode, 409);
    const result = await people.redactItem({
      ownerUserId: owner,
      personId: 'person_other',
      item: { kind: 'event', id: event.eventId },
      requestId,
      redactedAt: 20,
    });
    assert.equal(result.outcome, 'not_available');
    assert.equal(JSON.parse(await redis.get(PersonMemoryKeys.event(owner, event.eventId))).headline, event.headline);
  });
  it('atomically refuses a changed claim and rejects a reused request aimed at a different target', async () => {
    const originalEval = redis.eval.bind(redis);
    let raced = false;
    redis.eval = async (...args) => {
      if (args[0] === REDACT_ITEM_LUA && !raced) {
        raced = true;
        await redis.set(PersonMemoryKeys.claim(owner, claim.claimId), JSON.stringify({ ...claim, status: 'retired' }));
      }
      return originalEval(...args);
    };
    try {
      assert.equal((await redact()).statusCode, 409);
    } finally {
      redis.eval = originalEval;
    }
    await redis.set(PersonMemoryKeys.claim(owner, claim.claimId), JSON.stringify(claim));
    assert.equal((await redact()).statusCode, 200);
    assert.equal((await redact(body({ kind: 'event', id: event.eventId }))).statusCode, 409);
  });
  it('refuses poisoned artifact bookkeeping before changing canonical payload', async () => {
    const before = await redis.get(PersonMemoryKeys.claim(owner, claim.claimId));
    await redis.set(PersonMemoryKeys.personArtifacts(owner, personId), 'wrong-type');
    const result = await redact();
    assert.equal(await redis.get(PersonMemoryKeys.claim(owner, claim.claimId)), before);
    assert.equal(await redis.get(PersonMemoryKeys.redaction(owner, requestId)), null);
    assert.equal(result.statusCode, 409);
  });
  it('lists awaiting, withdrawn and proposal-bound canonical receipts without leaking another owner or old payload', async () => {
    const active = await seedDeferred('1');
    const withdrawn = await seedDeferred('2');
    await deferred.withdraw(owner, withdrawn.receiptId, 20);
    await seedDeferred('3', false, 'another-owner');
    const bound = {
      receiptId: `deferred_person_${'4'.repeat(32)}`,
      ownerUserId: owner,
      requesterCatId: 'codex61-sol',
      state: 'proposed',
      dedupeHash: '4'.repeat(64),
      proposalId: 'person_candidate_bound',
      retention: 'owner_controlled_no_ttl',
      createdAt: 10,
      updatedAt: 20,
    };
    await redis.set(deferred.keys.receipt(owner, bound.receiptId), JSON.stringify(bound));
    const entries = await page();
    assert.deepEqual(
      entries.map((entry) => entry.receiptId).sort(),
      [active.receiptId, withdrawn.receiptId, bound.receiptId].sort(),
    );
    assert.equal(entries.find((entry) => entry.receiptId === withdrawn.receiptId).subject, undefined);
    assert.equal(entries.find((entry) => entry.receiptId === bound.receiptId).proposalId, bound.proposalId);
  });
  it('withdraws, clears payload, then permanently forgets the same exact receipt with idempotent replay', async () => {
    const receipt = await seedDeferred();
    const initial = (await page())[0];
    const result = await act(receipt.receiptId, 'withdraw', initial.revision);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().outcome, 'applied');
    assert.equal((await act(receipt.receiptId, 'withdraw', initial.revision)).json().outcome, 'replayed');
    const withdrawn = await deferred.get(owner, receipt.receiptId);
    assert.equal(withdrawn.state, 'withdrawn');
    assert.equal(withdrawn.subject, undefined);
    const current = (await page())[0];
    assert.equal((await act(receipt.receiptId, 'forget', current.revision)).json().outcome, 'applied');
    assert.equal((await act(receipt.receiptId, 'forget', current.revision)).json().outcome, 'replayed');
    assert.equal(await deferred.get(owner, receipt.receiptId), null);
    assert.equal(await redis.get(deferred.keys.owner(receipt.receiptId)), null);
  });
  it('refuses state races and proposal-bound receipts without claiming a successful deletion', async () => {
    const receipt = await seedDeferred('b', true);
    const initial = (await page())[0];
    await deferred.claim({
      ownerUserId: owner,
      receiptId: receipt.receiptId,
      claimId: 'claim-race',
      now: 15,
      leaseMs: 100,
      processorCatId: 'codex61-sol',
      processingThreadId: 'thread-clerk',
    });
    assert.equal((await act(receipt.receiptId, 'forget', initial.revision)).statusCode, 409);
    const bound = {
      receiptId: receipt.receiptId,
      ownerUserId: owner,
      requesterCatId: 'codex61-sol',
      state: 'proposed',
      dedupeHash: receipt.dedupeHash,
      proposalId: 'person_candidate_bound',
      retention: 'owner_controlled_no_ttl',
      createdAt: 10,
      updatedAt: 20,
    };
    await redis.set(deferred.keys.receipt(owner, receipt.receiptId), JSON.stringify(bound));
    const result = await act(receipt.receiptId, 'forget', initial.revision);
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error, 'proposal_bound');
    assert.equal(result.json().proposalId, bound.proposalId);
  });
  it('checks the exact deferred snapshot before either owner terminal commitment', async () => {
    for (const [action, lua, char] of [
      ['withdraw', DEFERRED_RECEIPT_WITHDRAW_LUA, '5'],
      ['forget', DEFERRED_RECEIPT_OWNER_FORGET_PREPARE_LUA, '6'],
    ]) {
      const receipt = await seedDeferred(char);
      const initial = (await page()).find((entry) => entry.receiptId === receipt.receiptId);
      const originalEval = redis.eval.bind(redis);
      let raced = false;
      redis.eval = async (...args) => {
        if (args[0] === lua && !raced) {
          raced = true;
          const current = await deferred.get(owner, receipt.receiptId);
          await redis.set(
            deferred.keys.receipt(owner, receipt.receiptId),
            JSON.stringify({ ...current, updatedAt: 25 }),
          );
        }
        return originalEval(...args);
      };
      try {
        assert.equal((await act(receipt.receiptId, action, initial.revision)).statusCode, 409);
      } finally {
        redis.eval = originalEval;
      }
      assert.equal(raced, true);
      assert.equal((await deferred.get(owner, receipt.receiptId)).subject, receipt.subject);
    }
  });
  it('does not equate an unreadable stored receipt with a successful prior forget', async () => {
    const receipt = await seedDeferred('9');
    const initial = (await page())[0];
    await redis.set(
      deferred.keys.receipt(owner, receipt.receiptId),
      JSON.stringify({ ...receipt, state: 'invalid-state' }),
    );
    const result = await act(receipt.receiptId, 'forget', initial.revision);
    assert.equal(result.statusCode, 503, result.body);
    assert.ok(await redis.get(deferred.keys.receipt(owner, receipt.receiptId)));
  });
  it('requires both lineage invalidation authorities before erasing a lineage-bearing receipt', async () => {
    const receipt = await seedDeferred('7');
    await deferred.withdraw(owner, receipt.receiptId, 20);
    const lineage = {
      reflexId: 'asr-person-memory',
      reflexVersion: 1,
      opportunityId: `write_opp_${'1'.repeat(32)}`,
      dedupeLineage: `write_lineage_${'2'.repeat(32)}`,
      generation: 1,
    };
    await redis.set(
      deferred.keys.receipt(owner, receipt.receiptId),
      JSON.stringify({ ...(await deferred.get(owner, receipt.receiptId)), writeOpportunityLineage: lineage }),
    );
    const initial = (await page())[0];
    assert.equal((await act(receipt.receiptId, 'withdraw', initial.revision)).statusCode, 503);
    assert.equal((await act(receipt.receiptId, 'forget', initial.revision)).statusCode, 503);
    assert.ok(await deferred.get(owner, receipt.receiptId));
    const calls = [];
    const secured = await makeApp({
      writeOpportunityTerminalLedger: {
        recordInvalidated: async (input) => {
          calls.push(input.dedupeLineage);
          assert.ok(await deferred.get(owner, receipt.receiptId));
        },
      },
      writeOpportunityDeliveryStore: {
        purgeLineage: async (who, id) => {
          assert.equal(who, owner);
          calls.push(id);
        },
      },
    });
    try {
      const result = await secured.inject({
        method: 'POST',
        url: `/api/memory/people/deferred/${receipt.receiptId}/actions`,
        headers: auth,
        payload: { action: 'forget', requestId, expectedRevision: initial.revision, confirmed: true },
      });
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(calls, [lineage.dedupeLineage, lineage.dedupeLineage]);
      assert.equal(await deferred.get(owner, receipt.receiptId), null);
    } finally {
      await secured.close();
    }
  });
  it('does not offer mailbox navigation for unpublished or tombstoned proposal records', async () => {
    const receipt = await seedDeferred('8');
    await deferred.withdraw(owner, receipt.receiptId, 20);
    const terminal = {
      ...(await deferred.get(owner, receipt.receiptId)),
      state: 'proposed',
      proposalId: 'person_candidate_bound',
    };
    await redis.set(deferred.keys.receipt(owner, receipt.receiptId), JSON.stringify(terminal));
    const originalRead = people.getCandidateForOwner;
    try {
      for (const publication of [
        { state: 'staged', stagedAt: 10 },
        { state: 'tombstoned', failedAt: 20, reason: 'unpublished' },
      ]) {
        people.getCandidateForOwner = async () => ({ state: 'withdrawn', publication });
        assert.equal((await page())[0].proposalSection, undefined);
      }
    } finally {
      people.getCandidateForOwner = originalRead;
    }
  });
});
