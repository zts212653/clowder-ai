/**
 * Community event ingest integration tests (F168 Phase A/B — Tasks 6+7)
 *
 * Tests:
 * Task 6 — webhook handler produces community event + projection when eventLog is injected
 * Task 7 — /dispatch handler produces case.triaged event when eventLog is injected
 * Task 2 (Phase B) — 4 new event types: issue_comment, labeled, pr_review, pr.closed
 *
 * These tests use in-memory stubs for the event log and projector
 * (the Redis-backed equivalents are tested in separate Redis tests).
 * The key assertion is "existing behavior unchanged + event side-effect fires".
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { before, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Minimal in-memory stubs
// ---------------------------------------------------------------------------

function makeInMemoryEventLog() {
  const events = [];
  return {
    events,
    append: async (event) => {
      events.push(event);
      return { appended: true, sequence: events.length - 1 };
    },
    read: async (subjectKey) => events.filter((e) => e.subjectKey === subjectKey),
    listSubjects: async () => [...new Set(events.map((e) => e.subjectKey))],
  };
}

function makeInMemoryProjector() {
  const applied = [];
  return {
    applied,
    apply: async (event) => {
      applied.push(event);
    },
    rebuild: async () => {},
    rebuildAll: async () => {},
  };
}

function makeInMemoryCommunityObjectStore() {
  const map = new Map();
  return {
    get: async (subjectKey) => map.get(subjectKey) ?? null,
    save: async (p) => {
      map.set(p.subjectKey, p);
    },
    delete: async (subjectKey) => {
      map.delete(subjectKey);
    },
    listSubjectKeys: async () => [...map.keys()],
  };
}

// ---------------------------------------------------------------------------
// Helpers — webhook
// ---------------------------------------------------------------------------

function signBody(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function makeWebhookPayload(eventType, action, repoFullName = 'owner/repo', number = 42) {
  const issueOrPr = {
    number,
    title: 'Test',
    html_url: 'https://...',
    author_association: 'CONTRIBUTOR',
    user: { login: 'octocat' },
  };
  return {
    action,
    repository: { full_name: repoFullName },
    sender: { id: 1, login: 'octocat' },
    [eventType === 'pull_request' ? 'pull_request' : 'issue']: issueOrPr,
  };
}

async function buildWebhookHandler(extraDeps = {}) {
  const mod = await import('../dist/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.js');
  const { GitHubRepoWebhookHandler } = mod;

  let deliveryCounter = 0;
  const fakeDedup = {
    claim: async () => true,
    confirm: async () => {},
    rollback: async () => {},
  };

  const handler = new GitHubRepoWebhookHandler(
    {
      webhookSecret: 'test-secret',
      repoAllowlist: ['owner/repo'],
      defaultUserId: 'user-1',
      inboxCatId: 'codex',
    },
    {
      dedup: fakeDedup,
      bindingStore: {
        getByExternal: async () => null,
        bind: async (_connectorId, _extId, threadId) => ({ threadId }),
      },
      threadStore: { create: async () => ({ id: 'thread-inbox' }) },
      deliverFn: async () => ({ messageId: `msg-${++deliveryCounter}` }),
      invokeTrigger: { trigger: () => {} },
      ...extraDeps,
    },
  );
  return handler;
}

// ---------------------------------------------------------------------------
// Task 6: Webhook handler emits community event
// ---------------------------------------------------------------------------

describe('Task 6 — webhook emits community event', () => {
  it('issues.opened webhook appends issue.opened event to eventLog', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();
    const handler = await buildWebhookHandler({ eventLog, projector });

    const bodyObj = makeWebhookPayload('issues', 'opened');
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-1',
      'x-hub-signature-256': signBody('test-secret', rawBody),
      'content-type': 'application/json',
    };

    const result = await handler.handleWebhook(bodyObj, headers, rawBody);
    assert.strictEqual(result.kind, 'processed', 'original notification path must still work');

    assert.strictEqual(eventLog.events.length, 1, 'one event should be appended');
    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'issue.opened');
    assert.strictEqual(ev.sourceEventId, 'delivery-1');
    assert.ok(ev.subjectKey.includes('owner/repo'));
    assert.ok(ev.subjectKey.includes('#42'));

    assert.strictEqual(projector.applied.length, 1, 'projector should be called');
  });

  it('pull_request.opened webhook appends pr.opened event', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();
    const handler = await buildWebhookHandler({ eventLog, projector });

    const bodyObj = makeWebhookPayload('pull_request', 'opened');
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-pr-1',
      'x-hub-signature-256': signBody('test-secret', rawBody),
    };

    await handler.handleWebhook(bodyObj, headers, rawBody);

    assert.strictEqual(eventLog.events.length, 1);
    assert.strictEqual(eventLog.events[0].kind, 'pr.opened');
  });

  it('webhook without eventLog injected still processes normally (backward compat)', async () => {
    const handler = await buildWebhookHandler(); // no eventLog
    const bodyObj = makeWebhookPayload('issues', 'opened');
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-compat',
      'x-hub-signature-256': signBody('test-secret', rawBody),
    };
    const result = await handler.handleWebhook(bodyObj, headers, rawBody);
    assert.strictEqual(result.kind, 'processed');
  });

  it('issues.closed webhook appends issue.closed event to eventLog', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();
    const handler = await buildWebhookHandler({ eventLog, projector });

    const bodyObj = makeWebhookPayload('issues', 'closed');
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-closed-1',
      'x-hub-signature-256': signBody('test-secret', rawBody),
      'content-type': 'application/json',
    };

    const result = await handler.handleWebhook(bodyObj, headers, rawBody);
    assert.strictEqual(result.kind, 'processed', 'issues.closed must be processed (not skipped)');

    assert.strictEqual(eventLog.events.length, 1, 'one event should be appended');
    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'issue.closed', 'event kind must be issue.closed');
    assert.strictEqual(ev.sourceEventId, 'delivery-closed-1');
    assert.ok(ev.subjectKey.includes('owner/repo#42'));
  });

  it('issues.reopened webhook appends issue.reopened event to eventLog', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();
    const handler = await buildWebhookHandler({ eventLog, projector });

    const bodyObj = makeWebhookPayload('issues', 'reopened');
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-reopen-1',
      'x-hub-signature-256': signBody('test-secret', rawBody),
      'content-type': 'application/json',
    };

    const result = await handler.handleWebhook(bodyObj, headers, rawBody);
    assert.strictEqual(result.kind, 'processed', 'issues.reopened must be processed (not skipped)');

    assert.strictEqual(eventLog.events.length, 1, 'one event should be appended');
    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'issue.reopened', 'event kind must be issue.reopened');
    assert.strictEqual(ev.sourceEventId, 'delivery-reopen-1');
    assert.ok(ev.subjectKey.includes('owner/repo#42'));
  });

  it('eventLog append failure does not block webhook notification', async () => {
    const brokenEventLog = {
      append: async () => {
        throw new Error('Redis down');
      },
      read: async () => [],
      listSubjects: async () => [],
    };
    const handler = await buildWebhookHandler({ eventLog: brokenEventLog });

    const bodyObj = makeWebhookPayload('issues', 'opened');
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-fail',
      'x-hub-signature-256': signBody('test-secret', rawBody),
    };

    // Must NOT throw — best-effort
    const result = await handler.handleWebhook(bodyObj, headers, rawBody);
    assert.strictEqual(result.kind, 'processed');
  });
});

// ---------------------------------------------------------------------------
// Task 7: dispatch handler emits case.triaged event
// ---------------------------------------------------------------------------

describe('Task 7 — dispatch handler emits case.triaged event', () => {
  let buildApp;

  before(async () => {
    const appMod = await import('../dist/routes/community-issues.js');
    const fastifyMod = await import('fastify');
    buildApp = (extraOpts = {}) => {
      const fastify = fastifyMod.default({ logger: false });
      fastify.register(appMod.communityIssueRoutes, {
        communityIssueStore: makeFakeIssueStore(),
        taskStore: { create: async () => ({ id: 'task-1' }), get: async () => null, listByThread: async () => [] },
        socketManager: { emit: () => {} },
        ...extraOpts,
      });
      return fastify;
    };
  });

  function makeFakeIssueStore() {
    const issues = new Map();
    issues.set('issue-1', {
      id: 'issue-1',
      repo: 'owner/repo',
      issueNumber: 42,
      issueType: 'bug',
      title: 'Test',
      state: 'unreplied',
      replyState: 'unreplied',
      assignedThreadId: null,
      assignedCatId: null,
      linkedPrNumbers: [],
      directionCard: null,
      ownerDecision: null,
      relatedFeature: null,
      guardianAssignment: null,
      lastActivity: { at: 1000, event: 'created' },
      createdAt: 1000,
      updatedAt: 1000,
    });
    return {
      get: async (id) => issues.get(id) ?? null,
      create: async (input) => ({ id: 'new-id', ...input }),
      update: async (id, patch) => {
        const existing = issues.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...patch };
        issues.set(id, updated);
        return updated;
      },
      listAll: async () => [...issues.values()],
      listByRepo: async (repo) => [...issues.values()].filter((i) => i.repo === repo),
      getByRepoAndNumber: async (repo, n) =>
        [...issues.values()].find((i) => i.repo === repo && i.issueNumber === n) ?? null,
      delete: async (id) => {
        issues.delete(id);
      },
    };
  }

  it('dispatch emits case.triaged event when eventLog injected', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();
    const app = buildApp({ eventLog, projector });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/issue-1/dispatch',
      body: JSON.stringify({ threadId: 'thread-new' }),
      headers: { 'content-type': 'application/json' },
    });

    assert.strictEqual(res.statusCode, 200, 'dispatch should succeed');

    // Community event emitted
    assert.ok(eventLog.events.length >= 1, 'at least one event should be in log');
    const triageEv = eventLog.events.find((e) => e.kind === 'case.triaged');
    assert.ok(triageEv, 'case.triaged event must be emitted');
    assert.ok(triageEv.subjectKey.includes('owner/repo#42'));

    await app.close();
  });

  it('dispatch without eventLog still works (backward compat)', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/issue-1/dispatch',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    assert.strictEqual(res.statusCode, 200);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Task 2 (Phase B): new webhook event types — activity signals
// ---------------------------------------------------------------------------

describe('Task 2 (Phase B) — new webhook event types', () => {
  // Helper: build a handler that tracks whether deliverFn was called
  async function buildHandlerWithDeliveryTracker(extraDeps = {}) {
    let deliveryCalls = 0;
    const handler = await buildWebhookHandler({
      deliverFn: async () => {
        deliveryCalls++;
        return { messageId: `msg-${deliveryCalls}` };
      },
      ...extraDeps,
    });
    return { handler, getDeliveryCalls: () => deliveryCalls };
  }

  it('issue_comment.created appends issue.commented with comment-based sourceEventId (no inbox notification)', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();
    const { handler, getDeliveryCalls } = await buildHandlerWithDeliveryTracker({ eventLog, projector });

    const commentId = 9876;
    const bodyObj = {
      action: 'created',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1, login: 'reporter' },
      issue: {
        number: 42,
        title: 'Bug report',
        html_url: 'https://github.com/owner/repo/issues/42',
        author_association: 'NONE',
        user: { login: 'reporter' },
      },
      comment: {
        id: commentId,
        body: 'Any update?',
        user: { login: 'reporter', author_association: 'NONE' },
        html_url: 'https://github.com/owner/repo/issues/42#issuecomment-9876',
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const deliveryId = 'delivery-comment-1';
    const headers = {
      'x-github-event': 'issue_comment',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signBody('test-secret', rawBody),
    };

    const result = await handler.handleWebhook(bodyObj, headers, rawBody);
    assert.strictEqual(result.kind, 'processed', 'issue_comment.created must be processed');

    // Event log gets the event
    assert.strictEqual(eventLog.events.length, 1, 'exactly one event appended');
    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'issue.commented', 'kind must be issue.commented');
    assert.strictEqual(
      ev.sourceEventId,
      `comment:owner/repo#42:${commentId}`,
      'sourceEventId must use comment-based key for dedup with polling path',
    );
    assert.ok(ev.subjectKey.startsWith('issue:owner/repo#42'), 'subjectKey must identify the issue');

    // Projector called
    assert.strictEqual(projector.applied.length, 1, 'projector must be called');

    // No inbox notification — activity signals must not spam the Repo Inbox
    assert.strictEqual(getDeliveryCalls(), 0, 'issue_comment must NOT trigger Repo Inbox notification');
  });

  it('issues.labeled appends issue.labeled event (no inbox notification)', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();
    const { handler, getDeliveryCalls } = await buildHandlerWithDeliveryTracker({ eventLog, projector });

    const bodyObj = {
      action: 'labeled',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1, login: 'maintainer' },
      issue: {
        number: 42,
        title: 'Bug report',
        html_url: 'https://github.com/owner/repo/issues/42',
        author_association: 'NONE',
        user: { login: 'reporter' },
      },
      label: { name: 'needs-info', color: 'e4e669' },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-label-1',
      'x-hub-signature-256': signBody('test-secret', rawBody),
    };

    const result = await handler.handleWebhook(bodyObj, headers, rawBody);
    assert.strictEqual(result.kind, 'processed', 'issues.labeled must be processed');

    assert.strictEqual(eventLog.events.length, 1);
    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'issue.labeled');
    assert.ok(ev.subjectKey.startsWith('issue:owner/repo#42'));

    assert.strictEqual(getDeliveryCalls(), 0, 'labeled must NOT trigger Repo Inbox notification');
  });

  it('pull_request_review.submitted appends pr.review_submitted event (no inbox notification)', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();
    const { handler, getDeliveryCalls } = await buildHandlerWithDeliveryTracker({ eventLog, projector });

    const reviewId = 555;
    const bodyObj = {
      action: 'submitted',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1, login: 'reviewer' },
      review: {
        id: reviewId,
        body: 'LGTM',
        state: 'approved',
        user: { login: 'reviewer', author_association: 'OWNER' },
        html_url: 'https://github.com/owner/repo/pull/7#pullrequestreview-555',
        author_association: 'OWNER',
      },
      pull_request: {
        number: 7,
        title: 'Add feature',
        html_url: 'https://github.com/owner/repo/pull/7',
        author_association: 'CONTRIBUTOR',
        user: { login: 'contributor' },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'x-github-event': 'pull_request_review',
      'x-github-delivery': 'delivery-review-1',
      'x-hub-signature-256': signBody('test-secret', rawBody),
    };

    const result = await handler.handleWebhook(bodyObj, headers, rawBody);
    assert.strictEqual(result.kind, 'processed', 'pull_request_review.submitted must be processed');

    assert.strictEqual(eventLog.events.length, 1);
    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'pr.review_submitted');
    assert.ok(ev.subjectKey.startsWith('pr:owner/repo#7'));

    assert.strictEqual(getDeliveryCalls(), 0, 'pr_review must NOT trigger Repo Inbox notification');
  });

  it('pull_request.closed (merged=false) appends pr.closed and sends inbox notification', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();
    const { handler, getDeliveryCalls } = await buildHandlerWithDeliveryTracker({ eventLog, projector });

    const bodyObj = {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1, login: 'contributor' },
      pull_request: {
        number: 7,
        title: 'Add feature',
        html_url: 'https://github.com/owner/repo/pull/7',
        author_association: 'CONTRIBUTOR',
        user: { login: 'contributor' },
        merged: false,
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-pr-closed-1',
      'x-hub-signature-256': signBody('test-secret', rawBody),
    };

    const result = await handler.handleWebhook(bodyObj, headers, rawBody);
    assert.strictEqual(result.kind, 'processed');

    assert.strictEqual(eventLog.events.length, 1);
    assert.strictEqual(eventLog.events[0].kind, 'pr.closed', 'unmerged closed PR must produce pr.closed');

    // pr.closed should still send inbox notification (same as pr.opened behavior)
    assert.strictEqual(getDeliveryCalls(), 1, 'pr.closed must trigger Repo Inbox notification');
  });

  it('pull_request.closed (merged=true) appends pr.merged and sends inbox notification', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();
    const { handler, getDeliveryCalls } = await buildHandlerWithDeliveryTracker({ eventLog, projector });

    const bodyObj = {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1, login: 'contributor' },
      pull_request: {
        number: 7,
        title: 'Add feature',
        html_url: 'https://github.com/owner/repo/pull/7',
        author_association: 'CONTRIBUTOR',
        user: { login: 'contributor' },
        merged: true,
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-pr-merged-1',
      'x-hub-signature-256': signBody('test-secret', rawBody),
    };

    const result = await handler.handleWebhook(bodyObj, headers, rawBody);
    assert.strictEqual(result.kind, 'processed');

    assert.strictEqual(eventLog.events.length, 1);
    assert.strictEqual(eventLog.events[0].kind, 'pr.merged', 'merged PR must produce pr.merged event');

    assert.strictEqual(getDeliveryCalls(), 1, 'pr.merged must trigger Repo Inbox notification');
  });
});

// ---------------------------------------------------------------------------
// R1 Fix tests: P1-1 / P1-2 / P1-3 / P1-4 from @codex review
// ---------------------------------------------------------------------------

describe('R1 fixes — P1-1: pr.merged|closed sourceEventId must align with polling path', () => {
  it('pull_request.closed (merged=true) uses lifecycle sourceEventId, not delivery ID', async () => {
    const eventLog = makeInMemoryEventLog();
    const handler = await buildWebhookHandler({ eventLog });

    const bodyObj = {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1 },
      pull_request: {
        number: 7,
        title: 'Feature PR',
        html_url: 'https://github.com/owner/repo/pull/7',
        author_association: 'CONTRIBUTOR',
        user: { login: 'contributor' },
        merged: true,
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-should-not-appear',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'pr.merged');
    // Must match polling path format: lifecycle:pr:owner/repo#7:merged
    assert.strictEqual(
      ev.sourceEventId,
      'lifecycle:pr:owner/repo#7:merged',
      'pr.merged sourceEventId must be lifecycle key to dedup with polling path',
    );
  });

  it('pull_request.closed (merged=false) uses lifecycle:...closed sourceEventId', async () => {
    const eventLog = makeInMemoryEventLog();
    const handler = await buildWebhookHandler({ eventLog });

    const bodyObj = {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1 },
      pull_request: {
        number: 7,
        title: 'Feature PR',
        html_url: 'https://github.com/owner/repo/pull/7',
        author_association: 'CONTRIBUTOR',
        user: { login: 'contributor' },
        merged: false,
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-should-not-appear',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'pr.closed');
    assert.strictEqual(
      ev.sourceEventId,
      'lifecycle:pr:owner/repo#7:closed',
      'pr.closed sourceEventId must be lifecycle key',
    );
  });
});

describe('R1 fixes — P1-2: pr.opened payload must include body for projector link parsing', () => {
  it('pull_request.opened webhook payload contains body field', async () => {
    const eventLog = makeInMemoryEventLog();
    const handler = await buildWebhookHandler({ eventLog });

    const bodyObj = {
      action: 'opened',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1 },
      pull_request: {
        number: 7,
        title: 'Fix the bug',
        body: 'Fixes #42\n\nDetailed description.',
        html_url: 'https://github.com/owner/repo/pull/7',
        author_association: 'CONTRIBUTOR',
        user: { login: 'contributor' },
        draft: false,
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-pr-open-body',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    assert.strictEqual(eventLog.events.length, 1);
    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'pr.opened');
    assert.strictEqual(
      ev.payload.body,
      'Fixes #42\n\nDetailed description.',
      'pr.opened event payload must include PR body so projector can parse linkedIssues',
    );
  });
});

describe('R1 fixes — P1-3: log-only append failure must not confirm dedup (GitHub must retry)', () => {
  it('log-only append failure triggers rollback and propagates error', async () => {
    let rollbackCalled = false;
    let confirmCalled = false;
    const fakeDedup = {
      claim: async () => true,
      confirm: async () => {
        confirmCalled = true;
      },
      rollback: async () => {
        rollbackCalled = true;
      },
    };
    const brokenEventLog = {
      append: async () => {
        throw new Error('Redis unavailable');
      },
      read: async () => [],
      listSubjects: async () => [],
    };

    const mod = await import('../dist/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.js');
    const { GitHubRepoWebhookHandler } = mod;
    const handler = new GitHubRepoWebhookHandler(
      {
        webhookSecret: 'test-secret',
        repoAllowlist: ['owner/repo'],
        defaultUserId: 'user-1',
        inboxCatId: 'codex',
      },
      {
        dedup: fakeDedup,
        bindingStore: { getByExternal: async () => null, bind: async (_c, _e, tid) => ({ threadId: tid }) },
        threadStore: { create: async () => ({ id: 'thread-1' }) },
        deliverFn: async () => ({ messageId: 'msg-1' }),
        invokeTrigger: { trigger: () => {} },
        eventLog: brokenEventLog,
      },
    );

    const commentBody = {
      action: 'created',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1 },
      issue: { number: 42, title: 'Bug' },
      comment: { id: 999, body: 'hi', user: { login: 'user' } },
    };
    const rawBody = Buffer.from(JSON.stringify(commentBody));

    await assert.rejects(
      () =>
        handler.handleWebhook(
          commentBody,
          {
            'x-github-event': 'issue_comment',
            'x-github-delivery': 'delivery-log-only-fail',
            'x-hub-signature-256': signBody('test-secret', rawBody),
          },
          rawBody,
        ),
      /Redis unavailable/,
      'log-only append failure must propagate so GitHub retries',
    );

    assert.strictEqual(rollbackCalled, true, 'dedup.rollback must be called on log-only failure');
    assert.strictEqual(confirmCalled, false, 'dedup.confirm must NOT be called when append fails');
  });
});

describe('R1 fixes — P1-4a: activity event payloads must include authorAssociation', () => {
  it('issue.commented payload includes authorAssociation from comment', async () => {
    const eventLog = makeInMemoryEventLog();
    const handler = await buildWebhookHandler({ eventLog });

    const bodyObj = {
      action: 'created',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1 },
      issue: { number: 42, title: 'Bug' },
      comment: {
        id: 777,
        body: 'Please fix this.',
        user: { login: 'contributor' },
        author_association: 'CONTRIBUTOR',
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-comment-assoc',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'issue.commented');
    assert.strictEqual(
      ev.payload.authorAssociation,
      'CONTRIBUTOR',
      'issue.commented payload must include authorAssociation for delivery policy',
    );
  });

  it('pr.review_submitted payload includes authorAssociation from review', async () => {
    const eventLog = makeInMemoryEventLog();
    const handler = await buildWebhookHandler({ eventLog });

    const reviewId = 888;
    const bodyObj = {
      action: 'submitted',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1 },
      review: {
        id: reviewId,
        body: 'LGTM',
        state: 'approved',
        author_association: 'MEMBER',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 7,
        title: 'PR title',
        html_url: 'https://...',
        user: { login: 'contributor' },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'pull_request_review',
        'x-github-delivery': 'delivery-review-assoc',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'pr.review_submitted');
    assert.strictEqual(
      ev.payload.authorAssociation,
      'MEMBER',
      'pr.review_submitted payload must include authorAssociation for delivery policy',
    );
  });
});

describe('R1 fixes — P1-4b: pr.review_submitted sourceEventId must use stable review key', () => {
  it('pr.review_submitted uses review:{repo}#{pr}:{reviewId} sourceEventId', async () => {
    const eventLog = makeInMemoryEventLog();
    const handler = await buildWebhookHandler({ eventLog });

    const reviewId = 555;
    const bodyObj = {
      action: 'submitted',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1 },
      review: {
        id: reviewId,
        body: 'Changes requested',
        state: 'changes_requested',
        author_association: 'OWNER',
        user: { login: 'owner-user' },
      },
      pull_request: {
        number: 7,
        title: 'PR',
        html_url: 'https://...',
        user: { login: 'contributor' },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'pull_request_review',
        'x-github-delivery': 'delivery-should-not-appear-review',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    const ev = eventLog.events[0];
    assert.strictEqual(ev.kind, 'pr.review_submitted');
    assert.strictEqual(
      ev.sourceEventId,
      `review:owner/repo#7:${reviewId}`,
      'pr.review_submitted sourceEventId must be stable review key, not delivery ID',
    );
  });
});

// ---------------------------------------------------------------------------
// Cloud R1 fixes — P1: PR conversation comments must NOT emit issue.commented
// ---------------------------------------------------------------------------

describe('Cloud R1 — P1: issue_comment on PR conversation must not emit issue.commented', () => {
  it('issue_comment.created where issue.pull_request is set → no event appended', async () => {
    const eventLog = makeInMemoryEventLog();
    const handler = await buildWebhookHandler({ eventLog });

    // GitHub sends issue_comment with payload.issue.pull_request present for PR conversations
    const bodyObj = {
      action: 'created',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1, login: 'octocat' },
      issue: {
        number: 7,
        // ← pull_request field marks this as a PR conversation comment
        pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/7' },
      },
      comment: {
        id: 99,
        user: { login: 'octocat' },
        author_association: 'CONTRIBUTOR',
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-pr-conv',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    assert.strictEqual(eventLog.events.length, 0, 'PR conversation comments must NOT be logged as issue.commented');
  });

  it('issue_comment.created without pull_request field → still emits issue.commented', async () => {
    const eventLog = makeInMemoryEventLog();
    const handler = await buildWebhookHandler({ eventLog });

    const bodyObj = {
      action: 'created',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1, login: 'octocat' },
      issue: {
        number: 5,
        // ← no pull_request field = real issue comment
      },
      comment: {
        id: 55,
        user: { login: 'octocat' },
        author_association: 'CONTRIBUTOR',
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-issue-comment',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    assert.strictEqual(eventLog.events.length, 1, 'real issue comment must be logged');
    assert.strictEqual(eventLog.events[0].kind, 'issue.commented');
    assert.strictEqual(eventLog.events[0].subjectKey, 'issue:owner/repo#5');
  });
});

// ---------------------------------------------------------------------------
// Cloud R1 fixes — P2: merged PR inbox message must say "merged" not "closed"
// ---------------------------------------------------------------------------

describe('Cloud R1 — P2: merged PR webhook inbox message must say "merged" not "closed"', () => {
  it('pull_request.closed with merged=true → deliverFn content contains "merged"', async () => {
    const deliveredContents = [];
    const handler = await buildWebhookHandler({
      deliverFn: async (_deps, input) => {
        deliveredContents.push(input.content);
        return { messageId: 'msg-p2-test' };
      },
    });

    const bodyObj = {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1, login: 'octocat' },
      pull_request: {
        number: 42,
        title: 'Fix the thing',
        html_url: 'https://github.com/owner/repo/pull/42',
        merged: true, // ← this is a merge, not a plain close
        draft: false,
        user: { login: 'contributor' },
        author_association: 'CONTRIBUTOR',
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-merged-pr',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    assert.ok(deliveredContents.length > 0, 'deliverFn must have been called');
    const content = deliveredContents[0];
    assert.ok(content.includes('merged'), `inbox message must say "merged" for merged PRs, got: ${content}`);
    assert.ok(
      !content.includes(' closed') || content.includes('merged'),
      'inbox message must not only say "closed" for merged PRs',
    );
  });

  it('pull_request.closed with merged=false → inbox message says "closed"', async () => {
    const deliveredContents = [];
    const handler = await buildWebhookHandler({
      deliverFn: async (_deps, input) => {
        deliveredContents.push(input.content);
        return { messageId: 'msg-closed-test' };
      },
    });

    const bodyObj = {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1, login: 'octocat' },
      pull_request: {
        number: 43,
        title: 'Closed without merge',
        html_url: 'https://github.com/owner/repo/pull/43',
        merged: false,
        draft: false,
        user: { login: 'contributor' },
        author_association: 'CONTRIBUTOR',
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-closed-pr',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    assert.ok(deliveredContents.length > 0, 'deliverFn must have been called');
    const content = deliveredContents[0];
    assert.ok(content.includes('closed'), `inbox message must say "closed" for closed PRs, got: ${content}`);
    assert.ok(!content.includes('merged'), 'inbox message must not say "merged" for closed PRs');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cloud R2 — P2a: pr.merged payload must include body for late-added closing keywords
// ─────────────────────────────────────────────────────────────────────────────

describe('Cloud R2 — P2a: pr.merged event payload includes body for late-added closing keywords', () => {
  it('pull_request.closed with merged=true includes body in pr.merged event payload', async () => {
    const eventLog = makeInMemoryEventLog();
    const handler = await buildWebhookHandler({ eventLog });

    const bodyObj = {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1 },
      pull_request: {
        number: 10,
        title: 'Add feature',
        body: 'Closes #99',
        html_url: 'https://github.com/owner/repo/pull/10',
        merged: true,
        draft: false,
        user: { login: 'dev' },
        author_association: 'CONTRIBUTOR',
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-merge-body-r2-p2a',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    assert.ok(eventLog.events.length >= 1, 'pr.merged event must be appended');
    const mergedEv = eventLog.events.find((e) => e.kind === 'pr.merged');
    assert.ok(mergedEv, 'pr.merged event must be in event log');
    assert.strictEqual(
      mergedEv.payload.body,
      'Closes #99',
      'pr.merged event payload must include PR body for late-added closing keywords',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cloud R2 — P2b: informational activity events must not pollute lastRejectedEvent
// ─────────────────────────────────────────────────────────────────────────────

describe('Cloud R2 — P2b: informational activity events update lastExternalActivityAt not lastRejectedEvent', () => {
  let CommunityProjector;
  before(async () => {
    const mod = await import('../dist/domains/community/community-projector.js');
    CommunityProjector = mod.CommunityProjector;
  });

  it('issue.commented (informational) sets lastExternalActivityAt, clears lastRejectedEvent', async () => {
    const objectStore = makeInMemoryCommunityObjectStore();
    const eventLog = makeInMemoryEventLog();
    const projector = new CommunityProjector(eventLog, objectStore);

    // Seed: issue opened (state → 'new')
    const openedEv = {
      sourceEventId: 'seed-r2-p2b-opened',
      subjectKey: 'issue:owner/repo#20',
      kind: 'issue.opened',
      classification: 'state-changing',
      payload: { title: 'Test issue', authorLogin: 'user' },
      at: 100,
    };
    await eventLog.append(openedEv);
    await projector.apply(openedEv);

    // Apply informational activity event (state machine has no rule for this kind)
    const commentEv = {
      sourceEventId: 'activity-r2-p2b-comment-1',
      subjectKey: 'issue:owner/repo#20',
      kind: 'issue.commented',
      classification: 'informational',
      payload: { commentId: 42, commenterLogin: 'contributor', authorAssociation: 'CONTRIBUTOR' },
      at: 200,
    };
    await eventLog.append(commentEv);
    await projector.apply(commentEv);

    const proj = await objectStore.get('issue:owner/repo#20');
    assert.ok(proj, 'projection must exist');
    assert.strictEqual(
      proj.lastRejectedEvent,
      null,
      'informational activity events must NOT pollute lastRejectedEvent',
    );
    assert.strictEqual(
      proj.lastExternalActivityAt,
      200,
      'informational activity events must update lastExternalActivityAt',
    );
    assert.strictEqual(proj.state, 'new', 'state must remain "new" — informational events do not change state');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cloud R2 — P2c: pr.merged with body containing closing keywords cascades via body
// ─────────────────────────────────────────────────────────────────────────────

describe('Cloud R2 — P2c: pr.merged body with closing keywords cascades to linked issue', () => {
  let CommunityProjector;
  before(async () => {
    const mod = await import('../dist/domains/community/community-projector.js');
    CommunityProjector = mod.CommunityProjector;
  });

  it('pr.merged with body "Closes #99" cascades to issue:owner/repo#99 → fixed (even if pr.opened had no keywords)', async () => {
    const objectStore = makeInMemoryCommunityObjectStore();
    const eventLog = makeInMemoryEventLog();
    const projector = new CommunityProjector(eventLog, objectStore);

    // Seed: PR opened without closing keywords in body
    const openedEv = {
      sourceEventId: 'ev-r2-p2c-pr-opened',
      subjectKey: 'pr:owner/repo#10',
      kind: 'pr.opened',
      classification: 'state-changing',
      payload: { title: 'Add feature', authorLogin: 'dev', body: null },
      at: 100,
    };
    await eventLog.append(openedEv);
    await projector.apply(openedEv);

    // Verify no linked issues from opening
    const prProjBefore = await objectStore.get('pr:owner/repo#10');
    assert.deepStrictEqual(prProjBefore?.linkedIssues ?? [], [], 'no linked issues after pr.opened with null body');

    // Apply pr.merged with body containing closing keyword (added after PR was opened)
    const mergeEv = {
      sourceEventId: 'ev-r2-p2c-pr-merged',
      subjectKey: 'pr:owner/repo#10',
      kind: 'pr.merged',
      classification: 'state-changing',
      payload: { title: 'Add feature', authorLogin: 'dev', body: 'Closes #99' },
      at: 200,
    };
    await eventLog.append(mergeEv);
    await projector.apply(mergeEv);

    // Issue #99 must have received a cascade and be in 'fixed' state
    const issueProj = await objectStore.get('issue:owner/repo#99');
    assert.ok(issueProj, 'issue:owner/repo#99 projection must exist after cascade from body-based link');
    assert.strictEqual(
      issueProj.state,
      'fixed',
      'issue must be in fixed state after cascade triggered by pr.merged with closing keyword in body',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dedup-aware event log helper (for P1-1 race condition tests)
// ─────────────────────────────────────────────────────────────────────────────

function makeDeduplicatingEventLog(preSeeded = []) {
  const events = [...preSeeded];
  const seen = new Set(preSeeded.map((e) => e.sourceEventId));
  return {
    events,
    append: async (event) => {
      if (seen.has(event.sourceEventId)) {
        return { appended: false };
      }
      seen.add(event.sourceEventId);
      events.push(event);
      return { appended: true, sequence: events.length - 1 };
    },
    read: async (subjectKey) => events.filter((e) => e.subjectKey === subjectKey),
    listSubjects: async () => [...new Set(events.map((e) => e.subjectKey))],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloud R4 — P1-1: body-enrichment fallback when poller wins the merge race
// ─────────────────────────────────────────────────────────────────────────────

describe('Cloud R4 — P1-1: webhook handler emits body-enrichment when poller wins race', () => {
  let CommunityProjector;
  before(async () => {
    const mod = await import('../dist/domains/community/community-projector.js');
    CommunityProjector = mod.CommunityProjector;
  });

  it('webhook must emit :body-enrichment event so late-linked issue #88 gets cascaded to fixed', async () => {
    // Simulate: poller already appended lifecycle:pr:owner/repo#42:merged WITHOUT body
    const pollerEvent = {
      sourceEventId: 'lifecycle:pr:owner/repo#42:merged',
      subjectKey: 'pr:owner/repo#42',
      kind: 'pr.merged',
      classification: 'state-changing',
      payload: { prState: 'merged', repoFullName: 'owner/repo', prNumber: 42 },
      at: 100,
    };
    const objectStore = makeInMemoryCommunityObjectStore();
    const eventLog = makeDeduplicatingEventLog([pollerEvent]);
    const projector = new CommunityProjector(eventLog, objectStore);

    // Pre-apply the poller event so PR is in 'fixed' state, linkedIssues empty
    await projector.apply(pollerEvent);

    // Confirm: issue #88 does NOT exist yet
    assert.strictEqual(await objectStore.get('issue:owner/repo#88'), null, 'issue must not exist before webhook fires');

    // Webhook fires with pull_request.closed (merged=true) and body "Fixes #88"
    const handler = await buildWebhookHandler({ eventLog, projector });
    const bodyObj = {
      action: 'closed',
      repository: { full_name: 'owner/repo', default_branch: 'main' },
      sender: { id: 1 },
      pull_request: {
        number: 42,
        title: 'Add feature',
        body: 'Fixes #88',
        html_url: 'https://github.com/owner/repo/pull/42',
        author_association: 'CONTRIBUTOR',
        user: { login: 'dev' },
        merged: true,
        draft: false,
        base: { ref: 'main' },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    await handler.handleWebhook(
      bodyObj,
      {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-r4-p11-race',
        'x-hub-signature-256': signBody('test-secret', rawBody),
      },
      rawBody,
    );

    // The standard lifecycle event was deduped (poller already had it).
    // Webhook must emit :body-enrichment fallback to pick up late-added closing keywords.
    const enrichmentEvents = eventLog.events.filter((e) => e.sourceEventId.endsWith(':body-enrichment'));
    assert.strictEqual(
      enrichmentEvents.length,
      1,
      'webhook must emit exactly one body-enrichment event when lifecycle event was deduped',
    );
    assert.strictEqual(enrichmentEvents[0].payload.body, 'Fixes #88', 'body-enrichment event must carry the PR body');

    // Issue #88 must be cascaded to fixed via the body-enrichment event
    const issueProj = await objectStore.get('issue:owner/repo#88');
    assert.ok(issueProj, 'issue:owner/repo#88 must exist after body-enrichment cascade');
    assert.strictEqual(issueProj.state, 'fixed', 'issue #88 must be fixed after body-enrichment cascade');
  });
});

describe('Cloud R4 — P1-1: body-enrichment fallback when poller wins merge race', () => {
  let CommunityProjector;
  before(async () => {
    const mod = await import('../dist/domains/community/community-projector.js');
    CommunityProjector = mod.CommunityProjector;
  });

  it('pr.merged from fixed state with body discovers late-linked issues and cascades them to fixed', async () => {
    // Simulate: poller already appended lifecycle:...:merged WITHOUT body → PR went to fixed state
    // Webhook then emits :body-enrichment event WITH body containing "Fixes #88"
    // Projector must update linkedIssues and cascade issue #88 → fixed
    const objectStore = makeInMemoryCommunityObjectStore();
    const eventLog = makeInMemoryEventLog();
    const projector = new CommunityProjector(eventLog, objectStore);

    // Step 1: PR opened without closing keywords (no linkedIssues populated)
    const openedEv = {
      sourceEventId: 'ev-r4-p11-pr-opened',
      subjectKey: 'pr:owner/repo#77',
      kind: 'pr.opened',
      classification: 'state-changing',
      payload: { title: 'Feature', authorLogin: 'dev', body: null },
      at: 100,
    };
    await eventLog.append(openedEv);
    await projector.apply(openedEv);

    // Step 2: Poller appended lifecycle:...:merged WITHOUT body (won the race)
    const pollerMergeEv = {
      sourceEventId: 'lifecycle:pr:owner/repo#77:merged',
      subjectKey: 'pr:owner/repo#77',
      kind: 'pr.merged',
      classification: 'state-changing',
      payload: { prState: 'merged', repoFullName: 'owner/repo', prNumber: 77 }, // no body
      at: 200,
    };
    await eventLog.append(pollerMergeEv);
    await projector.apply(pollerMergeEv);

    // Verify: PR is fixed, but issue #88 does not yet exist (body not parsed)
    const prProjAfterPoller = await objectStore.get('pr:owner/repo#77');
    assert.strictEqual(prProjAfterPoller?.state, 'fixed', 'PR must be fixed after poller pr.merged');
    const issueBeforeEnrichment = await objectStore.get('issue:owner/repo#88');
    assert.strictEqual(issueBeforeEnrichment, null, 'issue #88 must not exist before body-enrichment');

    // Step 3: Webhook emits :body-enrichment event (distinct sourceEventId) WITH body "Fixes #88"
    const bodyEnrichmentEv = {
      sourceEventId: 'lifecycle:pr:owner/repo#77:merged:body-enrichment',
      subjectKey: 'pr:owner/repo#77',
      kind: 'pr.merged',
      classification: 'state-changing',
      payload: { title: 'Feature', authorLogin: 'dev', body: 'Fixes #88' },
      at: 210,
    };
    await eventLog.append(bodyEnrichmentEv);
    await projector.apply(bodyEnrichmentEv);

    // Assert: issue #88 must now be in fixed state after cascade from body-enrichment
    const issueAfterEnrichment = await objectStore.get('issue:owner/repo#88');
    assert.ok(issueAfterEnrichment, 'issue:owner/repo#88 must exist after body-enrichment cascade');
    assert.strictEqual(
      issueAfterEnrichment.state,
      'fixed',
      'issue #88 must be fixed after cascade from body-enrichment pr.merged',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cloud R4 — P1-2: gate closing-keyword parsing to default-branch PRs
// ─────────────────────────────────────────────────────────────────────────────

describe('Cloud R4 — P1-2: gate closing-keyword parsing to default-branch PRs', () => {
  let CommunityProjector;
  before(async () => {
    const mod = await import('../dist/domains/community/community-projector.js');
    CommunityProjector = mod.CommunityProjector;
  });

  it('pr.opened with isDefaultBranchPr:false must NOT populate linkedIssues from body', async () => {
    const objectStore = makeInMemoryCommunityObjectStore();
    const eventLog = makeInMemoryEventLog();
    const projector = new CommunityProjector(eventLog, objectStore);

    // PR targets a release branch — GitHub ignores closing keywords here
    const openedEv = {
      sourceEventId: 'ev-r4-p12-non-default-opened',
      subjectKey: 'pr:owner/repo#55',
      kind: 'pr.opened',
      classification: 'state-changing',
      payload: {
        title: 'Release fix',
        authorLogin: 'dev',
        body: 'Fixes #200',
        isDefaultBranchPr: false,
      },
      at: 100,
    };
    await eventLog.append(openedEv);
    await projector.apply(openedEv);

    const proj = await objectStore.get('pr:owner/repo#55');
    assert.ok(proj, 'PR projection must exist');
    assert.deepStrictEqual(
      proj.linkedIssues,
      [],
      'non-default-branch PR must NOT populate linkedIssues from body even if body contains closing keywords',
    );
    const issueProj = await objectStore.get('issue:owner/repo#200');
    assert.strictEqual(issueProj, null, 'issue #200 must not exist — cascade must not fire for non-default-branch PR');
  });

  it('pr.opened with isDefaultBranchPr:true DOES populate linkedIssues from body', async () => {
    const objectStore = makeInMemoryCommunityObjectStore();
    const eventLog = makeInMemoryEventLog();
    const projector = new CommunityProjector(eventLog, objectStore);

    // PR targets default branch — closing keywords are honored
    const openedEv = {
      sourceEventId: 'ev-r4-p12-default-opened',
      subjectKey: 'pr:owner/repo#56',
      kind: 'pr.opened',
      classification: 'state-changing',
      payload: {
        title: 'Fix bug',
        authorLogin: 'dev',
        body: 'Fixes #201',
        isDefaultBranchPr: true,
      },
      at: 100,
    };
    await eventLog.append(openedEv);
    await projector.apply(openedEv);

    const proj = await objectStore.get('pr:owner/repo#56');
    assert.ok(proj, 'PR projection must exist');
    assert.deepStrictEqual(
      proj.linkedIssues,
      [201],
      'default-branch PR with closing keywords MUST populate linkedIssues',
    );
  });

  it('pr.merged with isDefaultBranchPr:false must NOT update linkedIssues from body', async () => {
    const objectStore = makeInMemoryCommunityObjectStore();
    const eventLog = makeInMemoryEventLog();
    const projector = new CommunityProjector(eventLog, objectStore);

    // Non-default-branch pr.merged with body containing closing keywords
    const mergeEv = {
      sourceEventId: 'ev-r4-p12-non-default-merged',
      subjectKey: 'pr:owner/repo#57',
      kind: 'pr.merged',
      classification: 'state-changing',
      payload: {
        title: 'Release PR',
        authorLogin: 'dev',
        body: 'Fixes #202',
        isDefaultBranchPr: false,
      },
      at: 100,
    };
    await eventLog.append(mergeEv);
    await projector.apply(mergeEv);

    const proj = await objectStore.get('pr:owner/repo#57');
    assert.ok(proj, 'PR projection must exist');
    assert.deepStrictEqual(
      proj.linkedIssues,
      [],
      'non-default-branch pr.merged must NOT update linkedIssues from body',
    );
    const issueProj = await objectStore.get('issue:owner/repo#202');
    assert.strictEqual(issueProj, null, 'issue #202 must not be cascaded from non-default-branch pr.merged');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cloud R5 — P1: log-only projector repair on GitHub retry
// ─────────────────────────────────────────────────────────────────────────────

describe('Cloud R5 — P1: log-only projector repair on GitHub retry', () => {
  it('webhook retry calls projector.apply() when event is already in log (appended:false)', async () => {
    // Simulate retry scenario:
    //   Attempt 1: append() succeeded, projector.apply() threw → caller rolled back dedup → GitHub retries
    //   Attempt 2: append() returns {appended:false} (event already in log)
    // The projector MUST still be called on attempt 2 to repair lastExternalActivityAt.
    const preSeededId = 'comment:owner/repo#42:999';
    const eventLog = makeDeduplicatingEventLog([
      {
        sourceEventId: preSeededId,
        subjectKey: 'issue:owner/repo#42',
        kind: 'issue.commented',
        classification: 'informational',
        payload: { commentId: 999, authorLogin: 'octocat', authorAssociation: 'CONTRIBUTOR' },
        at: 100,
      },
    ]);

    const projector = makeInMemoryProjector();
    const handler = await buildWebhookHandler({ eventLog, projector });

    const bodyObj = {
      action: 'created',
      repository: { full_name: 'owner/repo' },
      sender: { id: 1, login: 'octocat' },
      issue: {
        number: 42,
        title: 'Test issue',
        html_url: 'https://github.com/owner/repo/issues/42',
        author_association: 'CONTRIBUTOR',
        user: { login: 'octocat' },
        // No pull_request field — this is a real issue comment, not a PR conversation comment
      },
      comment: { id: 999, user: { login: 'octocat' }, author_association: 'CONTRIBUTOR' },
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'x-github-event': 'issue_comment',
      'x-github-delivery': 'delivery-retry-r5',
      'x-hub-signature-256': signBody('test-secret', rawBody),
    };

    const result = await handler.handleWebhook(bodyObj, headers, rawBody);
    assert.strictEqual(result.kind, 'processed', 'retry delivery must be processed');

    // KEY: projector.apply must be called on retry even though appended=false (repair path)
    assert.strictEqual(
      projector.applied.length,
      1,
      'projector must be called on retry to repair lastExternalActivityAt',
    );
    assert.strictEqual(projector.applied[0].kind, 'issue.commented');
  });
});
