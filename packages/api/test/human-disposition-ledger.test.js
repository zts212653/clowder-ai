import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { buildHumanDispositionLedgerReceipt } from '@cat-cafe/shared';
import { HumanDispositionLedger } from '../dist/domains/human-disposition/HumanDispositionLedger.js';
import {
  buildPersonMemoryDispositionLedgerEntry,
  buildSessionHandoffDispositionLedgerEntry,
} from '../dist/domains/human-disposition/human-disposition-adapters.js';
import { HumanDispositionKeys } from '../dist/domains/human-disposition/human-disposition-keys.js';
import {
  HUMAN_DISPOSITION_RECEIPT_APPEND_LUA,
  humanDispositionReceiptAppendArguments,
} from '../dist/domains/human-disposition/human-disposition-lua.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f281-ledger-test:';
const PERSON_PROOF = {
  opaqueLineageHandle: `f281_lineage_${'a'.repeat(43)}`,
  opaqueProposalHandle: `f281_proposal_${'b'.repeat(43)}`,
  opaqueSupersessionHandle: `f281_supersession_${'c'.repeat(43)}`,
  opaqueDecisionReceiptHandle: `f281_receipt_${'d'.repeat(43)}`,
};
const NO_FEEDBACK = Symbol('no-feedback');

function sessionEntry(id, decidedAt, feedback = { reasonCode: 'wrong' }, ownerUserId = 'owner-a') {
  return buildSessionHandoffDispositionLedgerEntry({
    proposal: {
      proposalId: `proposal_${id}`,
      sourceSessionId: `session_${id}`,
      sourceCatId: 'codex-terra',
      userId: ownerUserId,
    },
    decidedAt,
    ...(feedback === NO_FEEDBACK ? {} : { feedback }),
  });
}

