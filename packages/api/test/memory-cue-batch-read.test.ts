import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MemoryCueEpisodeStore } from '../src/domains/memory/cue/MemoryCueEpisodeStore.js';
import { applyMigrations } from '../src/domains/memory/schema.js';
import { memoryCueInvocationReadRoutes } from '../src/routes/memory-cue-invocation-read.js';

const OWNER = 'cue-owner';
const OTHER = 'other-owner';
const THREAD = 'cue-thread';
async function fixture(t: TestContext) {
  const db = new Database(':memory:');
  applyMigrations(db);
  const episodes = new MemoryCueEpisodeStore(db);
  const thread = { id: THREAD, createdBy: OWNER, deletedAt: undefined as number | undefined };
  const parents = new Map(
    Array.from({ length: 101 }, (_, i) => [
      `inv-${i}`,
      {
        id: `inv-${i}`,
        userId: OWNER,
        threadId: THREAD,
        targetCats: ['sonnet'],
      },
    ]),
  );
  const children = new Map<string, { userId: string; threadId: string; parentInvocationId: string; catId: string }>();
  let sequence = 0;
  const append = (
    invocationId: string,
    outcome: 'presented' | 'drilled' | 'applied' | 'dismissed',
    matter = false,
  ): void => {
    if (outcome !== 'presented') append(invocationId, 'presented', matter);
    episodes.append({
      eventId: `event-${++sequence}`,
      idempotencyKey: `key-${sequence}`,
      cueId: `cue-${invocationId}`,
      opportunityId: `opp-${invocationId}`,
      scope: { ownerUserId: OWNER, threadId: THREAD, invocationId },
      consumerCatId: 'sonnet',
      resolverFamily: matter ? 'matter' : 'person_entity',
      sourceAnchor: matter ? 'matter:one' : `person:${invocationId}`,
      sourceRevision: 'r1',
      axis: 'consumption',
      consumptionOutcome: outcome,
      occurredAt: sequence,
      catalogVersion: 1,
      resolverVersion: 1,
      ...(matter
        ? {
            readOrigin: 'explicit_read' as const,
            readDetails: {
              matterId: 'one',
              pageRevision: 1,
              entries: [{ entryId: 'entry-one', sourceRevision: 'source-r1' }],
            },
          }
        : {}),
    });
  };
  let matterStatus = 'current';
  let revokeOnRead = false;
  let onMatterRead = () => {};
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-test-owner-session'])
      request.sessionUserId = String(request.headers['x-test-owner-session']);
  });
  await app.register(memoryCueInvocationReadRoutes, {
    evidenceDb: db,
    threadStore: { get: async (id: string) => (id === THREAD ? thread : null), list: async () => [thread] },
    invocationRecordStore: { get: async (id: string) => parents.get(id) ?? null },
    turnExecutionStore: { get: async (id: string) => children.get(id) ?? null },
    matterMemoryService: {
      readReceipt: async (owner: string, cat: string) => {
        assert.equal(owner, OWNER);
        assert.equal(cat, 'sonnet');
        if (revokeOnRead) thread.createdBy = OTHER;
        onMatterRead();
        if (matterStatus === 'changed') return { status: 'changed' };
        if (matterStatus !== 'current') return { status: 'not_available' };
        return {
          status: 'current',
          page: {
            matter: { matterId: 'one', title: 'Current matter title' },
            entries: [
              { source: { threadId: 'source', messageId: 'm-one' } },
              { source: { threadId: 'source', messageId: 'm-one' } },
              { source: { threadId: 'source', messageId: 'm-two' } },
            ],
          },
        };
      },
    },
  });
  t.after(async () => {
    await app.close();
    db.close();
  });
  const get = (ids: string[], headers: Record<string, string> = { 'x-cat-cafe-user': OWNER }) =>
    app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD}/memory-cues?invocationIds=${encodeURIComponent(JSON.stringify(ids))}`,
      headers,
    });
  return {
    app,
    get,
    parents,
    children,
    append,
    thread,
    setMatterStatus: (value: string) => {
      matterStatus = value;
    },
    revokeOnMatterRead: () => {
      revokeOnRead = true;
    },
    onMatterRead: (read: () => void) => {
      onMatterRead = read;
    },
  };
}

test('one bounded batch retains every invocation and the legacy consumption projection', async (t) => {
  const f = await fixture(t);
  const outcomes = ['presented', 'drilled', 'applied', 'dismissed'] as const;
  for (let i = 0; i < 101; i++) f.append(`inv-${i}`, outcomes[i % 4]);
  const ids = Array.from({ length: 100 }, (_, i) => `inv-${i}`);
  const batch = await f.get(ids);
  assert.equal(batch.statusCode, 200);
  assert.equal(batch.json().invocations.length, 100);
  assert.equal(JSON.stringify(batch.json()).includes('person:inv-100'), false);
  for (const row of batch.json().invocations.slice(0, 4)) {
    const single = await f.app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD}/invocations/${row.invocationId}/memory-cues`,
      headers: { 'x-cat-cafe-user': OWNER },
    });
    assert.equal(row.status, 200);
    assert.deepEqual(row.cues, single.json().cues);
  }
});

