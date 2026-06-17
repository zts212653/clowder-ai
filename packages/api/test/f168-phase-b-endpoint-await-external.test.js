/**
 * F168 Phase B — Task 6: await-external endpoint integration tests
 *
 * TDD: tests go through the ACTUAL HTTP endpoint, never bypassing to direct append.
 *
 * Verifies:
 *  1. Requires callback auth — 401 without headers
 *  2. Returns 501 when eventLog not configured
 *  3. Returns 400 for invalid subjectKey format
 *  4. Successfully appends case.awaiting_external event + applies projector
 *  5. URL-encodes subjectKey with colon/slash/hash correctly decoded by Fastify
 *  6. Works with reason payload and without
 *  7. Does not apply projector when not configured (eventLog-only mode)
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F168 Phase B — Task 6: await-external endpoint', () => {
  const catCredentials = {
    sonnet: { invocationId: 'inv-sonnet', callbackToken: 'tok-sonnet' },
    opus: { invocationId: 'inv-opus', callbackToken: 'tok-opus' },
  };

  const defaultRegistry = {
    async verify(invocationId, callbackToken) {
      for (const [catId, creds] of Object.entries(catCredentials)) {
        if (creds.invocationId === invocationId && creds.callbackToken === callbackToken) {
          return {
            ok: true,
            record: {
              invocationId,
              callbackToken,
              userId: 'system',
              catId,
              threadId: 't1',
              clientMessageIds: new Set(),
              createdAt: Date.now(),
              expiresAt: Date.now() + 60_000,
            },
          };
        }
      }
      return { ok: false, reason: 'unknown_invocation' };
    },
  };

  function authHeaders(catId = 'sonnet') {
    const creds = catCredentials[catId];
    return creds ? { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken } : {};
  }

  function createMockEventLog() {
    const events = [];
    return {
      events,
      async append(event) {
        const exists = events.some((e) => e.sourceEventId === event.sourceEventId);
        if (exists) return { appended: false };
        events.push(event);
        return { appended: true };
      },
    };
  }

  function createMockProjector() {
    const applied = [];
    return {
      applied,
      async apply(event) {
        applied.push(event);
      },
    };
  }

  let communityIssueStore;
  let taskStore;

  beforeEach(async () => {
    const { createCommunityIssueStore } = await import(
      '../dist/domains/cats/services/stores/factories/CommunityIssueStoreFactory.js'
    );
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    communityIssueStore = createCommunityIssueStore();
    taskStore = new TaskStore();
  });

  async function createApp(opts = {}) {
    const { communityIssueRoutes } = await import('../dist/routes/community-issues.js');
    const app = Fastify();
    const socketManager = { broadcastToRoom() {} };
    await app.register(communityIssueRoutes, {
      communityIssueStore,
      taskStore,
      socketManager,
      registry: defaultRegistry,
      ...opts,
    });
    return app;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Auth guard
  // ─────────────────────────────────────────────────────────────────────────

  test('returns 401 when no auth headers', async () => {
    const app = await createApp({ eventLog: createMockEventLog() });
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#42')}/await-external`,
      payload: {},
    });
    assert.strictEqual(res.statusCode, 401);
  });

  test('returns 401 when auth headers are wrong', async () => {
    const app = await createApp({ eventLog: createMockEventLog() });
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#42')}/await-external`,
      headers: { 'x-invocation-id': 'bad-id', 'x-callback-token': 'bad-token' },
      payload: {},
    });
    assert.strictEqual(res.statusCode, 401);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Event log availability
  // ─────────────────────────────────────────────────────────────────────────

  test('returns 501 when eventLog not configured', async () => {
    const app = await createApp(); // no eventLog
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#42')}/await-external`,
      headers: authHeaders(),
      payload: {},
    });
    assert.strictEqual(res.statusCode, 501);
    const body = JSON.parse(res.payload);
    assert.ok(body.error, 'must have error field');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Validation
  // ─────────────────────────────────────────────────────────────────────────

  test('returns 400 for invalid subjectKey format — wrong prefix', async () => {
    const app = await createApp({ eventLog: createMockEventLog() });
    // "not-valid" doesn't start with "issue:" or "pr:"
    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/not-valid/await-external',
      headers: authHeaders(),
      payload: {},
    });
    assert.strictEqual(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.error, 'must have error field');
  });

  test('returns 400 for malformed issue subjectKey (no # separator) — Cloud R10 P1', async () => {
    const app = await createApp({ eventLog: createMockEventLog() });
    // "issue:not-a-real-key" starts with "issue:" but missing {owner/repo}#{number} format
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:not-a-real-key')}/await-external`,
      headers: authHeaders(),
      payload: {},
    });
    assert.strictEqual(res.statusCode, 400, 'malformed issue key must be rejected with 400');
    const body = JSON.parse(res.payload);
    assert.ok(body.error, 'must have error field');
  });

  test('returns 400 for malformed issue subjectKey (non-numeric issue number) — Cloud R10 P1', async () => {
    const app = await createApp({ eventLog: createMockEventLog() });
    // "issue:owner/repo#abc" — issue number is not a valid integer
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#abc')}/await-external`,
      headers: authHeaders(),
      payload: {},
    });
    assert.strictEqual(res.statusCode, 400, 'non-numeric issue number must be rejected with 400');
    const body = JSON.parse(res.payload);
    assert.ok(body.error, 'must have error field');
  });

  test('returns 400 for malformed pr subjectKey (no # separator) — Cloud R10 P1', async () => {
    const app = await createApp({ eventLog: createMockEventLog() });
    // "pr:not-a-real-key" starts with "pr:" but missing {owner/repo}#{number} format
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('pr:not-a-real-key')}/await-external`,
      headers: authHeaders(),
      payload: {},
    });
    assert.strictEqual(res.statusCode, 400, 'malformed pr key must be rejected with 400');
    const body = JSON.parse(res.payload);
    assert.ok(body.error, 'must have error field');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Success path — event appended + projector applied
  // ─────────────────────────────────────────────────────────────────────────

  test('appends case.awaiting_external event with reason and applies projector', async () => {
    const mockEventLog = createMockEventLog();
    const mockProjector = createMockProjector();
    const app = await createApp({ eventLog: mockEventLog, projector: mockProjector });

    const subjectKey = 'issue:owner/repo#42';
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent(subjectKey)}/await-external`,
      headers: authHeaders('sonnet'),
      payload: { reason: 'waiting for reporter to provide reproduction steps' },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.subjectKey, subjectKey, 'response must include decoded subjectKey');
    assert.strictEqual(body.appended, true);
    assert.strictEqual(body.state, 'awaiting_external');
    assert.ok(typeof body.eventId === 'string', 'must include eventId');

    // Event was appended to eventLog (not bypassed)
    assert.strictEqual(mockEventLog.events.length, 1);
    const evt = mockEventLog.events[0];
    assert.strictEqual(evt.kind, 'case.awaiting_external');
    assert.strictEqual(evt.subjectKey, subjectKey);
    assert.strictEqual(evt.classification, 'state-changing');
    assert.strictEqual(evt.payload.reason, 'waiting for reporter to provide reproduction steps');
    assert.ok(typeof evt.at === 'number', 'event must have at timestamp');

    // Projector was applied with the same event (not bypassed)
    assert.strictEqual(mockProjector.applied.length, 1);
    assert.strictEqual(mockProjector.applied[0].kind, 'case.awaiting_external');
    assert.strictEqual(mockProjector.applied[0].subjectKey, subjectKey);
  });

  test('works without a reason payload', async () => {
    const mockEventLog = createMockEventLog();
    const app = await createApp({ eventLog: mockEventLog });

    const subjectKey = 'issue:owner/repo#99';
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent(subjectKey)}/await-external`,
      headers: authHeaders(),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(mockEventLog.events.length, 1);
    // reason defaults to null
    assert.strictEqual(mockEventLog.events[0].payload.reason, null);
  });

  test('skips projector when not configured (eventLog-only mode)', async () => {
    const mockEventLog = createMockEventLog();
    const app = await createApp({ eventLog: mockEventLog }); // no projector

    const subjectKey = 'issue:owner/repo#100';
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent(subjectKey)}/await-external`,
      headers: authHeaders(),
      payload: { reason: 'test' },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.appended, true);
    // Event is in log
    assert.strictEqual(mockEventLog.events.length, 1);
  });

  test('correctly decodes URL-encoded subjectKey with special chars', async () => {
    const mockEventLog = createMockEventLog();
    const mockProjector = createMockProjector();
    const app = await createApp({ eventLog: mockEventLog, projector: mockProjector });

    // Test with org/repo format containing slash, colon, hash
    const subjectKey = 'issue:my-org/my-repo#123';
    const encodedKey = encodeURIComponent(subjectKey); // issue%3Amy-org%2Fmy-repo%23123

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodedKey}/await-external`,
      headers: authHeaders(),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.subjectKey, subjectKey, 'decoded subjectKey must match original');
    assert.strictEqual(mockEventLog.events[0].subjectKey, subjectKey);
  });

  test('pr: subjectKey format also accepted', async () => {
    const mockEventLog = createMockEventLog();
    const app = await createApp({ eventLog: mockEventLog });

    const subjectKey = 'pr:owner/repo#7';
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent(subjectKey)}/await-external`,
      headers: authHeaders(),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.subjectKey, subjectKey);
  });

  test('returns appended:false when event already exists (idempotency via sourceEventId)', async () => {
    // Since sourceEventId includes Date.now(), true idempotency with same timestamp can't be
    // tested deterministically from HTTP layer — but we verify the mock eventLog dedup works
    const mockEventLog = {
      events: [],
      async append(_event) {
        // Simulate dedup: always return appended:false
        return { appended: false };
      },
    };
    const mockProjector = createMockProjector();
    const app = await createApp({ eventLog: mockEventLog, projector: mockProjector });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#55')}/await-external`,
      headers: authHeaders(),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.appended, false);
    // Projector NOT called when appended:false (dedup hit)
    assert.strictEqual(mockProjector.applied.length, 0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P1-B: State validation — 409 when current state is not activatable
  // (R1 finding: endpoint must check projection state before appending)
  // ─────────────────────────────────────────────────────────────────────────

  test('returns 409 when case is in a terminal state (closed) — event must NOT be appended', async () => {
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === 'issue:owner/repo#77') {
          return { subjectKey: 'issue:owner/repo#77', state: 'closed', version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({ eventLog: mockEventLog, objectStore: mockObjectStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#77')}/await-external`,
      headers: authHeaders(),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.ok(body.error, 'must have error field');
    assert.strictEqual(body.currentState, 'closed', 'must report current state');
    // Critical: event must NOT have been appended to the log
    assert.strictEqual(mockEventLog.events.length, 0, 'event must not be appended on invalid transition');
  });

  // Cloud R6 P1-1: routed state is the primary post-accept state; owner must be
  // able to declare awaiting_external from it without first transitioning to in_progress
  // (no production path does that automatically).
  test('returns 200 when case is routed — primary workflow entry point (Cloud R6 P1-1)', async () => {
    const mockEventLog = createMockEventLog();
    const mockProjector = createMockProjector();
    const mockObjectStore = {
      async get(key) {
        if (key === 'issue:owner/repo#88') {
          return { subjectKey: 'issue:owner/repo#88', state: 'routed', version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({ eventLog: mockEventLog, objectStore: mockObjectStore, projector: mockProjector });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#88')}/await-external`,
      headers: authHeaders(),
      payload: { reason: 'waiting for user reply' },
    });

    assert.strictEqual(res.statusCode, 200, 'routed case must be allowed to enter awaiting_external');
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.state, 'awaiting_external');
    assert.strictEqual(mockEventLog.events.length, 1, 'event must be appended for routed case');
    assert.strictEqual(mockProjector.applied[0]?.kind, 'case.awaiting_external');
  });

  test('returns 200 when case is in_progress (valid activatable state)', async () => {
    const mockEventLog = createMockEventLog();
    const mockProjector = createMockProjector();
    const mockObjectStore = {
      async get(key) {
        if (key === 'issue:owner/repo#66') {
          return { subjectKey: 'issue:owner/repo#66', state: 'in_progress', version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({ eventLog: mockEventLog, projector: mockProjector, objectStore: mockObjectStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#66')}/await-external`,
      headers: authHeaders(),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(mockEventLog.events.length, 1, 'event must be appended for in_progress case');
  });

  test('returns 200 when case is already awaiting_external (idempotent re-declare)', async () => {
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === 'issue:owner/repo#44') {
          return { subjectKey: 'issue:owner/repo#44', state: 'awaiting_external', version: 2, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({ eventLog: mockEventLog, objectStore: mockObjectStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#44')}/await-external`,
      headers: authHeaders(),
      payload: {},
    });

    // awaiting_external → awaiting_external is idempotent re-declare (valid)
    assert.strictEqual(res.statusCode, 200);
  });

  test('returns 200 when objectStore not configured (no state check possible)', async () => {
    // Without objectStore, endpoint cannot check state — falls back to allowing the append
    // so cats using the MCP tool without objectStore wired don't get hard failures
    const mockEventLog = createMockEventLog();
    const app = await createApp({ eventLog: mockEventLog }); // no objectStore

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#11')}/await-external`,
      headers: authHeaders(),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(mockEventLog.events.length, 1);
  });

  test('returns 404 when objectStore has no projection for subjectKey (Cloud R20 P2: case not found)', async () => {
    // null projection = case not tracked in objectStore.
    // case.awaiting_external is valid only from {in_progress, awaiting_external, routed}.
    // A fresh projection starts at 'new', so the state machine would always reject it.
    // Silently appending and then responding state:'awaiting_external' (old behaviour)
    // is misleading — the projected state never changed.
    // Correct behaviour: 404 before appending.
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(_key) {
        return null; // no projection stored
      },
    };
    const app = await createApp({ eventLog: mockEventLog, objectStore: mockObjectStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#22')}/await-external`,
      headers: authHeaders(),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(mockEventLog.events.length, 0, 'should NOT append event for untracked case');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R2-P1-B: Owner validation — 403 when caller is not the case owner
  // (R2 finding: any valid callback token can declare awaiting_external on
  //  someone else's subjectKey)
  // ─────────────────────────────────────────────────────────────────────────

  test('returns 403 when caller thread is not the case owner', async () => {
    // Default registry → threadId = 't1'
    // But ownerThreadId in projection is a DIFFERENT thread
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === 'issue:owner/repo#501') {
          return {
            subjectKey: 'issue:owner/repo#501',
            state: 'in_progress',
            ownerThreadId: 'thread-other-cat', // different from caller's 't1'
            version: 1,
            updatedAt: Date.now(),
          };
        }
        return null;
      },
    };
    const app = await createApp({ eventLog: mockEventLog, objectStore: mockObjectStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#501')}/await-external`,
      headers: authHeaders(), // threadId = 't1'
      payload: {},
    });

    assert.strictEqual(res.statusCode, 403);
    const body = JSON.parse(res.payload);
    assert.ok(body.error, 'must have error field');
    // Event must NOT be appended
    assert.strictEqual(mockEventLog.events.length, 0, 'event must not be appended when ownership check fails');
  });

  test('returns 200 when caller IS the case owner (threadId match)', async () => {
    // Default registry → threadId = 't1'
    // Projection ownerThreadId = 't1' → same → allow
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === 'issue:owner/repo#502') {
          return {
            subjectKey: 'issue:owner/repo#502',
            state: 'in_progress',
            ownerThreadId: 't1', // same as caller's threadId
            version: 1,
            updatedAt: Date.now(),
          };
        }
        return null;
      },
    };
    const app = await createApp({ eventLog: mockEventLog, objectStore: mockObjectStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#502')}/await-external`,
      headers: authHeaders(), // threadId = 't1'
      payload: {},
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(mockEventLog.events.length, 1, 'event must be appended when owner matches');
  });

  test('returns 200 when ownerThreadId is null (no owner assigned — allow)', async () => {
    // Edge case: case reached in_progress without owner assignment (unexpected but possible)
    // Should not fail with 403 — allow the caller to declare awaiting_external
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === 'issue:owner/repo#503') {
          return {
            subjectKey: 'issue:owner/repo#503',
            state: 'in_progress',
            ownerThreadId: null, // no owner
            version: 1,
            updatedAt: Date.now(),
          };
        }
        return null;
      },
    };
    const app = await createApp({ eventLog: mockEventLog, objectStore: mockObjectStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${encodeURIComponent('issue:owner/repo#503')}/await-external`,
      headers: authHeaders(),
      payload: {},
    });

    // No owner to check → allow (conservative)
    assert.strictEqual(res.statusCode, 200);
  });
});
