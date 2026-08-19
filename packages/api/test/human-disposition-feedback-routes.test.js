import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { buildHumanDispositionLedgerReceipt } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { HumanDispositionLedger } from '../dist/domains/human-disposition/HumanDispositionLedger.js';
import {
  buildPersonMemoryDispositionLedgerEntry,
  buildSessionHandoffDispositionLedgerEntry,
} from '../dist/domains/human-disposition/human-disposition-adapters.js';
import {
  HUMAN_DISPOSITION_RECEIPT_APPEND_LUA,
  humanDispositionReceiptAppendArguments,
} from '../dist/domains/human-disposition/human-disposition-lua.js';
import { registerHumanDispositionFeedbackRoutes } from '../dist/routes/human-disposition-feedback-routes.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f281-feedback-routes-test:';

function sessionEntry(id, decidedAt, ownerUserId = 'owner-a') {
  return buildSessionHandoffDispositionLedgerEntry({
    proposal: {
      proposalId: `proposal_${id}`,
      sourceSessionId: `session_${id}`,
      sourceCatId: 'codex-terra',
      userId: ownerUserId,
    },
    decidedAt,
    feedback: { reasonCode: 'wrong' },
  });
}

function personEntry(id, decidedAt, ownerUserId = 'owner-a') {
  const proofChar = String.fromCharCode(97 + (id.length % 20));
  return buildPersonMemoryDispositionLedgerEntry({
    canonical: { ownerUserId, requesterCatId: 'codex-sol' },
    proof: {
      opaqueLineageHandle: `f281_lineage_${proofChar.repeat(43)}`,
      opaqueProposalHandle: `f281_proposal_${'p'.repeat(43)}`,
      opaqueSupersessionHandle: `f281_supersession_${'s'.repeat(43)}`,
      opaqueDecisionReceiptHandle: `f281_receipt_${id.padEnd(43, '_').slice(0, 43)}`,
    },
    decidedAt,
    feedback: { reasonCode: 'bad_evidence' },
  });
}

