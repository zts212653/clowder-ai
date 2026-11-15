import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { EventMemoryStore } from '../dist/domains/memory/EventMemoryStore.js';
import { PersonMemoryRecallService } from '../dist/domains/memory/people/PersonMemoryRecallService.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { registerCallbackPersonMemoryRoutes } from '../dist/routes/callback-person-memory-routes.js';
import { eventsRoutes } from '../dist/routes/events.js';

const revision = `sha256:${'a'.repeat(64)}`;
const card = { personId: 'person_usage', displayName: 'Fixture', relationship: {}, claims: [], recentEvents: [] };
const principal = {
  kind: 'invocation',
  userId: 'owner',
  catId: 'codex61-sol',
  invocationId: 'inv_usage',
  threadId: 'thread_usage',
};

function fixture(t) {
  const db = new Database(':memory:');
  applyMigrations(db);
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    if (req.headers['x-test-callback'] === 'owner') req.callbackPrincipal = principal;
    if (req.headers['x-test-session'] === 'owner') req.sessionUserId = 'owner';
  });
  t.after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

test('successful native Person reads are durable, retry-deduplicated and revision-bound; failures are not reads', async (t) => {
  const { app, db } = fixture(t);
  registerCallbackPersonMemoryRoutes(app, {
    store: {},
    readEvidenceDb: db,
    recallService: {
      recallByAlias: async (_owner, alias) =>
        alias === 'missing'
          ? { status: 'not_available' }
          : { status: 'resolved', card, asOf: 100, personRevision: revision },
      drill: async () => ({ status: 'budget_exceeded' }),
    },
  });
  const recall = (alias, readRequestId) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/recall',
      headers: { 'x-test-callback': 'owner' },
      payload: { alias, readRequestId },
    });
  const first = await recall('Fixture', 'read-person-1');
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().usageRecorded, true);
  assert.equal((await recall('Fixture', 'read-person-1')).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_direct_read_events').get().n, 1);
  const row = db.prepare('SELECT * FROM memory_direct_read_events').get();
  assert.equal(row.memory_revision, revision);
  assert.equal(row.source_anchor, 'person-memory:person_usage');
  const unavailable = await recall('missing', 'read-person-2');
  assert.equal(unavailable.json().status, 'not_available');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_direct_read_events').get().n, 1);
  const denied = await app.inject({
    method: 'POST',
    url: '/api/callbacks/person-memory/recall',
    payload: { alias: 'Fixture', readRequestId: 'read-person-3' },
  });
  assert.equal(denied.statusCode, 401);
});

