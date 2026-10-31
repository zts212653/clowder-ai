import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import { EntityHardForgottenError, EntityRegistryStore } from '../dist/domains/memory/EntityRegistry.js';
import { EntityMemoryLifecycleService } from '../dist/domains/memory/entity/EntityMemoryLifecycleService.js';
import { EntityMemoryLifecycleStore } from '../dist/domains/memory/entity/EntityMemoryLifecycleStore.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../dist/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { entityMemoryOwnerRoutes } from '../dist/routes/entity-memory-owner.js';

const ownerUserId = 'entity-owner';
const origin = 'http://localhost:3003';
const entityId = 'concept:owner-lifecycle';

function entity(overrides = {}) {
  return {
    entityId,
    type: 'concept',
    canonicalName: 'Owner lifecycle',
    aliases: ['owner lifecycle'],
    provenance: [
      {
        source: 'conversation',
        threadId: 'thread-entity-source',
        messageId: 'message-entity-source',
        date: '2026-10-06T00:00:00.000Z',
      },
    ],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    status: 'active',
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    ...overrides,
  };
}

function cookieHeader(response) {
  const raw = response.headers['set-cookie'];
  assert.ok(raw);
  return raw.split(';', 1)[0];
}

describe('F321 Entity owner lifecycle', () => {
  let app;
  let db;
  let registry;
  let store;
  let session;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    registry = new EntityRegistryStore(db);
    registry.upsert([entity()], { source: 'system' });
    store = new EntityMemoryLifecycleStore(db);
    const lifecycle = new EntityMemoryLifecycleService({
      store,
      coordinator: new OwnerMemoryActionCoordinator({
        store: new InMemoryOwnerMemoryActionReceiptStore(),
        lock: new SessionMutex(),
      }),
      sourceAvailable: async () => true,
    });
    app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId });
    await app.register(entityMemoryOwnerRoutes, {
      ownerUserId,
      store,
      lifecycle,
      proposalStore: { listByTarget: async () => [] },
      sourceReaders: {
        threadStore: {
          get: async (id) =>
            id === 'thread-entity-source'
              ? { id, title: 'Entity source', createdBy: ownerUserId, visibility: 'private' }
              : null,
          list: async () => [],
        },
        messageStore: {
          getById: async (id) =>
            id === 'message-entity-source'
              ? {
                  id,
                  threadId: 'thread-entity-source',
                  userId: ownerUserId,
                  catId: null,
                  content: 'The original entity source.',
                  timestamp: 100,
                  deliveryStatus: 'delivered',
                }
              : null,
        },
      },
    });
    await app.ready();
    const login = await app.inject({ method: 'GET', url: '/api/session', headers: { origin } });
    session = { cookie: cookieHeader(login), csrf: login.json().csrfToken };
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const readHeaders = () => ({ cookie: session.cookie });
  const actionHeaders = () => ({
    cookie: session.cookie,
    origin,
    'x-csrf-token': session.csrf,
    'content-type': 'application/json',
  });

  async function postAction(payload) {
    return app.inject({
      method: 'POST',
      url: `/api/memory/entities/${encodeURIComponent(entityId)}/actions`,
      headers: actionHeaders(),
      payload,
    });
  }

  it('reads source and applies correction, retirement, and true forget with exact receipts', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/memory/entities', headers: readHeaders() });
    assert.equal(list.statusCode, 200);
    const initial = list.json().entries[0];
    assert.equal(initial.id, entityId);
    assert.match(initial.revision, /^sha256:[a-f0-9]{64}$/);

    const source = await app.inject({
      method: 'GET',
      url: `/api/memory/entities/${encodeURIComponent(entityId)}/source?revision=${initial.revision}`,
      headers: readHeaders(),
    });
    assert.deepEqual(source.json(), {
      status: 'ready',
      sources: [
        {
          label: 'Entity source',
          occurredAt: 100,
          canOpen: true,
          threadId: 'thread-entity-source',
          messageId: 'message-entity-source',
        },
      ],
    });

    const correction = {
      action: 'correct',
      requestId: 'entity-correct:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: initial.revision,
      patch: { canonicalName: 'Owner-controlled lifecycle', aliases: ['owner-controlled lifecycle'] },
    };
    const corrected = await postAction(correction);
    assert.equal(corrected.statusCode, 200, corrected.body);
    assert.equal(registry.get(entityId).canonicalName, 'Owner-controlled lifecycle');
    assert.equal((await postAction(correction)).json().outcome, 'replayed');

    const retired = await postAction({
      action: 'retire',
      requestId: 'entity-retire:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: corrected.json().revision,
    });
    assert.equal(retired.json().status, 'retired');
    assert.deepEqual(registry.resolveQuery('owner-controlled lifecycle'), []);

    const forgotten = await postAction({
      action: 'hard_forget',
      requestId: 'entity-forget:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: retired.json().revision,
      confirmed: true,
    });
    assert.equal(forgotten.statusCode, 200, forgotten.body);
    assert.equal(forgotten.json().forgetScope.immutableAudit, 'retained');
    assert.equal(registry.get(entityId), null);
    assert.ok(db.prepare('SELECT 1 FROM entity_revision_events WHERE entity_id = ?').get(entityId));
    assert.equal(registry.upsert([entity()], { source: 'seed-sync' }), false);
    assert.throws(
      () => registry.upsert([entity()], { source: 'proposal-approval' }),
      (error) => error instanceof EntityHardForgottenError,
    );

    const legacyInsert = () =>
      db
        .prepare(
          `INSERT INTO entity_registry
             (entity_id, entity_type, canonical_name, provenance_json, stance,
              visibility_scope, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entityId,
          'concept',
          'Legacy resurrection',
          '[]',
          'endorsed',
          'workspace',
          'active',
          '2026-10-06T00:00:00.000Z',
          '2026-10-06T00:00:00.000Z',
        );
    assert.throws(legacyInsert, (error) => error.code === 'SQLITE_CONSTRAINT_TRIGGER');

    db.exec('DROP TRIGGER entity_registry_forget_no_insert');
    assert.equal(legacyInsert().changes, 1);
    assert.ok(registry.get(entityId));
    applyMigrations(db);
    assert.equal(registry.get(entityId), null, 'startup invariant repair must remove a rollback-era resurrection');
    assert.throws(legacyInsert, (error) => error.code === 'SQLITE_CONSTRAINT_TRIGGER');
  });
});
