/**
 * F168 — await-external auto-reconciliation (carrier gap fix)
 *
 * Cross-thread coordination from @codex-sol:
 *   coord-fa957149-5326-4ae0-a17d-ad3269068eea / subject=friction:community-await-external-admission
 *
 * Problem: GitHub-side triage (WELCOME/labels/Direction Card) completes without
 * emitting internal `case.routed`, leaving CommunityObject projection at `new`.
 * `community_await_external` rejects with 409 because state machine gate requires
 * {in_progress, awaiting_external, routed}.
 *
 * Fix: endpoint auto-reconciles `new`/`triaged` → `routed` when caller has valid
 * callback auth (catId + threadId). The state machine gate is preserved — the endpoint
 * emits `case.routed` first, then `case.awaiting_external`.
 *
 * Regression tests from @codex-sol spec:
 *   1. `new` still rejected (state machine level — direct transition stays invalid)
 *   2. accepted+routed→await succeeds (existing behaviour, formalized)
 *   3. owner/thread fence intact
 *
 * [宪宪/claude-opus-4-6🐾]
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F168 — await-external auto-reconciliation', () => {
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
              threadId: `thread-${catId}`,
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

  const SK = 'issue:owner/repo#900';
  const ENCODED_SK = encodeURIComponent(SK);

  /**
   * Seed a CommunityIssueItem into the store with given state and assignment.
   * Used by auto-reconciliation tests that require durable acceptance evidence.
   */
  async function seedAcceptedIssue(overrides = {}) {
    const defaults = {
      repo: 'owner/repo',
      issueNumber: 900,
      issueType: 'bug',
      title: 'Test issue #900',
    };
    const created = await communityIssueStore.create({ ...defaults, ...overrides });
    assert.ok(created, 'seeding: issue must be created');
    // Update to accepted state with assignment
    const updated = await communityIssueStore.update(created.id, {
      state: 'accepted',
      assignedCatId: 'sonnet',
      assignedThreadId: 'thread-sonnet',
      ...overrides,
    });
    assert.ok(updated, 'seeding: issue must be updated');
    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Regression test #1: state machine gate preserved — `new → awaiting_external` rejected
  // ─────────────────────────────────────────────────────────────────────────

  test('state machine: direct new → awaiting_external is rejected', async () => {
    const { transition } = await import('../dist/domains/community/community-state-machine.js');
    const event = {
      sourceEventId: 'test:1',
      subjectKey: SK,
      kind: 'case.awaiting_external',
      classification: 'state-changing',
      payload: { reason: 'test', declaredBy: 'opus', declaredAt: Date.now() },
      at: Date.now(),
    };
    const snapshot = { lastPublicCommentAt: null, closureWaiver: null };
    const result = transition('new', event, snapshot);
    assert.strictEqual(result.ok, false, 'new → awaiting_external must be rejected');
    assert.strictEqual(result.reason, 'invalid_transition');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Auto-reconciliation: `new` + valid auth → auto-route → awaiting_external
  // ─────────────────────────────────────────────────────────────────────────

  test('auto-reconciles new → routed → awaiting_external when caller has catId + threadId', async () => {
    // R2 P1: pre-seed accepted-triage evidence
    await seedAcceptedIssue();

    const mockEventLog = createMockEventLog();
    const mockProjector = createMockProjector();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'new', ownerThreadId: null, version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({
      eventLog: mockEventLog,
      projector: mockProjector,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: { reason: 'waiting for reporter reproduction' },
    });

    assert.strictEqual(res.statusCode, 200, 'auto-reconciliation must succeed');
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.state, 'awaiting_external');

    // Two events: case.routed (auto-reconciled) + case.awaiting_external
    assert.strictEqual(mockEventLog.events.length, 2, 'must append both case.routed and case.awaiting_external');
    assert.strictEqual(mockEventLog.events[0].kind, 'case.routed');
    assert.strictEqual(
      mockEventLog.events[0].payload.autoReconciled,
      true,
      'case.routed must be marked auto-reconciled',
    );
    assert.strictEqual(mockEventLog.events[0].payload.catId, 'sonnet');
    assert.strictEqual(mockEventLog.events[0].payload.ownerThreadId, 'thread-sonnet');
    assert.strictEqual(mockEventLog.events[1].kind, 'case.awaiting_external');

    // Projector applied both events
    assert.strictEqual(mockProjector.applied.length, 2);
    assert.strictEqual(mockProjector.applied[0].kind, 'case.routed');
    assert.strictEqual(mockProjector.applied[1].kind, 'case.awaiting_external');
  });

  test('auto-reconciles triaged → routed → awaiting_external', async () => {
    // R2 P1: pre-seed accepted-triage evidence
    await seedAcceptedIssue();

    const mockEventLog = createMockEventLog();
    const mockProjector = createMockProjector();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'triaged', ownerThreadId: null, version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({
      eventLog: mockEventLog,
      projector: mockProjector,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 200, 'triaged state must also auto-reconcile');
    assert.strictEqual(mockEventLog.events[0].kind, 'case.routed');
    assert.strictEqual(mockEventLog.events[0].payload.autoReconciled, true);
    assert.strictEqual(mockEventLog.events[1].kind, 'case.awaiting_external');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Regression test #2: accepted+routed → await succeeds (existing behaviour)
  // ─────────────────────────────────────────────────────────────────────────

  test('routed → awaiting_external succeeds (canonical workflow)', async () => {
    const mockEventLog = createMockEventLog();
    const mockProjector = createMockProjector();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return {
            subjectKey: SK,
            state: 'routed',
            ownerThreadId: 'thread-sonnet',
            version: 1,
            updatedAt: Date.now(),
          };
        }
        return null;
      },
    };
    const app = await createApp({
      eventLog: mockEventLog,
      projector: mockProjector,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 200);
    // Only one event — no auto-reconciliation needed
    assert.strictEqual(mockEventLog.events.length, 1, 'only case.awaiting_external for already-routed case');
    assert.strictEqual(mockEventLog.events[0].kind, 'case.awaiting_external');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Regression test #3: owner/thread fence intact
  // ─────────────────────────────────────────────────────────────────────────

  test('rejects 403 when caller thread differs from owner — fence intact', async () => {
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return {
            subjectKey: SK,
            state: 'routed',
            ownerThreadId: 'thread-OTHER-owner', // not caller's thread
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
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'), // threadId = 'thread-sonnet'
      payload: {},
    });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(mockEventLog.events.length, 0, 'no events when ownership fence blocks');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Terminal states remain rejected (NOT reconcilable)
  // ─────────────────────────────────────────────────────────────────────────

  test('terminal state (declined) returns 409 — not reconcilable', async () => {
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'declined', version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({ eventLog: mockEventLog, objectStore: mockObjectStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.currentState, 'declined');
    assert.strictEqual(mockEventLog.events.length, 0);
  });

  test('terminal state (closed) returns 409 — not reconcilable', async () => {
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'closed', version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({ eventLog: mockEventLog, objectStore: mockObjectStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.currentState, 'closed');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 409 response includes nextAction hint for reconcilable states
  // ─────────────────────────────────────────────────────────────────────────

  test('409 for non-reconcilable state includes nextAction with terminal disposition', async () => {
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'fixed', version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({ eventLog: mockEventLog, objectStore: mockObjectStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    // R2 P2 fix: terminal states MUST include nextAction with terminal disposition
    // (not omit it — absence was explicitly tested before but contradicts the spec)
    assert.ok(body.nextAction !== undefined, '409 must include nextAction even for terminal states');
    assert.strictEqual(body.nextAction.kind, 'terminal', 'terminal states must declare kind=terminal');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P1 regression: auto-reconciliation must register routing tracker
  // ─────────────────────────────────────────────────────────────────────────

  test('auto-reconciliation from new registers an issue_tracking task', async () => {
    // R2 P1: pre-seed accepted-triage evidence
    await seedAcceptedIssue();

    const mockEventLog = createMockEventLog();
    const mockProjector = createMockProjector();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return {
            subjectKey: SK,
            state: 'new',
            ownerThreadId: null,
            version: 1,
            updatedAt: Date.now(),
          };
        }
        return null;
      },
    };
    const app = await createApp({
      eventLog: mockEventLog,
      projector: mockProjector,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: { reason: 'waiting for reporter' },
    });

    assert.strictEqual(res.statusCode, 200, 'auto-reconciliation must succeed');

    // P1 regression: canonical routed-event writers register tracking tasks;
    // auto-reconciliation must do the same.
    const trackingTasks = taskStore.listByKind('issue_tracking');
    assert.ok(trackingTasks.length > 0, 'auto-reconciliation must register an issue_tracking task');
    // Tracking task must be owned by the caller's thread
    const task = trackingTasks[0];
    assert.ok(task.threadId === 'thread-sonnet' || task.userId != null, 'tracking task must have owner identity');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P1 regression: owner/thread fence for reconcilable states with existing owner
  // ─────────────────────────────────────────────────────────────────────────

  test('rejects 403 when state is new with existing ownerThreadId and caller differs', async () => {
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return {
            subjectKey: SK,
            state: 'new',
            ownerThreadId: 'thread-opus', // existing owner
            version: 1,
            updatedAt: Date.now(),
          };
        }
        return null;
      },
    };
    const app = await createApp({
      eventLog: mockEventLog,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'), // threadId = 'thread-sonnet' ≠ 'thread-opus'
      payload: {},
    });

    assert.strictEqual(
      res.statusCode,
      403,
      'must reject when caller thread differs from existing owner in reconcilable state',
    );
    assert.strictEqual(mockEventLog.events.length, 0, 'no events when ownership fence blocks reconciliation');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R2 P1 regression: auto-reconciliation requires durable accepted-triage evidence
  // ─────────────────────────────────────────────────────────────────────────

  test('rejects 409 when new state has no CommunityIssueStore record (no acceptance evidence)', async () => {
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'new', ownerThreadId: null, version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    // communityIssueStore is EMPTY — no durable acceptance evidence
    const app = await createApp({
      eventLog: mockEventLog,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: { reason: 'test' },
    });

    assert.strictEqual(res.statusCode, 409, 'must reject without accepted-triage evidence');
    assert.strictEqual(mockEventLog.events.length, 0, 'no events without acceptance evidence');
    const body = JSON.parse(res.payload);
    assert.ok(body.nextAction, '409 must include nextAction guidance');
  });

  test('rejects 409 when CommunityIssue exists but state is not accepted', async () => {
    // Seed with unreplied state (not accepted)
    await communityIssueStore.create({
      repo: 'owner/repo',
      issueNumber: 900,
      issueType: 'bug',
      title: 'Test issue #900',
    });
    // State defaults to 'unreplied' — NOT accepted
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'new', ownerThreadId: null, version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({
      eventLog: mockEventLog,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: { reason: 'test' },
    });

    assert.strictEqual(res.statusCode, 409, 'must reject when issue is not in accepted state');
    assert.strictEqual(mockEventLog.events.length, 0, 'no events when issue not accepted');
  });

  test('rejects 403 when accepted but assignedCatId does not match caller', async () => {
    // Seed with accepted state but assigned to 'opus', not 'sonnet'
    const created = await communityIssueStore.create({
      repo: 'owner/repo',
      issueNumber: 900,
      issueType: 'bug',
      title: 'Test issue #900',
    });
    await communityIssueStore.update(created.id, {
      state: 'accepted',
      assignedCatId: 'opus', // different from caller 'sonnet'
      assignedThreadId: 'thread-opus',
    });

    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'new', ownerThreadId: null, version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({
      eventLog: mockEventLog,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'), // caller is 'sonnet', assigned to 'opus'
      payload: { reason: 'test' },
    });

    assert.strictEqual(res.statusCode, 403, 'must reject when caller does not match assigned cat');
    assert.strictEqual(mockEventLog.events.length, 0, 'no events when assignment mismatch');
  });

  test('rejects 403 when accepted with matching catId but mismatched assignedThreadId', async () => {
    // Seed with accepted state: catId matches caller but threadId does NOT
    const created = await communityIssueStore.create({
      repo: 'owner/repo',
      issueNumber: 900,
      issueType: 'bug',
      title: 'Test issue #900',
    });
    await communityIssueStore.update(created.id, {
      state: 'accepted',
      assignedCatId: 'sonnet', // matches caller
      assignedThreadId: 'thread-OTHER', // does NOT match caller's 'thread-sonnet'
    });

    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'new', ownerThreadId: null, version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({
      eventLog: mockEventLog,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'), // catId='sonnet', threadId='thread-sonnet'
      payload: { reason: 'test' },
    });

    assert.strictEqual(res.statusCode, 403, 'must reject when caller threadId differs from assigned thread');
    assert.strictEqual(mockEventLog.events.length, 0, 'no events when thread assignment mismatch');
  });

  test('auto-reconciles when CommunityIssueStore shows accepted with matching assignment', async () => {
    // Seed with accepted state assigned to 'sonnet'
    await seedAcceptedIssue();

    const mockEventLog = createMockEventLog();
    const mockProjector = createMockProjector();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'new', ownerThreadId: null, version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({
      eventLog: mockEventLog,
      projector: mockProjector,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: { reason: 'waiting for reporter' },
    });

    assert.strictEqual(res.statusCode, 200, 'must succeed when accepted + matching assignment');
    assert.strictEqual(mockEventLog.events.length, 2, 'must emit case.routed + case.awaiting_external');
    assert.strictEqual(mockEventLog.events[0].kind, 'case.routed');
    assert.strictEqual(mockEventLog.events[0].payload.autoReconciled, true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R2 P2 regression: 409 response must include structured nextAction
  // ─────────────────────────────────────────────────────────────────────────

  test('terminal state 409 includes nextAction with terminal disposition', async () => {
    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'fixed', version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({ eventLog: mockEventLog, objectStore: mockObjectStore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: {},
    });

    assert.strictEqual(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.ok(body.nextAction !== undefined, '409 must include nextAction field');
    assert.strictEqual(body.nextAction.kind, 'terminal', 'terminal states must declare kind=terminal');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P2 regression: MCP tool description includes PRECONDITIONS
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // R3 P1 regression: pr: subjects must not bypass acceptance evidence check
  // ─────────────────────────────────────────────────────────────────────────

  test('rejects 409 when pr: subject attempts auto-reconciliation (no durable PR authority)', async () => {
    const PR_SK = 'pr:owner/repo#904';
    const ENCODED_PR_SK = encodeURIComponent(PR_SK);

    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === PR_SK) {
          return { subjectKey: PR_SK, state: 'new', ownerThreadId: null, version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    // communityIssueStore is irrelevant — this is a pr: subject, not an issue:
    const app = await createApp({
      eventLog: mockEventLog,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_PR_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: { reason: 'waiting for upstream fix' },
    });

    assert.strictEqual(res.statusCode, 409, 'pr: subject must not bypass evidence check via auto-reconciliation');
    assert.strictEqual(mockEventLog.events.length, 0, 'no events for pr: subject without durable authority');
    const body = JSON.parse(res.payload);
    assert.ok(body.nextAction, '409 for pr: must include nextAction guidance');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R3 P1 regression: accepted issue with null assignment must not allow
  // arbitrary callers to claim ownership
  // ─────────────────────────────────────────────────────────────────────────

  test('rejects 409 when accepted issue has null assignedCatId/assignedThreadId', async () => {
    // Seed accepted issue but with NO assignment (null catId + null threadId)
    const created = await communityIssueStore.create({
      repo: 'owner/repo',
      issueNumber: 900,
      issueType: 'bug',
      title: 'Test issue #900',
    });
    await communityIssueStore.update(created.id, {
      state: 'accepted',
      // assignedCatId and assignedThreadId remain null — not assigned to anyone
    });

    const mockEventLog = createMockEventLog();
    const mockObjectStore = {
      async get(key) {
        if (key === SK) {
          return { subjectKey: SK, state: 'new', ownerThreadId: null, version: 1, updatedAt: Date.now() };
        }
        return null;
      },
    };
    const app = await createApp({
      eventLog: mockEventLog,
      objectStore: mockObjectStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${ENCODED_SK}/await-external`,
      headers: authHeaders('sonnet'),
      payload: { reason: 'test' },
    });

    assert.strictEqual(res.statusCode, 409, 'must reject when accepted but assignment is null (no authority binding)');
    assert.strictEqual(mockEventLog.events.length, 0, 'no events when assignment is missing');
    const body = JSON.parse(res.payload);
    assert.ok(body.nextAction, '409 must include nextAction for routing/assignment');
    assert.strictEqual(body.nextAction.kind, 'assign_first', 'nextAction must direct caller to assign first');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P2 regression: MCP tool description includes PRECONDITIONS
  // ─────────────────────────────────────────────────────────────────────────

  test('tool description accurately documents auto-reconciliation contract', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../../mcp-server/src/tools/callback-tools.ts', import.meta.url), 'utf8');
    // Find the description string near 'cat_cafe_community_await_external'
    const nameIdx = source.indexOf("'cat_cafe_community_await_external'");
    assert.ok(nameIdx >= 0, 'tool name must exist in source');
    // Check the description block after the name (within 1200 chars to cover full description)
    const descBlock = source.slice(nameIdx, nameIdx + 1200);

    // Semantic assertions — description must communicate the actual contract:
    // 1. PRECONDITIONS header
    assert.ok(descBlock.includes('PRECONDITIONS'), 'tool description must include PRECONDITIONS header');
    // 2. PR subjects rejected (R3 fix — no durable PR authority)
    assert.ok(
      descBlock.includes('pr:') && descBlock.includes('409'),
      'tool description must document that pr: subjects return 409',
    );
    // 3. Requires accepted CommunityIssue record with assignment
    assert.ok(
      descBlock.includes('accepted') && descBlock.includes('assignedCatId') && descBlock.includes('assignedThreadId'),
      'tool description must document the accepted-record + assignment requirement',
    );
    // 4. Exact match required (not just "valid callback auth")
    assert.ok(
      descBlock.includes('exactly match'),
      'tool description must state that caller must exactly match assigned values',
    );
    // 5. Must NOT contain the stale "with valid callback auth" auto-reconcile wording
    assert.ok(
      !descBlock.includes('with valid callback auth (catId + threadId), auto-reconciles'),
      'tool description must not contain stale R1 wording implying any valid callback can auto-reconcile',
    );
  });
});
