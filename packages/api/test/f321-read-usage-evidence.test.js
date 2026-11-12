import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MemoryCueEpisodeStore } from '../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import {
  MemoryDirectReadConflict,
  recordMemoryDirectRead,
} from '../dist/domains/memory/read-usage/MemoryDirectReadEvidence.js';
import { readMemoryUsage } from '../dist/domains/memory/read-usage/MemoryReadUsageReader.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { personMemoryOwnerReadRoutes } from '../dist/routes/person-memory-owner-read.js';

const revision = `sha256:${'a'.repeat(64)}`,
  next = `sha256:${'b'.repeat(64)}`;
const principal = {
  kind: 'invocation',
  userId: 'owner',
  catId: 'codex61-sol',
  threadId: 'thread_usage',
  invocationId: 'inv_usage',
};
const item = {
  family: 'person_entity',
  anchor: 'person-memory:person_usage',
  sourceRevision: revision,
  memoryRevision: revision,
};
const projection = (db, owner = 'owner', rev = revision) =>
  readMemoryUsage(db, { owner, family: item.family, anchor: item.anchor, revision: rev, cueRevision: rev });

test('durable reads preserve retry identity, owner/versions and the original cue drill; unknown history is not zero', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'f321-read-evidence-')),
    path = join(root, 'reads.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let db = new Database(path);
  applyMigrations(db);
  recordMemoryDirectRead(db, principal, 'read-1', [item]);
  recordMemoryDirectRead(db, principal, 'read-1', [item]);
  assert.throws(
    () => recordMemoryDirectRead(db, principal, 'read-1', [{ ...item, memoryRevision: next }]),
    MemoryDirectReadConflict,
  );
  recordMemoryDirectRead(db, { ...principal, userId: 'other' }, 'read-1', [item]);
  recordMemoryDirectRead(db, principal, 'read-new', [{ ...item, sourceRevision: next, memoryRevision: next }]);
  recordMemoryDirectRead(db, principal, 'empty', []);
  assert.throws(() => recordMemoryDirectRead(db, principal, 'empty', [item]), MemoryDirectReadConflict);
  const cues = new MemoryCueEpisodeStore(db);
  const base = {
    cueId: 'cue_usage',
    opportunityId: 'opportunity_usage',
    scope: { ownerUserId: 'owner', threadId: 'thread_usage', invocationId: 'inv_usage' },
    consumerCatId: 'codex61-sol',
    resolverFamily: 'person_entity',
    sourceAnchor: item.anchor,
    sourceRevision: revision,
    axis: 'consumption',
    catalogVersion: 1,
    resolverVersion: 1,
  };
  for (const [i, outcome] of ['presented', 'drilled', 'applied'].entries())
    cues.append({
      ...base,
      eventId: `cue-event-${i}`,
      idempotencyKey: `cue-key-${i}`,
      consumptionOutcome: outcome,
      occurredAt: 1000 + i,
    });
  assert.equal(projection(db).currentVersion.read, 2);
  assert.deepEqual(projection(db).currentVersion, { read: 2, directRead: 1, cueDrill: 1 });
  assert.equal(projection(db).allVersions.read, 3);
  assert.equal(projection(db, 'owner', next).currentVersion.read, 1);
  assert.equal(projection(db, 'other').allVersions.read, 1);
  assert.equal(projection(db, 'nobody').currentVersion.read, 0);
  assert.equal(projection(db).historyComplete, false);
  assert.equal(projection(db).unverifiedReadCount, null);
  assert.throws(() => db.prepare('DELETE FROM memory_direct_read_events').run(), /immutable/);
  db.close();
  db = new Database(path, { readonly: true });
  try {
    assert.equal(projection(db).allVersions.read, 3);
  } finally {
    db.close();
  }
});

test('agent-key attribution never invents a thread; the same caller request cannot change its anchor', (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  recordMemoryDirectRead(
    db,
    { kind: 'agent_key', userId: 'owner', catId: 'codex61-terra', agentKeyId: 'fixture' },
    'key-read',
    [item],
  );
  const row = db.prepare('SELECT * FROM memory_direct_read_requests').get();
  assert.equal(row.thread_id, null);
  assert.equal(row.invocation_id, null);
  assert.throws(
    () =>
      recordMemoryDirectRead(
        db,
        { kind: 'agent_key', userId: 'owner', catId: 'codex61-terra', agentKeyId: 'fixture' },
        'key-read',
        [{ ...item, anchor: 'person-memory:other' }],
      ),
    MemoryDirectReadConflict,
  );
});

