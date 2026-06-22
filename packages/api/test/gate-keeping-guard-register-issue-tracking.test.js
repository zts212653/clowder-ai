/**
 * F167 gate-keeping thread guard — register-issue-tracking endpoint.
 *
 * PR-O4 hardening: cross-store ownership verification replaces Phase N
 * blanket block. verifyKeeperOwnership() queries TaskStore to determine
 * if the issue is already tracked in a different thread (distributed)
 * or genuinely keeper-owned (new / same-thread re-registration).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F167 gate-keeping guard: POST /api/callbacks/register-issue-tracking', () => {
  let registry;
  let messageStore;
  let socketManager;
  let evidenceStore;
  let reflectionService;
  let markerQueue;
  let threadStore;
  let taskStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    taskStore = new TaskStore();
    socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      getMessages() {
        return [];
      },
    };
    evidenceStore = {
      search: async () => [],
      health: async () => true,
      initialize: async () => {},
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
    };
    reflectionService = { reflect: async () => '' };
    markerQueue = {
      submit: async (marker) => ({ id: 'mk-1', createdAt: new Date().toISOString(), ...marker }),
      list: async () => [],
      transition: async () => {},
    };
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      evidenceStore,
      reflectionService,
      markerQueue,
      taskStore,
      fetchIssueCommentCursor: async () => 0,
    });
    return app;
  }

  test('INV-G4: non-gate-keeping thread → 200', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'normal-thread');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-issue-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', issueNumber: 100 },
    });

    assert.equal(response.statusCode, 200, 'normal thread issue tracking must succeed');
  });

  // ── PR-O4: cross-store ownership verification ─────────────────────

  test('PR-O4: new issue in gate-keeping thread → 200 allowed (keeper verified)', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-o4a', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-o4a', 'opus', thread.id);

    // No existing task for this issue → verifyKeeperOwnership returns 'keeper' → allowed
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-issue-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', issueNumber: 200 },
    });

    assert.equal(response.statusCode, 200, 'new keeper-owned issue tracking allowed in gate-keeping thread');
    const stored = taskStore.getBySubject('issue:owner/repo#200');
    assert.notEqual(stored, null, 'task must be created');
  });

  test('PR-O4: issue already tracked in different thread → 400 blocked (distributed)', async () => {
    const app = await createApp();

    // Pre-register the issue in a downstream thread
    const downstreamThread = await threadStore.create('user-o4b', 'downstream-thread');
    const { invocationId: downInvId, callbackToken: downToken } = await registry.create(
      'user-o4b',
      'opus',
      downstreamThread.id,
    );
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-issue-tracking',
      headers: { 'x-invocation-id': downInvId, 'x-callback-token': downToken },
      payload: { repoFullName: 'owner/repo', issueNumber: 300 },
    });
    assert.equal(registerRes.statusCode, 200, 'downstream registration must succeed first');

    // Now try to register same issue in gate-keeping thread
    const gkThread = await threadStore.create('user-o4b-gk', 'repo-inbox');
    await threadStore.updateThreadKind(gkThread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-o4b-gk', 'opus', gkThread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-issue-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', issueNumber: 300 },
    });

    assert.equal(response.statusCode, 400, 'issue tracked in different thread must be blocked');
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'gate_keeping_thread_default_blocked');
    assert.equal(body.tool, 'register_issue_tracking');
  });

  test('PR-O4: re-registration in same gate-keeping thread → 200 (keeper confirmed)', async () => {
    const app = await createApp();
    const gkThread = await threadStore.create('user-o4c', 'repo-inbox');
    await threadStore.updateThreadKind(gkThread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-o4c', 'opus', gkThread.id);

    // First registration → keeper (new)
    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-issue-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', issueNumber: 400 },
    });
    assert.equal(first.statusCode, 200, 'first registration must succeed');

    // Re-registration → keeper (same thread)
    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-issue-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', issueNumber: 400 },
    });
    assert.equal(second.statusCode, 200, 're-registration in same thread must succeed');
  });

  test('PR-O4: override claim in payload still ignored (Zod strips it)', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-o4d', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-o4d', 'opus', thread.id);

    // override field is stripped by Zod — doesn't affect cross-store verification
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-issue-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        repoFullName: 'owner/repo',
        issueNumber: 500,
        override: 'i-am-the-downstream-owner',
      },
    });

    // New issue → keeper → allowed (override claim is irrelevant)
    assert.equal(response.statusCode, 200, 'override field is stripped, cross-store determines outcome');
  });

  test('INV-G2-regression: PR tracking always blocked in gate-keeping (unaffected by PR-O4)', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-reg', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-reg', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', prNumber: 100 },
    });

    assert.equal(response.statusCode, 400, 'PR tracking always blocked in gate-keeping');
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'gate_keeping_thread_default_blocked');
  });
});