test('batch query and identity bounds fail closed before projection', async (t) => {
  const f = await fixture(t);
  for (const value of [
    'not-json',
    '[]',
    '[1]',
    JSON.stringify(Array.from({ length: 101 }, (_, i) => `inv-${i}`)),
    ' '.repeat(16_385),
  ]) {
    const response = await f.app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD}/memory-cues?invocationIds=${encodeURIComponent(value)}`,
      headers: { 'x-cat-cafe-user': OWNER },
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal((await f.get(['inv-0'], {})).statusCode, 401);
  assert.equal((await f.get(['inv-0'], { 'x-cat-cafe-user': OTHER })).statusCode, 403);
});

test('mixed batches expose per-invocation failures without leaking another owner or scope', async (t) => {
  const f = await fixture(t);
  f.append('inv-0', 'presented');
  f.parents.set('foreign-owner', { id: 'foreign-owner', userId: OTHER, threadId: THREAD, targetCats: ['sonnet'] });
  f.parents.set('foreign-thread', {
    id: 'foreign-thread',
    userId: OWNER,
    threadId: 'elsewhere',
    targetCats: ['sonnet'],
  });
  f.children.set('bad-child', {
    userId: OWNER,
    threadId: THREAD,
    parentInvocationId: 'foreign-thread',
    catId: 'sonnet',
  });
  const response = await f.get(['inv-0', 'foreign-owner', 'foreign-thread', 'bad-child', 'missing']);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().invocations.map((row: { status: number }) => row.status),
    [200, 403, 404, 409, 404],
  );
  assert.equal(response.json().invocations[0].cues.length, 1);
  assert.ok(
    response
      .json()
      .invocations.slice(1)
      .every((row: { cues?: unknown }) => row.cues === undefined),
  );
});

test('batch Matter summaries retain session, cat binding and current correction checks', async (t) => {
  const f = await fixture(t);
  f.append('inv-0', 'drilled', true);
  const legacyIdentity = await f.get(['inv-0']);
  assert.equal(legacyIdentity.statusCode, 200);
  assert.deepEqual(legacyIdentity.json().invocations[0].cues, []);
  const headers = { 'x-test-owner-session': OWNER, 'x-cat-cafe-user': OTHER };
  const current = (await f.get(['inv-0'], headers)).json().invocations[0].cues[0];
  assert.deepEqual(current.matterRead, {
    status: 'current',
    matterId: 'one',
    title: 'Current matter title',
    messageCount: 2,
  });
  assert.equal(current.readDetails, undefined);
  f.setMatterStatus('changed');
  assert.equal((await f.get(['inv-0'], headers)).json().invocations[0].cues[0].matterRead.status, 'changed');
  f.setMatterStatus('not_available');
  const unavailable = (await f.get(['inv-0'], headers)).json().invocations[0].cues[0];
  assert.equal(unavailable.sourceAnchor, '');
  const invocation = f.parents.get('inv-0');
  assert.ok(invocation);
  invocation.targetCats = ['codex61-sol'];
  assert.deepEqual((await f.get(['inv-0'], headers)).json().invocations[0].cues, []);
});

test('a thread revoked while asynchronous Matter projection runs cannot publish its batch', async (t) => {
  const f = await fixture(t);
  f.append('inv-0', 'drilled', true);
  f.revokeOnMatterRead();
  const response = await f.get(['inv-0'], { 'x-test-owner-session': OWNER });
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.includes('Current matter title'), false);
});

test('an earlier invocation revoked while a later cue is projected cannot escape in the completed batch', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) f.append(`inv-${i}`, 'presented');
  f.append('inv-4', 'drilled', true);
  f.onMatterRead(() => {
    const first = f.parents.get('inv-0');
    assert.ok(first);
    first.userId = OTHER;
  });
  const response = await f.get(['inv-0', 'inv-1', 'inv-2', 'inv-3', 'inv-4'], { 'x-test-owner-session': OWNER });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().invocations[0].status, 403);
  assert.equal(response.json().invocations[0].cues, undefined);
  assert.equal(response.body.includes('person:inv-0'), false);
  assert.equal(response.json().invocations[1].status, 200);
});

test('an earlier Matter summary is revalidated after a later batch item observes a correction', async (t) => {
  const f = await fixture(t);
  f.append('inv-0', 'drilled', true);
  f.append('inv-4', 'drilled', true);
  let reads = 0;
  f.onMatterRead(() => {
    if (++reads >= 2) f.setMatterStatus('changed');
  });
  const response = await f.get(['inv-0', 'inv-1', 'inv-2', 'inv-3', 'inv-4'], {
    'x-test-owner-session': OWNER,
  });
  assert.equal(response.statusCode, 200);
  const first = response.json().invocations[0];
  assert.equal(first.status, 200);
  assert.deepEqual(first.cues[0].matterRead, { status: 'changed', matterId: 'one' });
  assert.equal(JSON.stringify(first).includes('Current matter title'), false);
});

test('request cancellation during a source read cannot publish a late successful batch', async (t) => {
  const f = await fixture(t);
  f.append('inv-0', 'drilled', true);
  f.app.addHook('onRequest', async (request) => {
    f.onMatterRead(() => request.raw.emit('aborted'));
  });
  const response = await f.get(['inv-0'], { 'x-test-owner-session': OWNER });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().invocations, undefined);
  assert.equal(response.body.includes('Current matter title'), false);
});

test('final source revalidation cannot revoke an invocation already checked for publication', async (t) => {
  const f = await fixture(t);
  f.append('inv-0', 'presented');
  f.append('inv-4', 'drilled', true);
  let reads = 0;
  f.onMatterRead(() => {
    if (++reads === 2) {
      const first = f.parents.get('inv-0');
      assert.ok(first);
      first.userId = OTHER;
    }
  });
  const response = await f.get(['inv-0', 'inv-1', 'inv-2', 'inv-3', 'inv-4'], { 'x-test-owner-session': OWNER });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().invocations[0].status, 403);
  assert.equal(response.body.includes('person:inv-0'), false);
});