test('Event callback reads count only delivered records; browser GET and retries cannot inflate counts', async (t) => {
  const { app, db } = fixture(t);
  const store = new EventMemoryStore(':memory:');
  await store.initialize();
  const event = store.markEvent(
    {
      type: 'fixture',
      trigger: 'human_brake',
      cat: 'codex61-sol',
      threadId: 'thread_usage',
      messageId: 'message_usage',
      timestamp: 100,
      summary: 'An approved event',
      cognitiveTransition: null,
      relatedHarness: null,
      confidence: 'high',
    },
    'owner',
  ).event;
  await app.register(eventsRoutes, { eventMemoryStore: store, readEvidenceDb: db });
  const page = (header, requestId) =>
    app.inject({ method: 'GET', url: `/api/memory/events?readRequestId=${requestId}`, headers: header });
  assert.equal((await page({ 'x-test-session': 'owner' }, 'browser-1')).statusCode, 200);
  const first = await page({ 'x-test-callback': 'owner' }, 'event-read-1');
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().usageRecorded, true);
  assert.equal((await page({ 'x-test-callback': 'owner' }, 'event-read-1')).statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/memory/events?readRequestId=event-read-1&limit=1',
        headers: { 'x-test-callback': 'owner' },
      })
    ).statusCode,
    409,
    'same returned set cannot hide changed list filters',
  );
  const rows = db.prepare('SELECT * FROM memory_direct_read_events').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_anchor, `event-memory:${event.eventId}`);
  assert.equal(rows[0].source_revision, first.json().events[0].revision);
  const oldRevision = first.json().events[0].revision;
  const usage = (owner, rev = oldRevision) =>
    app.inject({
      method: 'GET',
      url: `/api/memory/events/${event.eventId}/usage?revision=${encodeURIComponent(rev)}`,
      headers: owner ? { 'x-test-session': owner } : {},
    });
  assert.equal((await usage()).statusCode, 401);
  assert.equal((await usage('owner')).json().currentVersion.read, 1);
  assert.equal(
    store.correctEvent({
      ownerUserId: 'owner',
      eventId: event.eventId,
      expectedRevision: oldRevision,
      requestId: 'correct-fixture',
      patch: { summary: 'Corrected approved event' },
      updatedAt: 200,
    }).outcome,
    'applied',
  );
  assert.equal((await usage('owner')).statusCode, 409);
  const detail = await app.inject({
    method: 'GET',
    url: `/api/memory/events/${event.eventId}`,
    headers: { 'x-test-session': 'owner' },
  });
  const newRevision = detail.json().revision;
  assert.equal((await usage('owner', newRevision)).json().currentVersion.read, 0);
  assert.equal((await usage('owner', newRevision)).json().allVersions.read, 1);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: `/api/memory/events/${event.eventId}?readRequestId=event-read-2`,
        headers: { 'x-test-callback': 'owner' },
      })
    ).statusCode,
    200,
  );
  assert.equal((await usage('owner', newRevision)).json().currentVersion.read, 1);
  assert.equal(
    store.hardForgetEvent({
      ownerUserId: 'owner',
      eventId: event.eventId,
      expectedRevision: newRevision,
      requestId: 'forget-fixture',
    }).outcome,
    'forgotten',
  );
  assert.equal((await usage('owner', newRevision)).statusCode, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_direct_read_events').get().n, 2);
});

test('Person drill retry keeps the same successful read without consuming the turn budget again', async () => {
  const person = {
    personId: 'person_usage',
    ownerUserId: 'owner',
    status: 'active',
    displayName: 'Fixture',
    privateAliases: [],
    createdAt: 1,
  };
  const claim = {
    claimId: 'person_claim_usage',
    personId: person.personId,
    ownerUserId: 'owner',
    status: 'current',
    recordedAt: 1,
    payload: { kind: 'user_assessment', statement: 'A fixture judgment' },
    materializedBy: { kind: 'card_approval' },
    sourceRefs: [{ kind: 'message', threadId: 'thread_usage', messageId: 'message_usage' }],
  };
  const service = new PersonMemoryRecallService(
    {
      getPerson: async () => person,
      listClaims: async () => [claim],
      listRelationships: async () => [],
      listInteractionEvents: async () => [],
    },
    {},
  );
  const input = {
    ownerUserId: 'owner',
    turnId: 'inv_usage',
    personId: person.personId,
    item: { kind: 'claim', id: claim.claimId },
    timeWindow: { from: 0, to: 100 },
    readRequestId: 'drill-retry-1',
  };
  for (let i = 0; i < 8; i++) assert.equal((await service.drill(input)).status, 'ok');
  assert.equal((await service.drill({ ...input, readRequestId: 'drill-retry-2' })).status, 'ok');
});

test('a read statistics outage and a legacy caller never hide authorized Person content or claim it was counted', async (t) => {
  const { app, db } = fixture(t);
  registerCallbackPersonMemoryRoutes(app, {
    store: {},
    readEvidenceDb: {
      transaction: () => {
        throw new Error('fixture storage unavailable');
      },
    },
    recallService: { recallByAlias: async () => ({ status: 'resolved', card, asOf: 100, personRevision: revision }) },
  });
  for (const readRequestId of ['read-outage', undefined]) {
    const result = await app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/recall',
      headers: { 'x-test-callback': 'owner' },
      payload: { alias: 'Fixture', ...(readRequestId ? { readRequestId } : {}) },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().status, 'resolved');
    assert.equal(result.json().usageRecorded, false);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_direct_read_events').get().n, 0);
});

