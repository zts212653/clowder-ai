/**
 * Authorization Routes Tests
 * 猫猫授权 HTTP 端点 — callback-auth (猫端) + authorization (铲屎官端)
 *
 * Uses Fastify injection (no real HTTP server).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { AuthorizationRuleStore } = await import('../dist/domains/cats/services/stores/ports/AuthorizationRuleStore.js');
const { PendingRequestStore } = await import('../dist/domains/cats/services/stores/ports/PendingRequestStore.js');
const { AuthorizationAuditStore } = await import(
  '../dist/domains/cats/services/stores/ports/AuthorizationAuditStore.js'
);
const { AuthorizationManager } = await import('../dist/domains/cats/services/auth/AuthorizationManager.js');
const { callbackAuthRoutes } = await import('../dist/routes/callback-auth.js');
const { authorizationRoutes } = await import('../dist/routes/authorization.js');
// registerCallbackAuthHook is called internally by callbackAuthRoutes

function createMockSocketManager() {
  const events = [];
  return {
    broadcastToRoom(room, event, data) {
      events.push({ room, event, data });
    },
    getEvents() {
      return events;
    },
  };
}

// ---- Callback Auth Routes (cat-facing) ----

describe('POST /api/callbacks/request-permission', () => {
  let registry;
  let authManager;
  let ruleStore;

  beforeEach(() => {
    registry = new InvocationRegistry();
    ruleStore = new AuthorizationRuleStore();
    const pendingStore = new PendingRequestStore();
    const auditStore = new AuthorizationAuditStore();
    authManager = new AuthorizationManager({
      ruleStore,
      pendingStore,
      auditStore,
      timeoutMs: 50,
    });
  });

  async function createApp() {
    const app = Fastify();
    await app.register(callbackAuthRoutes, { authManager, registry });
    return app;
  }

  test('returns granted when allow rule exists', async () => {
    const app = await createApp();
    ruleStore.add({
      catId: 'codex',
      action: 'git_commit',
      scope: 'global',
      decision: 'allow',
      createdBy: 'user-1',
    });

    const { invocationId, callbackToken } = registry.create('user-1', 'codex', 'thread-1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-permission',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { action: 'git_commit', reason: 'fix bug' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'granted');
  });

  test('returns denied when deny rule exists', async () => {
    const app = await createApp();
    ruleStore.add({
      catId: 'codex',
      action: 'file_delete',
      scope: 'global',
      decision: 'deny',
      createdBy: 'user-1',
    });

    const { invocationId, callbackToken } = registry.create('user-1', 'codex', 'thread-1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-permission',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { action: 'file_delete', reason: 'cleanup' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'denied');
  });

  test('returns pending when no rule and timeout', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex', 'thread-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-permission',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { action: 'git_push', reason: 'deploy' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'pending');
    assert.ok(body.requestId);
  });

  test('rejects invalid credentials', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-permission',
      headers: { 'x-invocation-id': 'bad', 'x-callback-token': 'bad' },
      payload: { action: 'x', reason: 'y' },
    });

    assert.equal(res.statusCode, 401);
  });

  test('rejects invalid credentials (missing fields test now returns 401)', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-permission',
      headers: { 'x-invocation-id': 'x', 'x-callback-token': 'y' },
    });

    assert.equal(res.statusCode, 401);
  });
});

describe('GET /api/callbacks/permission-status', () => {
  let registry;
  let authManager;

  beforeEach(() => {
    registry = new InvocationRegistry();
    const ruleStore = new AuthorizationRuleStore();
    const pendingStore = new PendingRequestStore();
    const auditStore = new AuthorizationAuditStore();
    authManager = new AuthorizationManager({
      ruleStore,
      pendingStore,
      auditStore,
      timeoutMs: 50,
    });
  });

  async function createApp() {
    const app = Fastify();
    await app.register(callbackAuthRoutes, { authManager, registry });
    return app;
  }

  test('returns status for existing request', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex', 'thread-1');

    // Create a pending request first
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-permission',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { action: 'git_commit', reason: 'fix' },
    });
    const { requestId } = JSON.parse(createRes.body);

    // Query status
    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/permission-status?requestId=${requestId}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(['waiting', 'pending'].includes(body.status));
    assert.equal(body.action, 'git_commit');
    assert.ok(body.createdAt, 'response must include createdAt (P2 契约修复)');
  });

  test('returns 403 when requestId belongs to different cat/thread', async () => {
    const app = await createApp();
    // Cat A creates a request
    const catA = registry.create('user-1', 'codex', 'thread-1');
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-permission',
      headers: { 'x-invocation-id': catA.invocationId, 'x-callback-token': catA.callbackToken },
      payload: {
        action: 'git_commit',
        reason: 'fix',
      },
    });
    const { requestId } = JSON.parse(createRes.body);

    // Cat B (different cat/thread) tries to query it
    const catB = registry.create('user-1', 'opus', 'thread-2');
    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/permission-status?requestId=${requestId}`,
      headers: { 'x-invocation-id': catB.invocationId, 'x-callback-token': catB.callbackToken },
    });

    assert.equal(res.statusCode, 403);
  });

  test('returns 403 when same cat/thread but different invocation', async () => {
    const app = await createApp();
    // Invocation A creates a request
    const invocA = registry.create('user-1', 'codex', 'thread-1');
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-permission',
      headers: { 'x-invocation-id': invocA.invocationId, 'x-callback-token': invocA.callbackToken },
      payload: {
        action: 'git_commit',
        reason: 'fix',
      },
    });
    const { requestId } = JSON.parse(createRes.body);

    // Invocation B (same cat, same thread, different invocation) tries to query
    const invocB = registry.create('user-1', 'codex', 'thread-1');
    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/permission-status?requestId=${requestId}`,
      headers: { 'x-invocation-id': invocB.invocationId, 'x-callback-token': invocB.callbackToken },
    });

    assert.equal(res.statusCode, 403, 'same cat+thread but different invocation must be rejected');
  });

  test('returns 404 for nonexistent request', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex', 'thread-1');

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/permission-status?requestId=nonexistent`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(res.statusCode, 404);
  });
});

// ---- Authorization Routes (铲屎官-facing) ----

describe('POST /api/authorization/respond', () => {
  let authManager;
  let ruleStore;
  let pendingStore;
  let auditStore;
  let socketManager;

  beforeEach(() => {
    ruleStore = new AuthorizationRuleStore();
    pendingStore = new PendingRequestStore();
    auditStore = new AuthorizationAuditStore();
    authManager = new AuthorizationManager({
      ruleStore,
      pendingStore,
      auditStore,
      timeoutMs: 5000,
    });
    socketManager = createMockSocketManager();
  });

  async function createApp() {
    const app = Fastify();
    await app.register(authorizationRoutes, {
      authManager,
      ruleStore,
      auditStore,
      socketManager,
    });
    return app;
  }

  test('responds to pending request', async () => {
    const app = await createApp();

    // Create pending request directly
    const record = pendingStore.create({
      invocationId: 'inv-1',
      catId: 'codex',
      threadId: 'thread-1',
      action: 'git_commit',
      reason: 'fix',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/authorization/respond',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: {
        requestId: record.requestId,
        granted: true,
        scope: 'once',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.record.status, 'granted');

    // Should broadcast via Socket.io
    const events = socketManager.getEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'authorization:response');
  });

  test('accepts X-Cat-Cafe-User header (frontend default)', async () => {
    const app = await createApp();

    const record = pendingStore.create({
      invocationId: 'inv-frontend',
      catId: 'codex',
      threadId: 'thread-frontend',
      action: 'git_commit',
      reason: 'frontend approval',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/authorization/respond',
      headers: { 'x-cat-cafe-user': 'frontend-user' },
      payload: {
        requestId: record.requestId,
        granted: true,
        scope: 'once',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.record.status, 'granted');
  });

  test('returns 404 for nonexistent request', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/authorization/respond',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { requestId: 'nonexistent', granted: true, scope: 'once' },
    });

    assert.equal(res.statusCode, 404);
  });

  test('returns 401 without identity header', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/authorization/respond',
      payload: { requestId: 'x', granted: true, scope: 'once' },
    });

    assert.equal(res.statusCode, 401);
  });
});

describe('GET /api/authorization/pending', () => {
  test('lists waiting requests', async () => {
    const ruleStore = new AuthorizationRuleStore();
    const pendingStore = new PendingRequestStore();
    const auditStore = new AuthorizationAuditStore();
    const authManager = new AuthorizationManager({
      ruleStore,
      pendingStore,
      auditStore,
      timeoutMs: 5000,
    });
    const socketManager = createMockSocketManager();

    pendingStore.create({ invocationId: 'i1', catId: 'codex', threadId: 't1', action: 'a1', reason: 'r1' });
    pendingStore.create({ invocationId: 'i2', catId: 'opus', threadId: 't2', action: 'a2', reason: 'r2' });

    const app = Fastify();
    await app.register(authorizationRoutes, { authManager, ruleStore, auditStore, socketManager });

    const res = await app.inject({
      method: 'GET',
      url: '/api/authorization/pending',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.pending.length, 2);
  });

  test('filters by threadId', async () => {
    const ruleStore = new AuthorizationRuleStore();
    const pendingStore = new PendingRequestStore();
    const auditStore = new AuthorizationAuditStore();
    const authManager = new AuthorizationManager({
      ruleStore,
      pendingStore,
      auditStore,
      timeoutMs: 5000,
    });
    const socketManager = createMockSocketManager();

    pendingStore.create({ invocationId: 'i1', catId: 'codex', threadId: 't1', action: 'a1', reason: 'r1' });
    pendingStore.create({ invocationId: 'i2', catId: 'opus', threadId: 't2', action: 'a2', reason: 'r2' });

    const app = Fastify();
    await app.register(authorizationRoutes, { authManager, ruleStore, auditStore, socketManager });

    const res = await app.inject({
      method: 'GET',
      url: '/api/authorization/pending?threadId=t1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).pending.length, 1);
  });

  test('accepts X-Cat-Cafe-User header for pending list', async () => {
    const ruleStore = new AuthorizationRuleStore();
    const pendingStore = new PendingRequestStore();
    const auditStore = new AuthorizationAuditStore();
    const authManager = new AuthorizationManager({
      ruleStore,
      pendingStore,
      auditStore,
      timeoutMs: 5000,
    });
    const socketManager = createMockSocketManager();

    pendingStore.create({ invocationId: 'i1', catId: 'codex', threadId: 't1', action: 'a1', reason: 'r1' });

    const app = Fastify();
    await app.register(authorizationRoutes, { authManager, ruleStore, auditStore, socketManager });

    const res = await app.inject({
      method: 'GET',
      url: '/api/authorization/pending?threadId=t1',
      headers: { 'x-cat-cafe-user': 'frontend-user' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).pending.length, 1);
  });
});

describe('Authorization Rules API', () => {
  let app;
  let ruleStore;

  beforeEach(async () => {
    ruleStore = new AuthorizationRuleStore();
    const pendingStore = new PendingRequestStore();
    const auditStore = new AuthorizationAuditStore();
    const authManager = new AuthorizationManager({
      ruleStore,
      pendingStore,
      auditStore,
      timeoutMs: 5000,
    });
    const socketManager = createMockSocketManager();

    app = Fastify();
    await app.register(authorizationRoutes, { authManager, ruleStore, auditStore, socketManager });
  });

  test('POST /api/authorization/rules creates a rule', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/authorization/rules',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: {
        catId: 'codex',
        action: 'git_*',
        scope: 'global',
        decision: 'allow',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.rule.catId, 'codex');
    assert.equal(body.rule.action, 'git_*');
    assert.equal(ruleStore.size, 1);
  });

  test('GET /api/authorization/rules lists rules', async () => {
    ruleStore.add({ catId: 'codex', action: 'git_commit', scope: 'global', decision: 'allow', createdBy: 'u1' });
    ruleStore.add({ catId: 'opus', action: 'file_delete', scope: 'global', decision: 'deny', createdBy: 'u1' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/authorization/rules',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).rules.length, 2);
  });

  test('DELETE /api/authorization/rules/:id removes rule', async () => {
    const rule = ruleStore.add({
      catId: 'codex',
      action: 'git_commit',
      scope: 'global',
      decision: 'allow',
      createdBy: 'u1',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/authorization/rules/${rule.id}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(ruleStore.size, 0);
  });

  test('DELETE nonexistent rule returns 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/authorization/rules/nonexistent',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 404);
  });
});

describe('GET /api/authorization/audit', () => {
  test('returns audit entries', async () => {
    const ruleStore = new AuthorizationRuleStore();
    const pendingStore = new PendingRequestStore();
    const auditStore = new AuthorizationAuditStore();
    const authManager = new AuthorizationManager({
      ruleStore,
      pendingStore,
      auditStore,
      timeoutMs: 5000,
    });
    const socketManager = createMockSocketManager();

    auditStore.append({
      requestId: 'r1',
      invocationId: 'i1',
      catId: 'codex',
      threadId: 't1',
      action: 'git_commit',
      reason: 'fix',
      decision: 'allow',
    });

    const app = Fastify();
    await app.register(authorizationRoutes, { authManager, ruleStore, auditStore, socketManager });

    const res = await app.inject({
      method: 'GET',
      url: '/api/authorization/audit',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].action, 'git_commit');
  });
});
