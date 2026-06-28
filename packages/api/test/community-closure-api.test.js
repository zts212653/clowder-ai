import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ---------------------------------------------------------------------------
// Helpers — lightweight Fastify app builder for route testing
// ---------------------------------------------------------------------------

const Fastify = (await import('fastify')).default;
const { communityIssueRoutes } = await import('../dist/routes/community-issues.js');

/** Minimal in-memory event log for testing closure endpoints. */
function createTestEventLog() {
  const events = [];
  return {
    events,
    async append(event) {
      events.push(event);
      return { appended: true };
    },
    async getBySubject(subjectKey) {
      return events.filter((e) => e.subjectKey === subjectKey);
    },
  };
}

/** Minimal projector that tracks apply calls. */
function createTestProjector() {
  const applied = [];
  return {
    applied,
    async apply(event) {
      applied.push(event);
    },
  };
}

/** Minimal object store with get/put. */
function createTestObjectStore(projections = {}) {
  const store = { ...projections };
  return {
    async get(subjectKey) {
      return store[subjectKey] ?? null;
    },
    async put(subjectKey, proj) {
      store[subjectKey] = proj;
    },
    store,
  };
}

/** Minimal community issue store. */
function createTestIssueStore(issues = {}) {
  return {
    async get(id) {
      return issues[id] ?? null;
    },
    async list() {
      return Object.values(issues);
    },
    async listAll() {
      return Object.values(issues);
    },
    async create(data) {
      const id = `issue-${Date.now()}`;
      issues[id] = { id, ...data };
      return issues[id];
    },
    async update(id, patch) {
      if (issues[id]) Object.assign(issues[id], patch);
      return issues[id];
    },
    async delete(id) {
      delete issues[id];
    },
  };
}

function createTestTaskStore() {
  return {
    async list() {
      return [];
    },
    async listByKind() {
      return [];
    },
    async get() {
      return null;
    },
    async create() {
      return {};
    },
    async update() {
      return {};
    },
    async delete() {
      return {};
    },
  };
}