test('Person owner usage binds the current aggregate version and respects owner/forgotten boundaries', async (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    if (req.headers['x-test-session']) req.sessionUserId = req.headers['x-test-session'];
  });
  let person = {
    personId: 'person_usage',
    ownerUserId: 'owner',
    displayName: 'Fixture',
    privateAliases: [],
    createdAt: 1,
    status: 'active',
    sourceRefs: [],
  };
  await app.register(personMemoryOwnerReadRoutes, {
    ownerUserId: 'owner',
    readEvidenceDb: db,
    store: {
      getPerson: async () => person,
      listClaims: async () => [],
      listRelationships: async () => [],
      listInteractionEvents: async () => [],
      listCandidateIdsForPerson: async () => [],
    },
    threadStore: { get: async () => null, list: async () => [] },
    messageStore: { getById: async () => null },
  });
  t.after(async () => {
    await app.close();
    db.close();
  });
  const detail = (
    await app.inject({ method: 'GET', url: '/api/memory/people/person_usage', headers: { 'x-test-session': 'owner' } })
  ).json();
  recordMemoryDirectRead(db, principal, 'person-route', [{ ...item, memoryRevision: detail.personRevision }]);
  const url = `/api/memory/people/person_usage/usage?revision=${encodeURIComponent(detail.personRevision)}`;
  const get = (owner) => app.inject({ method: 'GET', url, headers: owner ? { 'x-test-session': owner } : {} });
  assert.equal((await get()).statusCode, 401);
  assert.equal((await get('other')).statusCode, 403);
  const result = await get('owner');
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().currentVersion.read, 1);
  assert.equal(result.json().recent[0].threadId, null);
  person = { ...person, displayName: 'Corrected fixture' };
  assert.equal((await get('owner')).statusCode, 409);
  person = null;
  assert.equal((await get('owner')).statusCode, 404);
});

test('retained unbound cue reads are separate from verified current/older reads; missing history stays unknown', (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  const cues = new MemoryCueEpisodeStore(db);
  const base = {
    cueId: 'cue_unbound',
    opportunityId: 'op_unbound',
    scope: { ownerUserId: 'owner', threadId: 'thread_usage', invocationId: 'inv_usage' },
    resolverFamily: 'person_entity',
    sourceAnchor: item.anchor,
    axis: 'consumption',
    catalogVersion: 1,
    resolverVersion: 1,
    consumptionOutcome: 'drilled',
  };
  for (const [i, sourceRevision] of [revision, next].entries())
    for (const outcome of ['presented', 'drilled'])
      cues.append({
        ...base,
        cueId: 'cue_unbound_' + i,
        eventId: 'unbound-' + i + '-' + outcome,
        idempotencyKey: 'unbound-' + i + '-' + outcome,
        sourceRevision,
        consumptionOutcome: outcome,
        occurredAt: 1000 + i,
      });
  const result = projection(db);
  assert.equal(result.currentVersion.read, 0);
  assert.equal(result.allVersions.read, 0);
  assert.deepEqual(result.recordedUnattributed, {
    currentVersion: { read: 1, directRead: 0, cueDrill: 1 },
    allVersions: { read: 2, directRead: 0, cueDrill: 2 },
  });
  assert.deepEqual(result.recent, []);
  assert.equal(result.unverifiedReadCount, null);
  assert.equal(result.historyComplete, false);
});

test('direct read retry identity binds the request as well as the returned set, without object-key order sensitivity', (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  const request = { operation: 'person-drill', timeWindow: { from: 0, to: 100 } };
  recordMemoryDirectRead(db, principal, 'semantic-id', [item], request);
  recordMemoryDirectRead(db, principal, 'semantic-id', [item], {
    timeWindow: { to: 100, from: 0 },
    operation: 'person-drill',
  });
  assert.throws(
    () =>
      recordMemoryDirectRead(db, principal, 'semantic-id', [item], { ...request, timeWindow: { from: 0, to: 200 } }),
    MemoryDirectReadConflict,
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_direct_read_events').get().n, 1);
});
