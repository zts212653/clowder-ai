/**
 * WorkflowSop callback route tests (F073 P1)
 * Tests the MCP callback endpoint /api/callbacks/update-workflow-sop
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const INVOCATION_ID = 'inv-test-001';
const CALLBACK_TOKEN = 'token-test-001';
const FALLBACK_INVOCATION_ID = 'inv-fallback-001';
const FALLBACK_CALLBACK_TOKEN = 'token-fallback-001';
const LEGACY_INVOCATION_ID = 'inv-legacy-001';
const LEGACY_CALLBACK_TOKEN = 'token-legacy-001';

// Minimal InvocationRegistry stub — returns VerifyResult (F174 Phase A)
function createStubRegistry() {
  return {
    async verify(invId, token) {
      if (invId === FALLBACK_INVOCATION_ID && token === FALLBACK_CALLBACK_TOKEN) {
        return {
          ok: true,
          record: {
            catId: 'opus',
            threadId: 'thread-1',
            userId: 'default-user',
            ownerAuthProvenance: 'compatibility_fallback',
          },
        };
      }
      if (invId === LEGACY_INVOCATION_ID && token === LEGACY_CALLBACK_TOKEN) {
        return {
          ok: true,
          record: { catId: 'opus', threadId: 'thread-1', userId: 'test-user' },
        };
      }
      if (invId !== INVOCATION_ID) return { ok: false, reason: 'unknown_invocation' };
      if (token !== CALLBACK_TOKEN) return { ok: false, reason: 'invalid_token' };
      return {
        ok: true,
        record: {
          catId: 'opus',
          threadId: 'thread-1',
          userId: 'test-user',
          ownerAuthProvenance: 'strict',
        },
      };
    },
  };
}

// Minimal backlog store stub
function createStubBacklogStore() {
  const items = new Map();
  items.set('item-1', {
    id: 'item-1',
    userId: 'test-user',
    title: 'F073 Test',
    summary: 'Test',
    priority: 'p1',
    tags: ['source:docs-backlog', 'feature:f073', 'status:active'],
    status: 'open',
    createdBy: 'user',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    audit: [],
  });
  items.set('item-default-user', {
    id: 'item-default-user',
    userId: 'default-user',
    title: 'F275 fallback provenance regression',
    summary: 'Compatibility fallback must not mint managed-work identity',
    priority: 'p1',
    tags: ['source:docs-backlog', 'feature:f275', 'status:active'],
    status: 'open',
    createdBy: 'user',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    audit: [],
  });
  return {
    get(itemId, userId) {
      const item = items.get(itemId) ?? null;
      if (item && userId && item.userId !== userId) return null;
      return item;
    },
  };
}

// Minimal in-memory workflow SOP store
function createInMemoryWorkflowSopStore() {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    async get(backlogItemId) {
      return store.get(backlogItemId) ?? null;
    },
    async upsert(backlogItemId, featureId, input, updatedBy, ownerUserId) {
      calls.push({ backlogItemId, featureId, updatedBy, ownerUserId });
      const existing = store.get(backlogItemId);
      const now = Date.now();
      const sop = existing
        ? {
            ...existing,
            sopDefinitionId: input.sopDefinitionId ?? existing.sopDefinitionId ?? 'development',
            stage: input.stage ?? existing.stage,
            batonHolder: input.batonHolder ?? existing.batonHolder,
            version: existing.version + 1,
            updatedAt: now,
            updatedBy,
          }
        : {
            featureId,
            backlogItemId,
            sopDefinitionId: input.sopDefinitionId ?? 'development',
            stage: input.stage ?? 'kickoff',
            batonHolder: input.batonHolder ?? updatedBy,
            nextSkill: null,
            resumeCapsule: { goal: '', done: [], currentFocus: '' },
            checks: {
              remoteMainSynced: 'unknown',
              qualityGatePassed: 'unknown',
              reviewApproved: 'unknown',
              visionGuardDone: 'unknown',
            },
            version: 1,
            updatedAt: now,
            updatedBy,
          };
      store.set(backlogItemId, sop);
      return sop;
    },
    async delete(backlogItemId) {
      return store.delete(backlogItemId);
    },
  };
}

describe('WorkflowSop callback route', () => {
  let app;
  let workflowSopStore;

  before(async () => {
    const module = await import('../dist/routes/callback-workflow-sop-routes.js');
    const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

    workflowSopStore = createInMemoryWorkflowSopStore();

    app = Fastify();
    registerCallbackAuthHook(app, createStubRegistry());
    module.registerCallbackWorkflowSopRoutes(app, {
      workflowSopStore,
      backlogStore: createStubBacklogStore(),
    });
    await app.ready();
  });

  beforeEach(() => {
    workflowSopStore.store.clear();
    workflowSopStore.calls.length = 0;
  });

  it('creates workflow SOP via callback with auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-workflow-sop',
      headers: {
        'content-type': 'application/json',
        'x-invocation-id': INVOCATION_ID,
        'x-callback-token': CALLBACK_TOKEN,
      },
      payload: {
        backlogItemId: 'item-1',
        featureId: 'F073',
        stage: 'impl',
        batonHolder: 'opus',
      },
    });
    assert.equal(res.statusCode, 200);
    const sop = JSON.parse(res.payload);
    assert.equal(sop.featureId, 'F073');
    assert.equal(sop.sopDefinitionId, 'development');
    assert.equal(sop.stage, 'impl');
    assert.equal(sop.updatedBy, 'opus'); // extracted from invocation context
    assert.equal(sop.version, 1);
    assert.deepEqual(workflowSopStore.calls.at(-1), {
      backlogItemId: 'item-1',
      featureId: 'F073',
      updatedBy: 'opus',
      ownerUserId: 'test-user',
    });
  });

  it('rejects callback admission whose owner came from compatibility fallback', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-workflow-sop',
      headers: {
        'content-type': 'application/json',
        'x-invocation-id': FALLBACK_INVOCATION_ID,
        'x-callback-token': FALLBACK_CALLBACK_TOKEN,
      },
      payload: {
        backlogItemId: 'item-default-user',
        featureId: 'F275',
        stage: 'kickoff',
      },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(workflowSopStore.calls.length, 0);
  });

  it('rejects legacy callback admission whose owner provenance is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-workflow-sop',
      headers: {
        'content-type': 'application/json',
        'x-invocation-id': LEGACY_INVOCATION_ID,
        'x-callback-token': LEGACY_CALLBACK_TOKEN,
      },
      payload: { backlogItemId: 'item-1', featureId: 'F275', stage: 'kickoff' },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(workflowSopStore.calls.length, 0);
  });

  it('accepts runtime sopDefinitionId via callback and rejects schema-only stubs', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-workflow-sop',
      headers: {
        'content-type': 'application/json',
        'x-invocation-id': INVOCATION_ID,
        'x-callback-token': CALLBACK_TOKEN,
      },
      payload: {
        backlogItemId: 'item-1',
        featureId: 'F073',
        sopDefinitionId: 'development',
        stage: 'impl',
      },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.payload).sopDefinitionId, 'development');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-workflow-sop',
      headers: {
        'content-type': 'application/json',
        'x-invocation-id': INVOCATION_ID,
        'x-callback-token': CALLBACK_TOKEN,
      },
      payload: {
        backlogItemId: 'item-1',
        featureId: 'F073',
        sopDefinitionId: 'video-cocreation',
        stage: 'impl',
      },
    });
    assert.equal(bad.statusCode, 400);
  });

  it('rejects invalid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-workflow-sop',
      headers: { 'content-type': 'application/json', 'x-invocation-id': 'bad-id', 'x-callback-token': 'bad-token' },
      payload: {
        backlogItemId: 'item-1',
        featureId: 'F073',
      },
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 for non-existent backlog item', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-workflow-sop',
      headers: {
        'content-type': 'application/json',
        'x-invocation-id': INVOCATION_ID,
        'x-callback-token': CALLBACK_TOKEN,
      },
      payload: {
        backlogItemId: 'nonexistent',
        featureId: 'F073',
      },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-workflow-sop',
      headers: {
        'content-type': 'application/json',
        'x-invocation-id': INVOCATION_ID,
        'x-callback-token': CALLBACK_TOKEN,
      },
      payload: {
        // missing backlogItemId and featureId
      },
    });
    assert.equal(res.statusCode, 400);
  });
});