function decodeCursor(cursor) {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

describe('F281 human disposition feedback routes', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let app;
  let redis;
  let ledger;
  let entries;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F281 human disposition feedback routes');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    entries = new Map();
    ledger = new HumanDispositionLedger(redis, {
      async loadEntry({ ownerUserId, receipt }) {
        return entries.get(`${ownerUserId}:${receipt.sourceRef}`) ?? null;
      },
    });
    app = Fastify();
    registerHumanDispositionFeedbackRoutes(app, { ledger });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    entries.clear();
  });

  async function append(entry) {
    entries.set(`${entry.episode.ownerUserId}:${entry.episode.sourceRef}`, entry);
    const receipt = buildHumanDispositionLedgerReceipt(entry);
    const call = humanDispositionReceiptAppendArguments(entry.episode.ownerUserId, receipt);
    assert.equal(
      await redis.eval(HUMAN_DISPOSITION_RECEIPT_APPEND_LUA, call.keys.length, ...call.keys, ...call.arguments),
      'APPLIED',
    );
  }

  const inject = (url, ownerUserId = 'owner-a') =>
    app.inject({
      method: 'GET',
      url,
      headers: ownerUserId ? { 'x-cat-cafe-user': ownerUserId } : {},
    });

  it('requires identity and rejects caller-selected ownership or invalid limits', async () => {
    assert.equal((await inject('/api/human-disposition-feedback/episodes', '')).statusCode, 401);
    assert.equal((await inject('/api/human-disposition-feedback/episodes?ownerUserId=owner-b')).statusCode, 400);
    assert.equal((await inject('/api/human-disposition-feedback/episodes?limit=0')).statusCode, 400);
    assert.equal((await inject('/api/human-disposition-feedback/episodes?limit=101')).statusCode, 400);
    assert.equal((await inject('/api/human-disposition-feedback/episodes?cursor=not-base64')).statusCode, 400);
  });

  it('returns only authenticated-owner entries newest first with exact filters and no aggregate fields', async () => {
    const session = sessionEntry('owner_session', 100);
    const person = personEntry('owner_person', 200);
    const foreign = sessionEntry('foreign', 300, 'owner-b');
    await append(session);
    await append(person);
    await append(foreign);

    const page = await inject('/api/human-disposition-feedback/episodes?limit=10');
    assert.equal(page.statusCode, 200);
    assert.deepEqual(
      page.json().entries.map((entry) => entry.episode.sourceRef),
      [person.episode.sourceRef, session.episode.sourceRef],
    );
    assert.equal(JSON.stringify(page.json()).includes('acceptance'), false);
    assert.equal(JSON.stringify(page.json()).includes('score'), false);

    const interaction = await inject(
      '/api/human-disposition-feedback/episodes?interactionKind=person_memory_proposal&limit=10',
    );
    assert.deepEqual(interaction.json().entries, [person]);
    const subject = await inject(
      `/api/human-disposition-feedback/episodes?subjectRef=${encodeURIComponent(session.episode.subjectRef)}&limit=10`,
    );
    assert.deepEqual(subject.json().entries, [session]);
    const exactMiss = await inject('/api/human-disposition-feedback/episodes?subjectRef=session_owner&limit=10');
    assert.deepEqual(exactMiss.json().entries, []);
  });

  it('traverses equal-millisecond pages exactly once with a filter-bound compound cursor', async () => {
    const sameMillisecond = [sessionEntry('a', 300), sessionEntry('b', 300), sessionEntry('c', 300)];
    for (const entry of sameMillisecond) await append(entry);
    const seen = [];
    let cursor;
    do {
      const query = new URLSearchParams({ limit: '1', interactionKind: 'session_handoff' });
      if (cursor) query.set('cursor', cursor);
      const page = await inject(`/api/human-disposition-feedback/episodes?${query}`);
      assert.equal(page.statusCode, 200);
      seen.push(...page.json().entries.map((entry) => entry.episode.sourceRef));
      cursor = page.json().nextCursor;
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

  it('advances filtered traversal by the last scanned member', async () => {
    const target = personEntry('filtered_target', 100);
    await append(target);
    const irrelevant = [];
    for (let index = 0; index < 20; index += 1) {
      const entry = sessionEntry(`filtered_${String(index).padStart(2, '0')}`, 200 + index);
      irrelevant.push(entry);
      await append(entry);
    }
    const first = await inject(
      '/api/human-disposition-feedback/episodes?interactionKind=person_memory_proposal&limit=1',
    );
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json().entries, []);
    assert.equal(
      decodeCursor(first.json().nextCursor).sourceRef,
      irrelevant.map((entry) => entry.episode.sourceRef).sort()[0],
    );
    const second = await inject(
      `/api/human-disposition-feedback/episodes?interactionKind=person_memory_proposal&limit=1&cursor=${first.json().nextCursor}`,
    );
    assert.deepEqual(second.json().entries, [target]);
  });

  it('fails closed on cursor truth or filter mismatch', async () => {
    const entry = sessionEntry('cursor', 400);
    await append(entry);
    const first = await inject('/api/human-disposition-feedback/episodes?limit=1');
    const cursor = decodeCursor(
      first.json().nextCursor ??
        encodeCursor({
          decidedAt: entry.episode.decidedAt,
          sourceRef: entry.episode.sourceRef,
        }),
    );

    const wrongScore = encodeCursor({ ...cursor, decidedAt: cursor.decidedAt + 1 });
    assert.equal(
      (await inject(`/api/human-disposition-feedback/episodes?limit=1&cursor=${wrongScore}`)).statusCode,
      400,
    );
    const filteredCursor = encodeCursor({ ...cursor, interactionKind: 'session_handoff' });
    assert.equal(
      (await inject(`/api/human-disposition-feedback/episodes?limit=1&cursor=${filteredCursor}`)).statusCode,
      400,
    );
  });

  it('fails the whole page when a producer entry is missing or mismatched', async () => {
    const valid = sessionEntry('valid', 500);
    const missing = sessionEntry('missing', 400);
    await append(valid);
    await append(missing);
    entries.delete(`owner-a:${missing.episode.sourceRef}`);

    const response = await inject('/api/human-disposition-feedback/episodes?limit=10');
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: 'ledger_invariant' });
    assert.equal(JSON.stringify(response.json()).includes(valid.episode.sourceRef), false);
  });

  it('returns 503 when the durable ledger is unavailable', async () => {
    const unavailable = Fastify();
    registerHumanDispositionFeedbackRoutes(unavailable, { ledger: null });
    await unavailable.ready();
    const response = await unavailable.inject({
      method: 'GET',
      url: '/api/human-disposition-feedback/episodes',
      headers: { 'x-cat-cafe-user': 'owner-a' },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'durable_store_unavailable' });
    await unavailable.close();
  });
});