async function buildApp(routeOpts = {}) {
  const app = Fastify({ logger: false });

  const defaults = {
    communityIssueStore: createTestIssueStore(),
    taskStore: createTestTaskStore(),
    socketManager: { broadcastToThread() {}, broadcastToUser() {}, broadcast() {} },
    eventLog: createTestEventLog(),
    projector: createTestProjector(),
    objectStore: createTestObjectStore(),
  };

  await app.register(communityIssueRoutes, { ...defaults, ...routeOpts });
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// D1 — POST /api/community-issues/:id/report
// ---------------------------------------------------------------------------

describe('POST /api/community-issues/:id/report (D1)', () => {
  test('appends case.reported event for a fixed case', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const objectStore = createTestObjectStore({
      'issue:test/repo#1': {
        state: 'fixed',
        subjectKey: 'issue:test/repo#1',
        lastPublicCommentAt: null,
        closureWaiver: null,
      },
    });
    const issueStore = createTestIssueStore({
      'case-001': {
        id: 'case-001',
        repo: 'test/repo',
        issueNumber: 1,
        title: 'Test bug',
        issueType: 'bug',
      },
    });

    const app = await buildApp({ communityIssueStore: issueStore, eventLog, projector, objectStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/report',
      payload: {
        publicCommentUrl: 'https://github.com/test/repo/issues/1#issuecomment-123',
        actor: 'case-owner',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.appended, true);

    // Event log should have case.reported
    assert.equal(eventLog.events.length, 1);
    assert.equal(eventLog.events[0].kind, 'case.reported');
    assert.equal(eventLog.events[0].subjectKey, 'issue:test/repo#1');

    // Projector should be called
    assert.equal(projector.applied.length, 1);
    assert.equal(projector.applied[0].kind, 'case.reported');
  });

  test('returns 404 when case does not exist', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/nonexistent/report',
      payload: { publicCommentUrl: 'https://example.com', actor: 'test' },
    });

    assert.equal(res.statusCode, 404);
  });

  test('returns 501 when eventLog is not configured', async () => {
    const issueStore = createTestIssueStore({
      'case-001': { id: 'case-001', repo: 'test/repo', issueNumber: 1, title: 'Test', issueType: 'bug' },
    });
    const app = await buildApp({
      communityIssueStore: issueStore,
      eventLog: undefined,
      projector: undefined,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/report',
      payload: { publicCommentUrl: 'https://example.com', actor: 'test' },
    });

    assert.equal(res.statusCode, 501, 'must fail visibly when event log not configured');
  });

  test('returns 409 when case is in closed state (P1 — terminal state guard)', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const objectStore = createTestObjectStore({
      'issue:test/repo#1': {
        state: 'closed',
        subjectKey: 'issue:test/repo#1',
        lastPublicCommentAt: 1700000000000,
        closureWaiver: null,
      },
    });
    const issueStore = createTestIssueStore({
      'case-001': { id: 'case-001', repo: 'test/repo', issueNumber: 1, title: 'Test', issueType: 'bug' },
    });

    const app = await buildApp({ communityIssueStore: issueStore, eventLog, projector, objectStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/report',
      payload: { publicCommentUrl: 'https://example.com', actor: 'test' },
    });

    assert.equal(res.statusCode, 409, 'must reject report on closed case');
  });

  test('returns 409 when case is in declined state (P1 — terminal state guard)', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const objectStore = createTestObjectStore({
      'issue:test/repo#1': {
        state: 'declined',
        subjectKey: 'issue:test/repo#1',
        lastPublicCommentAt: null,
        closureWaiver: null,
      },
    });
    const issueStore = createTestIssueStore({
      'case-001': { id: 'case-001', repo: 'test/repo', issueNumber: 1, title: 'Test', issueType: 'bug' },
    });

    const app = await buildApp({ communityIssueStore: issueStore, eventLog, projector, objectStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/report',
      payload: { publicCommentUrl: 'https://example.com', actor: 'test' },
    });

    assert.equal(res.statusCode, 409, 'must reject report on declined case');
  });

  test('returns 409 via item.state fallback when objectStore is absent but item is closed', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const issueStore = createTestIssueStore({
      'case-001': {
        id: 'case-001',
        repo: 'test/repo',
        issueNumber: 1,
        title: 'Test',
        issueType: 'bug',
        state: 'closed',
      },
    });

    // objectStore absent — projection-based guard cannot fire
    const app = await buildApp({
      communityIssueStore: issueStore,
      eventLog,
      projector,
      objectStore: undefined,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/report',
      payload: { publicCommentUrl: 'https://example.com', actor: 'test' },
    });

    assert.equal(res.statusCode, 409, 'item.state fallback must reject report on closed case');
  });

  test('returns 409 via item.state fallback when objectStore is absent but item is declined', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const issueStore = createTestIssueStore({
      'case-001': {
        id: 'case-001',
        repo: 'test/repo',
        issueNumber: 1,
        title: 'Test',
        issueType: 'bug',
        state: 'declined',
      },
    });

    const app = await buildApp({
      communityIssueStore: issueStore,
      eventLog,
      projector,
      objectStore: undefined,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/report',
      payload: { publicCommentUrl: 'https://example.com', actor: 'test' },
    });

    assert.equal(res.statusCode, 409, 'item.state fallback must reject report on declined case');
  });

  test('returns 409 when case is in new state (not closeable)', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const objectStore = createTestObjectStore({
      'issue:test/repo#1': {
        state: 'new',
        subjectKey: 'issue:test/repo#1',
        lastPublicCommentAt: null,
        closureWaiver: null,
      },
    });
    const issueStore = createTestIssueStore({
      'case-001': { id: 'case-001', repo: 'test/repo', issueNumber: 1, title: 'Test', issueType: 'bug' },
    });

    const app = await buildApp({ communityIssueStore: issueStore, eventLog, projector, objectStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/report',
      payload: { publicCommentUrl: 'https://example.com', actor: 'test' },
    });

    assert.equal(res.statusCode, 409, 'must reject report on new case — not closeable');
  });

  test('returns 409 when case is in in_progress state (not closeable)', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const objectStore = createTestObjectStore({
      'issue:test/repo#1': {
        state: 'in_progress',
        subjectKey: 'issue:test/repo#1',
        lastPublicCommentAt: null,
        closureWaiver: null,
      },
    });
    const issueStore = createTestIssueStore({
      'case-001': { id: 'case-001', repo: 'test/repo', issueNumber: 1, title: 'Test', issueType: 'bug' },
    });

    const app = await buildApp({ communityIssueStore: issueStore, eventLog, projector, objectStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/report',
      payload: { publicCommentUrl: 'https://example.com', actor: 'test' },
    });

    assert.equal(res.statusCode, 409, 'must reject report on in_progress case — not closeable');
  });

  test('returns 409 via item.state fallback when objectStore has no projection for this case', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    // objectStore exists but has NO projection for this subjectKey
    const objectStore = createTestObjectStore({});
    const issueStore = createTestIssueStore({
      'case-001': {
        id: 'case-001',
        repo: 'test/repo',
        issueNumber: 1,
        title: 'Test',
        issueType: 'bug',
        state: 'closed',
      },
    });

    const app = await buildApp({ communityIssueStore: issueStore, eventLog, projector, objectStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/report',
      payload: { publicCommentUrl: 'https://example.com', actor: 'test' },
    });

    assert.equal(res.statusCode, 409, 'must use item.state fallback when projection is missing');
  });

  test('allows report on reported state (re-report is valid)', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const objectStore = createTestObjectStore({
      'issue:test/repo#1': {
        state: 'reported',
        subjectKey: 'issue:test/repo#1',
        lastPublicCommentAt: 1700000000000,
        closureWaiver: null,
      },
    });
    const issueStore = createTestIssueStore({
      'case-001': { id: 'case-001', repo: 'test/repo', issueNumber: 1, title: 'Test', issueType: 'bug' },
    });

    const app = await buildApp({ communityIssueStore: issueStore, eventLog, projector, objectStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/report',
      payload: { publicCommentUrl: 'https://example.com/updated', actor: 'test' },
    });

    assert.equal(res.statusCode, 200, 're-report on reported case should succeed');
  });
});

