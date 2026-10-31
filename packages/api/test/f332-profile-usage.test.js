import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { FileProfileRepository } from '../dist/domains/cats/services/profile/ProfileRepository.js';
import { MemoryCueEpisodeStore } from '../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { recordNativeProfileOpening } from '../dist/domains/memory/profile/native-profile-opening.js';
import { ProfileMemoryLifecycleStore } from '../dist/domains/memory/profile/ProfileMemoryLifecycleStore.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackReadProfileRoutes } from '../dist/routes/callback-read-profile-routes.js';
import { profileMemoryOwnerRoutes } from '../dist/routes/profile-memory-owner.js';

let app;
let db;
let root;
let repository;
let registry;
let session;
let revision;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'f332-usage-'));
  db = new Database(join(root, 'evidence.sqlite'));
  applyMigrations(db);
  repository = new FileProfileRepository({ dataDir: root, relationshipKeyForCat: () => 'astra' });
  const path = repository.capsulePath('alice');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'Current approved portrait');
  revision = repository.readCapsule('alice').revision;
  registry = new InvocationRegistry();
  app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'alice' });
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, registry, {
      agentKeyRegistry: {
        verify: async (secret) =>
          secret === 'fixture-key'
            ? {
                ok: true,
                record: {
                  agentKeyId: 'fixture-key-id',
                  catId: createCatId('kimi31-pro'),
                  userId: 'alice',
                  secretHash: 'fixture',
                  salt: 'fixture',
                  scope: 'user-bound',
                  issuedAt: 1,
                  expiresAt: Date.now() + 60000,
                },
              }
            : { ok: false, reason: 'agent_key_unknown' },
      },
    });
    const deps = { repository, evidenceDb: db };
    registerCallbackReadProfileRoutes(scope, deps);
  });
  const options = {
    ownerUserId: 'alice',
    evidenceDb: db,
    store: new ProfileMemoryLifecycleStore({ db, repository }),
    proposalStore: { listByTarget: async () => [] },
    sourceReaders: {
      threadStore: { get: async () => null, list: async () => [] },
      messageStore: { getById: async () => null },
    },
  };
  await app.register(profileMemoryOwnerRoutes, options);
  await app.ready();
  const response = await app.inject({ method: 'GET', url: '/api/session' });
  assert.equal(response.statusCode, 200);
  session = String(response.headers['set-cookie']).split(';')[0];
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
async function read(owner = 'alice', requestId = 'read-1', expectedRevision) {
  const auth = await registry.create(owner, 'codex-astra', 'thread');
  return app.inject({
    method: 'GET',
    url: `/api/callbacks/profile?${new URLSearchParams({ layer: 'capsule', requestId, ...(expectedRevision ? { expectedRevision } : {}) })}`,
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
  });
}
async function usage(rev = revision) {
  return app.inject({
    method: 'GET',
    url: `/api/memory/profile/capsule/usage?revision=${encodeURIComponent(rev)}`,
    headers: { cookie: session },
  });
}
test('the owner sees recorded zero, a recording boundary and unknown earlier history; browser reads do not increment it', async () => {
  for (let i = 0; i < 2; i++) {
    const response = await usage();
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.currentVersion, { opening: 0, read: 0 });
    assert.equal(body.historyComplete, false);
    assert.ok(body.directReadRecordedSince > 0);
  }
});
test('successful callback reads persist once per request; failed and foreign reads cannot enter the owner count', async () => {
  assert.equal((await read()).statusCode, 200);
  assert.equal((await read()).statusCode, 200);
  assert.equal((await read('alice', 'stale', `sha256:${'a'.repeat(64)}`)).statusCode, 409);
  assert.equal((await read('bob')).statusCode, 404);
  mkdirSync(dirname(repository.capsulePath('bob')), { recursive: true });
  writeFileSync(repository.capsulePath('bob'), 'Current approved portrait');
  assert.equal((await read('bob')).statusCode, 200);
  const response = await usage();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().currentVersion, { opening: 0, read: 1 });
  const persisted = new Database(join(root, 'evidence.sqlite'), { readonly: true });
  try {
    assert.equal(
      persisted.prepare("SELECT COUNT(*) AS n FROM profile_read_events WHERE owner_user_id = 'alice'").get().n,
      1,
    );
  } finally {
    persisted.close();
  }
  const unauthenticated = await app.inject({
    method: 'GET',
    url: `/api/memory/profile/capsule/usage?revision=${encodeURIComponent(revision)}`,
  });
  assert.equal(unauthenticated.statusCode, 401);
});
test('opening evidence retains exact versions and retries; a correction does not rewrite history or authorize stale detail', async () => {
  const store = new MemoryCueEpisodeStore(db);
  const delivery = {
    scope: { ownerUserId: 'alice', threadId: 'thread', invocationId: 'opening' },
    consumerCatId: 'codex-astra',
    sourceRevision: revision,
    requestGenerationId: 'generation',
    observedAt: 1000,
  };
  recordNativeProfileOpening(store, delivery);
  recordNativeProfileOpening(store, delivery);
  recordNativeProfileOpening(store, { ...delivery, scope: { ...delivery.scope, ownerUserId: 'bob' } });
  assert.equal((await usage()).json().currentVersion.opening, 1);
  await read();
  writeFileSync(repository.capsulePath('alice'), 'Corrected approved portrait');
  const next = repository.readCapsule('alice').revision;
  assert.equal((await usage()).statusCode, 409);
  assert.equal((await read('alice', 'read-1')).statusCode, 409);
  assert.equal((await read('alice', 'read-2', next)).statusCode, 200);
  const body = (await usage(next)).json();
  assert.deepEqual(body.currentVersion, { opening: 0, read: 1 });
  assert.deepEqual(body.allVersions, { opening: 1, read: 2 });
});
test('agent-key reads retain their real principal without inventing a thread or an opening cue', async () => {
  const request = {
    method: 'GET',
    url: '/api/callbacks/profile?layer=capsule&requestId=agent-read',
    headers: { 'x-agent-key-secret': 'fixture-key' },
  };
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.deepEqual((await usage()).json().currentVersion, { opening: 0, read: 1 });
  assert.deepEqual(db.prepare('SELECT principal_kind, thread_id, invocation_id FROM profile_read_events').get(), {
    principal_kind: 'agent_key',
    thread_id: null,
    invocation_id: null,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_cue_events').get().n, 0);
});
test('old clients without a stable ID are explicitly unrecorded; failure to persist never returns profile bytes', async () => {
  const auth = await registry.create('alice', 'codex-astra', 'thread');
  const old = await app.inject({
    method: 'GET',
    url: '/api/callbacks/profile?layer=capsule',
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
  });
  assert.equal(old.statusCode, 200);
  assert.equal(old.json().usageRecorded, false);
  db.exec('DROP TABLE profile_read_events');
  const failed = await read();
  assert.equal(failed.statusCode, 503);
  assert.doesNotMatch(failed.body, /Current approved portrait/);
  assert.equal((await usage()).statusCode, 503);
});
test('schema upgrade and repeated open preserve old cue events and immutable new read evidence', async () => {
  const cue = new MemoryCueEpisodeStore(db);
  recordNativeProfileOpening(cue, {
    scope: { ownerUserId: 'alice', threadId: 'thread', invocationId: 'old' },
    consumerCatId: 'codex-astra',
    sourceRevision: revision,
    requestGenerationId: 'old-generation',
    observedAt: 1000,
  });
  db.exec('DROP TABLE profile_read_events');
  // Rewind to v73 even when the initialized store includes later migrations.
  db.prepare('DELETE FROM schema_version WHERE version >= 74').run();
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version, 73);
  applyMigrations(db);
  await read();
  applyMigrations(db);
  assert.deepEqual((await usage()).json().currentVersion, { opening: 1, read: 1 });
  assert.throws(() => db.exec('DELETE FROM profile_read_events'), /immutable/);
  assert.throws(() => db.exec("UPDATE profile_read_events SET memory_id = 'corpus'"), /immutable/);
});
test('relationship anchors bind the exact persona and consumer; shared corpus never becomes opening delivery', async () => {
  const path = repository.primerPath(repository.scope('alice', 'codex-astra'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'Relationship fixture');
  const rev = repository.readPrimer(repository.scope('alice', 'codex-astra')).revision;
  const cues = new MemoryCueEpisodeStore(db);
  const presented = {
    eventId: 'primer-presented',
    idempotencyKey: 'primer-presented',
    cueId: 'primer-cue',
    opportunityId: 'primer-opening',
    scope: { ownerUserId: 'alice', threadId: 'thread', invocationId: 'inv' },
    consumerCatId: 'codex-astra',
    resolverFamily: 'profile',
    sourceAnchor: 'profile:opening-primer:astra:codex-astra',
    sourceRevision: rev,
    axis: 'consumption',
    consumptionOutcome: 'presented',
    catalogVersion: 1,
    resolverVersion: 1,
    occurredAt: 1000,
  };
  cues.append(presented);
  cues.append({
    ...presented,
    eventId: 'drill',
    idempotencyKey: 'drill',
    consumptionOutcome: 'drilled',
    occurredAt: 2000,
  });
  for (const [id, anchor] of [
    ['other-persona', 'profile:opening-primer:astra-other:codex-astra'],
    ['wrong-consumer', 'profile:opening-primer:astra:another-cat'],
  ]) {
    cues.append({ ...presented, eventId: id, idempotencyKey: id, cueId: id, sourceAnchor: anchor });
  }
  const auth = await registry.create('alice', 'codex-astra', 'thread');
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/callbacks/profile?requestId=primer-read', headers })).statusCode,
    200,
  );
  const result = await app.inject({
    method: 'GET',
    url: `/api/memory/profile/primer%3Aastra/usage?revision=${encodeURIComponent(rev)}`,
    headers: { cookie: session },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().currentVersion, { opening: 1, read: 2 });
  mkdirSync(dirname(repository.corpusPath('alice')), { recursive: true });
  writeFileSync(repository.corpusPath('alice'), 'Owner-wide shared fixture');
  const corpus = await app.inject({
    method: 'GET',
    url: '/api/callbacks/profile?layer=corpus&requestId=corpus-read',
    headers,
  });
  assert.equal(corpus.statusCode, 200);
  const view = await app.inject({
    method: 'GET',
    url: `/api/memory/profile/corpus/usage?revision=${encodeURIComponent(corpus.json().revision)}`,
    headers: { cookie: session },
  });
  assert.deepEqual(view.json().currentVersion, { opening: 0, read: 1 });
  assert.equal(view.json().openingMode, 'on_demand');
});
