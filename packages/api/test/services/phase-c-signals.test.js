import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * F222 Phase C: A2A timeout, historical card serialization and issue list tests.
 */

let shouldTrigger, resetDedup;
let buildFrustrationIssueCard;

beforeEach(async () => {
  const detector = await import('../../dist/domains/cats/services/frustration/FrustrationDetector.js');
  shouldTrigger = detector.shouldTrigger;
  resetDedup = detector.resetDedup;
  resetDedup();

  const cardBuilder = await import('../../dist/domains/cats/services/frustration/frustration-card-builder.js');
  buildFrustrationIssueCard = cardBuilder.buildFrustrationIssueCard;
});

// ── shouldTrigger: a2a_timeout ─────────────────────────────

describe('F222 Phase C: shouldTrigger — a2a_timeout', () => {
  it('triggers when elapsed >= 60s threshold', () => {
    assert.equal(shouldTrigger({ type: 'a2a_timeout', targetCatId: 'opus', elapsedMs: 60000 }), true);
  });

  it('does NOT trigger for instant crash (elapsed < 60s)', () => {
    assert.equal(shouldTrigger({ type: 'a2a_timeout', targetCatId: 'opus', elapsedMs: 5000 }), false);
  });

  it('triggers for long timeout (> 60s)', () => {
    assert.equal(shouldTrigger({ type: 'a2a_timeout', targetCatId: 'opus', elapsedMs: 120000 }), true);
  });
});

// ── Card builder: new signal types ─────────────────────────

describe('F222 Phase C: card builder — a2a_timeout', () => {
  it('shows "猫猫响应超时" trigger label', () => {
    const card = buildFrustrationIssueCard({
      issueId: 'fi_timeout',
      status: 'draft',
      threadId: 't1',
      userId: 'u1',
      catId: 'opus',
      signalType: 'a2a_timeout',
      signalDetail: { targetCatId: 'opus', elapsedMs: 65000 },
      context: { recentMessages: [] },
      createdAt: Date.now(),
    });
    const triggerField = card.fields.find((f) => f.label === '触发类型');
    assert.equal(triggerField.value, '猫猫响应超时');
    assert.ok(card.bodyMarkdown.includes('没有及时响应'));
  });
});

describe('F222 Phase C: card builder — retry_burst', () => {
  it('shows "重复操作" trigger label', () => {
    const card = buildFrustrationIssueCard({
      issueId: 'fi_retry',
      status: 'draft',
      threadId: 't1',
      userId: 'u1',
      catId: 'opus',
      signalType: 'retry_burst',
      signalDetail: { matchCount: 3, repeatedPrefix: '帮我看看' },
      context: { recentMessages: [] },
      createdAt: Date.now(),
    });
    const triggerField = card.fields.find((f) => f.label === '触发类型');
    assert.equal(triggerField.value, '重复操作');
    assert.ok(card.bodyMarkdown.includes('重复发送'));
  });
});

// ── Issue list API (AC-C3) ─────────────────────────────────

describe('F222 Phase C: GET /api/frustration-issues', () => {
  let app, store;

  beforeEach(async () => {
    const Fastify = (await import('fastify')).default;
    const { InMemoryFrustrationIssueStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js'
    );
    const { frustrationIssueRoutes } = await import('../../dist/routes/frustration-issue-routes.js');

    store = new InMemoryFrustrationIssueStore();
    app = Fastify();
    await app.register(frustrationIssueRoutes, { frustrationIssueStore: store });
    await app.ready();
  });

  it('returns all issues for user', async () => {
    await store.create({
      threadId: 't1',
      userId: 'user_list',
      catId: 'cat',
      signalType: 'cli_error',
      signalDetail: {},
      context: { recentMessages: [] },
    });
    const i2 = await store.create({
      threadId: 't1',
      userId: 'user_list',
      catId: 'cat',
      signalType: 'text_frustration',
      signalDetail: {},
      context: { recentMessages: [] },
    });
    await store.confirm({ issueId: i2.issueId });

    const res = await app.inject({
      method: 'GET',
      url: '/api/frustration-issues',
      headers: { 'x-cat-cafe-user': 'user_list' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.issues.length, 2);
  });

  it('filters by status=confirmed', async () => {
    const i1 = await store.create({
      threadId: 't1',
      userId: 'user_filter',
      catId: 'cat',
      signalType: 'cli_error',
      signalDetail: {},
      context: { recentMessages: [] },
    });
    await store.create({
      threadId: 't1',
      userId: 'user_filter',
      catId: 'cat',
      signalType: 'cli_error',
      signalDetail: {},
      context: { recentMessages: [] },
    });
    await store.confirm({ issueId: i1.issueId });

    const res = await app.inject({
      method: 'GET',
      url: '/api/frustration-issues?status=confirmed',
      headers: { 'x-cat-cafe-user': 'user_filter' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.issues.length, 1);
    assert.equal(body.issues[0].status, 'confirmed');
  });

  it('includes skipped issues in default listing (P1 fix)', async () => {
    const i1 = await store.create({
      threadId: 't1',
      userId: 'user_skip',
      catId: 'cat',
      signalType: 'cli_error',
      signalDetail: {},
      context: { recentMessages: [] },
    });
    await store.create({
      threadId: 't1',
      userId: 'user_skip',
      catId: 'cat',
      signalType: 'cli_error',
      signalDetail: {},
      context: { recentMessages: [] },
    });
    await store.skip(i1.issueId);

    const res = await app.inject({
      method: 'GET',
      url: '/api/frustration-issues',
      headers: { 'x-cat-cafe-user': 'user_skip' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // Should include both draft + skipped
    assert.equal(body.issues.length, 2);
    assert.ok(body.issues.some((i) => i.status === 'skipped'));
  });

  it('supports combined threadId + status filter (P2 fix)', async () => {
    const i1 = await store.create({
      threadId: 'thread_a',
      userId: 'user_combo',
      catId: 'cat',
      signalType: 'cli_error',
      signalDetail: {},
      context: { recentMessages: [] },
    });
    await store.create({
      threadId: 'thread_b',
      userId: 'user_combo',
      catId: 'cat',
      signalType: 'cli_error',
      signalDetail: {},
      context: { recentMessages: [] },
    });
    await store.confirm({ issueId: i1.issueId });

    const res = await app.inject({
      method: 'GET',
      url: '/api/frustration-issues?threadId=thread_a&status=confirmed',
      headers: { 'x-cat-cafe-user': 'user_combo' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.issues.length, 1);
    assert.equal(body.issues[0].threadId, 'thread_a');
    assert.equal(body.issues[0].status, 'confirmed');
  });
});