// ---------------------------------------------------------------------------
// D1 — POST /api/community-issues/:id/waive-closure
// ---------------------------------------------------------------------------

describe('POST /api/community-issues/:id/waive-closure (D1)', () => {
  test('appends case.waived event with reason/actor/evidence', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const objectStore = createTestObjectStore({
      'issue:test/repo#1': {
        state: 'fixed',
        subjectKey: 'issue:test/repo#1',
        lastPublicCommentAt: null,
        closureWaiver: null,
      },
    });
    const issueStore = createTestIssueStore({
      'case-001': {
        id: 'case-001',
        repo: 'test/repo',
        issueNumber: 1,
        title: 'Test bug',
        issueType: 'bug',
      },
    });

    const app = await buildApp({ communityIssueStore: issueStore, eventLog, projector, objectStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/waive-closure',
      payload: {
        reason: 'Upstream fix applied, no public comment needed',
        actor: 'case-owner',
        evidence: 'PR #42 merged upstream',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.appended, true);

    // Event log should have case.waived
    assert.equal(eventLog.events.length, 1);
    assert.equal(eventLog.events[0].kind, 'case.waived');
    assert.equal(eventLog.events[0].payload.reason, 'Upstream fix applied, no public comment needed');
    assert.equal(eventLog.events[0].payload.actor, 'case-owner');
    assert.equal(eventLog.events[0].payload.evidence, 'PR #42 merged upstream');

    // Projector should be called
    assert.equal(projector.applied.length, 1);
  });

  test('returns 400 when missing required fields', async () => {
    const issueStore = createTestIssueStore({
      'case-001': { id: 'case-001', repo: 'test/repo', issueNumber: 1, title: 'Test', issueType: 'bug' },
    });
    const app = await buildApp({ communityIssueStore: issueStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/waive-closure',
      payload: { reason: 'test' }, // missing actor and evidence
    });

    assert.equal(res.statusCode, 400, 'must reject incomplete waiver payload');
  });

  test('returns 404 when case does not exist', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/nonexistent/waive-closure',
      payload: { reason: 'test', actor: 'a', evidence: 'e' },
    });

    assert.equal(res.statusCode, 404);
  });

  test('returns 501 when eventLog is not configured', async () => {
    const issueStore = createTestIssueStore({
      'case-001': { id: 'case-001', repo: 'test/repo', issueNumber: 1, title: 'Test', issueType: 'bug' },
    });
    const app = await buildApp({
      communityIssueStore: issueStore,
      eventLog: undefined,
      projector: undefined,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/waive-closure',
      payload: { reason: 'test', actor: 'a', evidence: 'e' },
    });

    assert.equal(res.statusCode, 501, 'must fail visibly when event log not configured');
  });

  test('returns 409 when case is in closed state (P1 — terminal state guard)', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const objectStore = createTestObjectStore({
      'issue:test/repo#1': {
        state: 'closed',
        subjectKey: 'issue:test/repo#1',
        lastPublicCommentAt: 1700000000000,
        closureWaiver: null,
      },
    });
    const issueStore = createTestIssueStore({
      'case-001': { id: 'case-001', repo: 'test/repo', issueNumber: 1, title: 'Test', issueType: 'bug' },
    });

    const app = await buildApp({ communityIssueStore: issueStore, eventLog, projector, objectStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/waive-closure',
      payload: { reason: 'already closed', actor: 'test', evidence: 'n/a' },
    });

    assert.equal(res.statusCode, 409, 'must reject waiver on closed case');
  });

  test('returns 409 via item.state fallback when objectStore is absent but item is closed', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const issueStore = createTestIssueStore({
      'case-001': {
        id: 'case-001',
        repo: 'test/repo',
        issueNumber: 1,
        title: 'Test',
        issueType: 'bug',
        state: 'closed',
      },
    });

    const app = await buildApp({
      communityIssueStore: issueStore,
      eventLog,
      projector,
      objectStore: undefined,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/waive-closure',
      payload: { reason: 'test', actor: 'test', evidence: 'test' },
    });

    assert.equal(res.statusCode, 409, 'item.state fallback must reject waiver on closed case');
  });

  test('returns 409 when case is in triaged state (not closeable)', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const objectStore = createTestObjectStore({
      'issue:test/repo#1': {
        state: 'triaged',
        subjectKey: 'issue:test/repo#1',
        lastPublicCommentAt: null,
        closureWaiver: null,
      },
    });
    const issueStore = createTestIssueStore({
      'case-001': { id: 'case-001', repo: 'test/repo', issueNumber: 1, title: 'Test', issueType: 'bug' },
    });

    const app = await buildApp({ communityIssueStore: issueStore, eventLog, projector, objectStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/waive-closure',
      payload: { reason: 'skip', actor: 'test', evidence: 'n/a' },
    });

    assert.equal(res.statusCode, 409, 'must reject waiver on triaged case — not closeable');
  });

  test('returns 409 via item.state fallback when objectStore has no projection', async () => {
    const eventLog = createTestEventLog();
    const projector = createTestProjector();
    const objectStore = createTestObjectStore({}); // exists but no projection for key
    const issueStore = createTestIssueStore({
      'case-001': {
        id: 'case-001',
        repo: 'test/repo',
        issueNumber: 1,
        title: 'Test',
        issueType: 'bug',
        state: 'declined',
      },
    });

    const app = await buildApp({ communityIssueStore: issueStore, eventLog, projector, objectStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/case-001/waive-closure',
      payload: { reason: 'test', actor: 'test', evidence: 'test' },
    });

    assert.equal(res.statusCode, 409, 'must use item.state fallback when projection is missing');
  });
});