describe('F281 HumanDispositionLedger', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let entries;
  let ledger;
  let hydrationCalls;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F281 HumanDispositionLedger');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    entries = new Map();
    hydrationCalls = [];
    ledger = new HumanDispositionLedger(redis, {
      async loadEntry({ ownerUserId, receipt }) {
        hydrationCalls.push({ ownerUserId, sourceRef: receipt.sourceRef });
        return entries.get(`${ownerUserId}:${receipt.sourceRef}`) ?? null;
      },
    });
  });

  async function append(entry) {
    entries.set(`${entry.episode.ownerUserId}:${entry.episode.sourceRef}`, entry);
    const receipt = buildHumanDispositionLedgerReceipt(entry);
    const call = humanDispositionReceiptAppendArguments(entry.episode.ownerUserId, receipt);
    return redis.eval(HUMAN_DISPOSITION_RECEIPT_APPEND_LUA, call.keys.length, ...call.keys, ...call.arguments);
  }

  it('appends, reads, and lists an owner receipt through producer hydration', async () => {
    const entry = sessionEntry('read', 101);
    assert.equal(await append(entry), 'APPLIED');

    assert.deepEqual(await ledger.get('owner-a', entry.episode.sourceRef), entry);
    assert.deepEqual((await ledger.listByOwner('owner-a', { limit: 10 })).entries, [entry]);
    assert.deepEqual((await ledger.listBySubject('owner-a', 'session_read', { limit: 10 })).entries, [entry]);
    assert.equal(hydrationCalls.length, 3);
  });

  it('orders newest first with a deterministic member tie-break', async () => {
    const sameMillisecond = [sessionEntry('a', 200), sessionEntry('c', 200), sessionEntry('b', 200)];
    for (const entry of sameMillisecond) await append(entry);

    const page = await ledger.listByOwner('owner-a', { limit: 10 });
    const expected = sameMillisecond
      .map((entry) => entry.episode.sourceRef)
      .sort()
      .reverse();
    assert.deepEqual(
      page.entries.map((entry) => entry.episode.sourceRef),
      expected,
    );
  });

  it('paginates equal-millisecond entries without a skip or repeat', async () => {
    const sameMillisecond = [sessionEntry('a', 300), sessionEntry('b', 300), sessionEntry('c', 300)];
    for (const entry of sameMillisecond) await append(entry);

    const seen = [];
    let cursor;
    do {
      const page = await ledger.listByOwner('owner-a', { limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.entries.map((entry) => entry.episode.sourceRef));
      cursor = page.nextCursor;
    } while (cursor);

    assert.deepEqual(
      seen,
      sameMillisecond
        .map((entry) => entry.episode.sourceRef)
        .sort()
        .reverse(),
    );
    assert.equal(new Set(seen).size, 3);
  });

  it('returns the last scanned filtered member as the next cursor', async () => {
    const newest = sessionEntry('newest', 300);
    const poisoned = sessionEntry('poisoned', 200);
    const oldest = sessionEntry('oldest', 100);
    for (const entry of [newest, poisoned, oldest]) await append(entry);
    await redis.hset(
      HumanDispositionKeys.receipts('owner-a'),
      poisoned.episode.sourceRef,
      '{"not":"a strict receipt"}',
    );

    const first = await ledger.listByOwner('owner-a', { limit: 2, scanLimit: 2 });
    assert.deepEqual(first.entries, [newest]);
    assert.deepEqual(first.nextCursor, { decidedAt: 200, sourceRef: poisoned.episode.sourceRef });
    const second = await ledger.listByOwner('owner-a', { limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.entries, [oldest]);
  });

  it('classifies byte-exact receipt replay and changed-source conflict', async () => {
    const entry = sessionEntry('replay', 400);
    assert.equal(await append(entry), 'APPLIED');
    assert.equal(await append(entry), 'REPLAY');

    const changed = sessionEntry('replay', 401);
    entries.set(`owner-a:${changed.episode.sourceRef}`, changed);
    const receipt = buildHumanDispositionLedgerReceipt(changed);
    const call = humanDispositionReceiptAppendArguments('owner-a', receipt);
    assert.equal(
      await redis.eval(HUMAN_DISPOSITION_RECEIPT_APPEND_LUA, call.keys.length, ...call.keys, ...call.arguments),
      'CONFLICT',
    );
  });

  it('hydrates episode-only entries and retains other feedback without auto-filtering history', async () => {
    const episodeOnly = sessionEntry('skip', 500, NO_FEEDBACK);
    const other = sessionEntry('other', 501, { reasonCode: 'other', detail: '保留给历史查看' });
    await append(episodeOnly);
    await append(other);

    const page = await ledger.listByOwner('owner-a', { limit: 10 });
    assert.equal(page.entries[0].envelope.feedback.reasonCode, 'other');
    assert.equal(page.entries[1].envelope, undefined);
  });

  it('persists only content-free F281 receipts and indexes with no TTL', async () => {
    const entry = buildPersonMemoryDispositionLedgerEntry({
      canonical: { ownerUserId: 'owner-a', requesterCatId: 'codex-sol' },
      proof: PERSON_PROOF,
      decidedAt: 600,
      feedback: { reasonCode: 'other', detail: 'private feedback detail' },
      candidateId: 'private_candidate',
    });
    await append(entry);

    const keys = [
      HumanDispositionKeys.receipts('owner-a'),
      HumanDispositionKeys.episodes('owner-a'),
      HumanDispositionKeys.subject('owner-a', PERSON_PROOF.opaqueLineageHandle),
    ];
    const stored = await Promise.all([
      redis.hgetall(keys[0]),
      redis.zrange(keys[1], 0, -1),
      redis.zrange(keys[2], 0, -1),
    ]);
    const serialized = JSON.stringify(stored);
    for (const forbidden of ['private feedback detail', 'private_candidate', 'reasonCode', 'codex-sol']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(await Promise.all(keys.map((key) => redis.ttl(key))), [-1, -1, -1]);
  });

  it('isolates identical source lookups by authenticated owner', async () => {
    const entry = sessionEntry('owner', 700);
    await append(entry);

    assert.equal(await ledger.get('owner-b', entry.episode.sourceRef), null);
    assert.deepEqual((await ledger.listByOwner('owner-b', { limit: 10 })).entries, []);
    assert.equal(
      hydrationCalls.some((call) => call.ownerUserId === 'owner-b'),
      false,
    );
  });

  it('fails closed on poisoned receipt JSON without returning an instruction', async () => {
    const entry = sessionEntry('poison', 800);
    await append(entry);
    await redis.hset(HumanDispositionKeys.receipts('owner-a'), entry.episode.sourceRef, '{"bad":');

    assert.equal(await ledger.get('owner-a', entry.episode.sourceRef), null);
    assert.deepEqual((await ledger.listByOwner('owner-a', { limit: 10 })).entries, []);
  });

  it('rejects wrong-type receipt or index keys before any append write', async (context) => {
    for (const poisonedSlot of ['receipts', 'episodes', 'subject']) {
      await context.test(poisonedSlot, async () => {
        await cleanupClientKeyspace(redis);
        const entry = sessionEntry(`wrong_type_${poisonedSlot}`, 900);
        const receipt = buildHumanDispositionLedgerReceipt(entry);
        const keys = {
          receipts: HumanDispositionKeys.receipts('owner-a'),
          episodes: HumanDispositionKeys.episodes('owner-a'),
          subject: HumanDispositionKeys.subject('owner-a', entry.episode.subjectRef),
        };
        await redis.set(keys[poisonedSlot], 'poison');
        const call = humanDispositionReceiptAppendArguments('owner-a', receipt);
        assert.equal(
          await redis.eval(HUMAN_DISPOSITION_RECEIPT_APPEND_LUA, call.keys.length, ...call.keys, ...call.arguments),
          'TYPE_CONFLICT',
        );
        assert.equal(await redis.get(keys[poisonedSlot]), 'poison');
        for (const [slot, key] of Object.entries(keys)) {
          if (slot !== poisonedSlot) assert.equal(await redis.exists(key), 0);
        }
      });
    }
  });
});