function nativeDrillFixture(t, readEvidenceDb) {
  const { app, db } = fixture(t);
  app.addHook('preHandler', async (req) => {
    if (req.headers['x-test-child'])
      req.callbackPrincipal = {
        ...principal,
        invocationId: req.headers['x-test-child'],
        parentInvocationId: 'parent_turn',
      };
  });
  const person = {
    personId: 'person_usage',
    ownerUserId: 'owner',
    status: 'active',
    displayName: 'Fixture',
    privateAliases: [],
    createdAt: 1,
  };
  let claim = {
    claimId: 'person_claim_usage',
    personId: person.personId,
    ownerUserId: 'owner',
    status: 'current',
    recordedAt: 1,
    payload: { kind: 'user_assessment', statement: 'Before' },
    materializedBy: { kind: 'card_approval' },
    sourceRefs: [{ kind: 'message', threadId: 'thread_usage', messageId: 'message_usage' }],
  };
  let claims = [claim];
  const service = new PersonMemoryRecallService(
    {
      getPerson: async () => person,
      listClaims: async () => claims,
      listRelationships: async () => [],
      listInteractionEvents: async () => [],
    },
    {},
  );
  registerCallbackPersonMemoryRoutes(app, { store: {}, readEvidenceDb: readEvidenceDb ?? db, recallService: service });
  const drill = (readRequestId, to = 100, child) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/drill',
      headers: { 'x-test-callback': 'owner', ...(child ? { 'x-test-child': child } : {}) },
      payload: {
        personId: person.personId,
        item: { kind: 'claim', id: claim.claimId },
        timeWindow: { from: 0, to },
        readRequestId,
      },
    });
  return {
    db,
    drill,
    correct() {
      claim = { ...claim, status: 'superseded', validTo: 2 };
      claims = [
        claim,
        {
          ...claim,
          claimId: 'person_claim_usage_new',
          status: 'current',
          recordedAt: 2,
          payload: { kind: 'user_assessment', statement: 'After' },
        },
      ];
    },
  };
}

test('a drift-conflicted drill consumes no successful-read budget after the old claim is superseded', async (t) => {
  const f = nativeDrillFixture(t);
  assert.equal((await f.drill('old-id')).json().status, 'ok');
  f.correct();
  assert.equal((await f.drill('old-id')).statusCode, 409);
  assert.equal((await f.drill('new-id-2')).json().status, 'ok');
  assert.equal((await f.drill('new-id-3')).json().status, 'ok');
  assert.equal((await f.drill('new-id-4')).json().status, 'budget_exceeded');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_direct_read_events').get().n, 3);
});

test('same-result changed drill input conflicts; identical replay does not consume another budget slot', async (t) => {
  const f = nativeDrillFixture(t);
  assert.equal((await f.drill('same-id')).json().status, 'ok');
  assert.equal((await f.drill('same-id', 200)).statusCode, 409);
  assert.equal((await f.drill('same-id')).json().status, 'ok');
  assert.equal((await f.drill('new-id-2')).json().status, 'ok');
  assert.equal((await f.drill('new-id-3')).json().status, 'ok');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_direct_read_events').get().n, 3);
});

test('drill receipt storage failure preserves content and same-request budget deduplication', async (t) => {
  const f = nativeDrillFixture(t, {
    transaction() {
      throw new Error('fixture storage unavailable');
    },
  });
  for (let i = 0; i < 8; i++) {
    const r = await f.drill('outage-id');
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().status, 'ok');
    assert.equal(r.json().usageRecorded, false);
  }
  assert.equal((await f.drill('outage-id-2')).json().status, 'ok');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_direct_read_events').get().n, 0);
});

test('a refreshed child callback retains the parent turn read budget and original request identity', async (t) => {
  const f = nativeDrillFixture(t);
  assert.equal((await f.drill('parent-read-1', 100, 'child-1')).json().status, 'ok');
  assert.equal((await f.drill('parent-read-1', 100, 'child-2')).json().status, 'ok');
  assert.equal((await f.drill('parent-read-2', 100, 'child-3')).json().status, 'ok');
  assert.equal((await f.drill('parent-read-3', 100, 'child-4')).json().status, 'ok');
  assert.equal((await f.drill('parent-read-4', 100, 'child-5')).json().status, 'budget_exceeded');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_direct_read_events').get().n, 3);
});
