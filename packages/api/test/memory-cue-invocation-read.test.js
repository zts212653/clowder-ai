import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

const OWNER = 'owner-1';
const OTHER = 'owner-2';
const THREAD = 'thread-1';
const OTHER_THREAD = 'thread-2';
const INVOCATION = 'invocation-1';

let seq = 0;

function consumption(overrides = {}) {
  seq += 1;
  return {
    eventId: `event-${seq}`,
    idempotencyKey: `idempotency-${seq}`,
    cueId: 'cue-1',
    opportunityId: `opportunity-${seq}`,
    scope: { ownerUserId: OWNER, threadId: THREAD, invocationId: INVOCATION },
    consumerCatId: 'kimi',
    resolverFamily: 'person_entity',
    sourceAnchor: 'person:alden',
    sourceRevision: 'revision-1',
    axis: 'consumption',
    consumptionOutcome: 'presented',
    catalogVersion: 1,
    resolverVersion: 1,
    occurredAt: 1_000 + seq,
    ...overrides,
  };
}

function invalidation(overrides = {}) {
  const base = consumption(overrides);
  delete base.consumptionOutcome;
  return { ...base, axis: 'invalidation', invalidationReason: 'source_corrected', ...overrides };
}

describe('F321 A1: GET /api/threads/:threadId/invocations/:invocationId/memory-cues', () => {
  let app;
  let db;
  let episodeStore;
  let invocationRecords;
  let turnExecutions;

  beforeEach(async () => {
    const { applyMigrations } = await import('../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore } = await import('../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const { memoryCueInvocationReadRoutes } = await import('../dist/routes/memory-cue-invocation-read.js');

    db = new Database(':memory:');
    applyMigrations(db);
    episodeStore = new MemoryCueEpisodeStore(db, { nowIso: () => '2026-09-26T00:00:00.000Z' });

    const threads = new Map([
      [THREAD, { id: THREAD, createdBy: OWNER }],
      [OTHER_THREAD, { id: OTHER_THREAD, createdBy: OTHER }],
      // DEFAULT_THREAD_ID is the only system-created thread canAccessThread shares globally.
      ['default', { id: 'default', createdBy: 'system' }],
    ]);
    const threadStore = {
      async get(id) {
        return threads.get(id) ?? null;
      },
      async list(userId) {
        return [...threads.values()].filter((t) => t.createdBy === userId || t.id === 'default');
      },
    };

    invocationRecords = new Map([
      [INVOCATION, { id: INVOCATION, userId: OWNER, threadId: THREAD }],
      ['invocation-2', { id: 'invocation-2', userId: OWNER, threadId: THREAD }],
    ]);
    turnExecutions = new Map();

    app = Fastify({ logger: false });
    await app.register(memoryCueInvocationReadRoutes, {
      evidenceDb: db,
      threadStore,
      invocationRecordStore: { get: async (id) => invocationRecords.get(id) ?? null },
      turnExecutionStore: { get: async (id) => turnExecutions.get(id) ?? null },
    });
    await app.ready();
  });

  function get(threadId, invocationId, headers = { 'x-cat-cafe-user': OWNER }) {
    return app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/invocations/${invocationId}/memory-cues`,
      headers,
    });
  }

  it('requires identity and thread access (401/404/403 fail-closed chain)', async () => {
    episodeStore.append(consumption());

    const noIdentity = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD}/invocations/${INVOCATION}/memory-cues`,
    });
    assert.equal(noIdentity.statusCode, 401);

    const missingThread = await get('thread-missing', INVOCATION);
    assert.equal(missingThread.statusCode, 404);

    const foreignThread = await get(OTHER_THREAD, INVOCATION);
    assert.equal(foreignThread.statusCode, 403);
  });

  it('RED guard 1: another owner’s invocation in a shared thread returns zero of the owner’s events', async () => {
    invocationRecords.set(INVOCATION, { id: INVOCATION, userId: OTHER, threadId: 'default' });
    invocationRecords.set('invocation-owner', { id: 'invocation-owner', userId: OWNER, threadId: 'default' });
    // Owner's cue presented in the shared default thread.
    episodeStore.append(
      consumption({ scope: { ownerUserId: OWNER, threadId: 'default', invocationId: 'invocation-owner' } }),
    );
    // The other owner's own cue in the same shared thread and same invocation slot.
    episodeStore.append(
      consumption({
        cueId: 'cue-other',
        sourceAnchor: 'person:other-own-cue',
        scope: { ownerUserId: OTHER, threadId: 'default', invocationId: INVOCATION },
      }),
    );

    const res = await get('default', INVOCATION, { 'x-cat-cafe-user': OTHER });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.cues.length, 1);
    assert.equal(body.cues[0].cueId, 'cue-other');
    // None of the owner's coordinates may leak into the non-owner response.
    assert.equal(JSON.stringify(body).includes('person:alden'), false);
    const denied = await get('default', INVOCATION, { 'x-cat-cafe-user': OWNER });
    assert.equal(denied.statusCode, 403);
  });

  it('RED guard 1b: cross-thread/cross-invocation queries on the owner thread return only matching events', async () => {
    episodeStore.append(consumption({ cueId: 'cue-here' }));
    episodeStore.append(
      consumption({
        cueId: 'cue-other-invocation',
        scope: { ownerUserId: OWNER, threadId: THREAD, invocationId: 'invocation-2' },
      }),
    );

    const wrongInvocation = await get(THREAD, 'invocation-2');
    assert.equal(wrongInvocation.statusCode, 200);
    assert.deepEqual(
      wrongInvocation.json().cues.map((c) => c.cueId),
      ['cue-other-invocation'],
    );

    const empty = await get(THREAD, 'invocation-unknown');
    assert.equal(empty.statusCode, 404);
  });

  it('RED guard 1c: rejects an invocation whose canonical thread differs from the requested thread', async () => {
    invocationRecords.set(INVOCATION, { id: INVOCATION, userId: OWNER, threadId: OTHER_THREAD });
    episodeStore.append(consumption());
    const res = await get(THREAD, INVOCATION);
    assert.equal(res.statusCode, 404);
  });

  it('RED guard 1d: permits a scoped child turn only when its parent has the same owner and thread', async () => {
    turnExecutions.set('child-1', {
      invocationId: 'child-1',
      parentInvocationId: INVOCATION,
      userId: OWNER,
      threadId: THREAD,
    });
    episodeStore.append(consumption({ scope: { ownerUserId: OWNER, threadId: THREAD, invocationId: 'child-1' } }));
    assert.equal((await get(THREAD, 'child-1')).statusCode, 200);
    invocationRecords.set(INVOCATION, { id: INVOCATION, userId: OTHER, threadId: THREAD });
    assert.equal((await get(THREAD, 'child-1')).statusCode, 403);
  });

  it('RED guard 2: presented-only cue is reported as presented_unreported, never dismissed/ignored', async () => {
    episodeStore.append(consumption({ cueId: 'cue-unreported' }));
    episodeStore.append(consumption({ cueId: 'cue-applied' }));
    episodeStore.append(consumption({ cueId: 'cue-applied', consumptionOutcome: 'applied' }));
    episodeStore.append(consumption({ cueId: 'cue-dismissed' }));
    episodeStore.append(consumption({ cueId: 'cue-dismissed', consumptionOutcome: 'dismissed' }));
    episodeStore.append(consumption({ cueId: 'cue-drilled' }));
    episodeStore.append(consumption({ cueId: 'cue-drilled', consumptionOutcome: 'drilled' }));

    const res = await get(THREAD, INVOCATION);
    assert.equal(res.statusCode, 200);
    const byCue = new Map(res.json().cues.map((c) => [c.cueId, c]));
    assert.equal(byCue.get('cue-unreported').status, 'presented_unreported');
    assert.equal(byCue.get('cue-applied').status, 'applied');
    assert.equal(byCue.get('cue-dismissed').status, 'dismissed');
    assert.equal(byCue.get('cue-drilled').status, 'drilled');
    for (const cue of res.json().cues) {
      assert.notEqual(cue.status, 'ignored');
    }
  });

  it('RED guard 2b: later drill or presentation cannot erase a terminal outcome', async () => {
    episodeStore.append(consumption({ cueId: 'cue-terminal', occurredAt: 1_000 }));
    episodeStore.append(consumption({ cueId: 'cue-terminal', consumptionOutcome: 'applied', occurredAt: 2_000 }));
    episodeStore.append(consumption({ cueId: 'cue-terminal', consumptionOutcome: 'drilled', occurredAt: 3_000 }));
    episodeStore.append(consumption({ cueId: 'cue-terminal', consumptionOutcome: 'presented', occurredAt: 4_000 }));
    assert.equal((await get(THREAD, INVOCATION)).json().cues[0].status, 'applied');

    episodeStore.append(consumption({ cueId: 'cue-terminal', consumptionOutcome: 'dismissed', occurredAt: 5_000 }));
    episodeStore.append(consumption({ cueId: 'cue-terminal', consumptionOutcome: 'drilled', occurredAt: 6_000 }));
    assert.equal((await get(THREAD, INVOCATION)).json().cues[0].status, 'dismissed');
  });

  it('RED guard 3/4: response carries metadata only — no prompt, body, or private content fields', async () => {
    episodeStore.append(consumption({ cueId: 'cue-meta' }));
    episodeStore.append(invalidation({ cueId: 'cue-meta', invalidationReason: 'source_forgotten' }));

    const res = await get(THREAD, INVOCATION);
    assert.equal(res.statusCode, 200);
    const [cue] = res.json().cues;
    assert.equal(cue.status, 'invalidated');
    assert.equal(cue.invalidationReason, 'source_forgotten');

    const ALLOWED_KEYS = new Set([
      'cueId',
      'resolverFamily',
      'sourceAnchor',
      'sourceRevision',
      'consumerCatId',
      'status',
      'invalidationReason',
      'presentedAt',
      'lastEventAt',
    ]);
    for (const entry of res.json().cues) {
      for (const key of Object.keys(entry)) {
        assert.ok(ALLOWED_KEYS.has(key), `unexpected response field: ${key}`);
      }
    }
    const serialized = JSON.stringify(res.json());
    for (const forbidden of ['"prompt"', '"body"', '"whyNow"', '"summary"', '"title"', '"rationale"', '"sourceBody"']) {
      assert.equal(serialized.includes(forbidden), false, `response must not contain ${forbidden}`);
    }
  });

  it('store listByInvocation scopes by (owner, thread, invocation) and orders by occurred_at', async () => {
    episodeStore.append(consumption({ cueId: 'cue-b', occurredAt: 2_000 }));
    episodeStore.append(consumption({ cueId: 'cue-b', consumptionOutcome: 'applied', occurredAt: 3_000 }));
    episodeStore.append(consumption({ cueId: 'cue-a', occurredAt: 1_500 }));
    episodeStore.append(
      consumption({ cueId: 'cue-stray', scope: { ownerUserId: OTHER, threadId: THREAD, invocationId: INVOCATION } }),
    );
    episodeStore.append(
      consumption({
        cueId: 'cue-stray-2',
        scope: { ownerUserId: OWNER, threadId: OTHER_THREAD, invocationId: INVOCATION },
      }),
    );

    const events = episodeStore.listByInvocation(OWNER, THREAD, INVOCATION);
    assert.deepEqual(
      events.map((e) => `${e.cueId}:${e.consumptionOutcome}`),
      ['cue-a:presented', 'cue-b:presented', 'cue-b:applied'],
    );
    assert.equal(episodeStore.listByInvocation(OTHER, THREAD, INVOCATION).length, 1);
    assert.equal(episodeStore.listByInvocation(OWNER, OTHER_THREAD, INVOCATION).length, 1);
    assert.equal(episodeStore.listByInvocation(OWNER, THREAD, 'invocation-none').length, 0);
  });
});
