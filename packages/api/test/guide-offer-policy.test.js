import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('GuideOfferPolicy', async () => {
  const { evaluateGuideOffer, normalizeMatchConfidence, DEFAULT_MAX_DISMISSALS } = await import(
    '../dist/domains/guides/GuideOfferPolicy.js'
  );

  // ── confidence normalization ──

  test('normalizeMatchConfidence: score 0 → 0', () => {
    assert.equal(normalizeMatchConfidence(0, 5), 0);
  });

  test('normalizeMatchConfidence: all keywords matched → 1.0', () => {
    assert.equal(normalizeMatchConfidence(3, 3), 1);
  });

  test('normalizeMatchConfidence: partial match → ratio', () => {
    assert.ok(Math.abs(normalizeMatchConfidence(2, 5) - 0.4) < 0.001);
  });

  test('normalizeMatchConfidence: handles zero total gracefully', () => {
    assert.equal(normalizeMatchConfidence(0, 0), 0);
  });

  // ── keyword mode (default) ──

  test('keyword mode: returns match when score > 0 and no threshold', () => {
    const result = evaluateGuideOffer({
      candidates: [{ id: 'add-member', name: '添加成员', score: 2, totalKeywords: 9 }],
      triggerStrategies: {},
      userId: 'user1',
      isExplicitTrigger: false,
      dismissCounts: {},
    });
    assert.ok(result);
    assert.equal(result.id, 'add-member');
  });

  test('keyword mode: returns null when no candidates', () => {
    const result = evaluateGuideOffer({
      candidates: [],
      triggerStrategies: {},
      userId: 'user1',
      isExplicitTrigger: false,
      dismissCounts: {},
    });
    assert.equal(result, null);
  });

  // ── explicit mode ──

  test('explicit mode: blocks keyword-only trigger', () => {
    const result = evaluateGuideOffer({
      candidates: [{ id: 'sensitive-guide', name: 'Sensitive', score: 3, totalKeywords: 3 }],
      triggerStrategies: { 'sensitive-guide': { mode: 'explicit' } },
      userId: 'user1',
      isExplicitTrigger: false,
      dismissCounts: {},
    });
    assert.equal(result, null);
  });

  test('explicit mode: allows explicit trigger', () => {
    const result = evaluateGuideOffer({
      candidates: [{ id: 'sensitive-guide', name: 'Sensitive', score: 3, totalKeywords: 3 }],
      triggerStrategies: { 'sensitive-guide': { mode: 'explicit' } },
      userId: 'user1',
      isExplicitTrigger: true,
      dismissCounts: {},
    });
    assert.ok(result);
    assert.equal(result.id, 'sensitive-guide');
  });

  // ── hybrid mode ──

  test('hybrid mode: blocks keyword match below confidence', () => {
    const result = evaluateGuideOffer({
      candidates: [{ id: 'cautious', name: 'Cautious Guide', score: 1, totalKeywords: 10 }],
      triggerStrategies: { cautious: { mode: 'hybrid', confidence: 0.5 } },
      userId: 'user1',
      isExplicitTrigger: false,
      dismissCounts: {},
    });
    assert.equal(result, null);
  });

  test('hybrid mode: allows keyword match at/above confidence', () => {
    const result = evaluateGuideOffer({
      candidates: [{ id: 'cautious', name: 'Cautious Guide', score: 6, totalKeywords: 10 }],
      triggerStrategies: { cautious: { mode: 'hybrid', confidence: 0.5 } },
      userId: 'user1',
      isExplicitTrigger: false,
      dismissCounts: {},
    });
    assert.ok(result);
    assert.equal(result.id, 'cautious');
  });

  test('hybrid mode: explicit trigger bypasses confidence threshold', () => {
    const result = evaluateGuideOffer({
      candidates: [{ id: 'cautious', name: 'Cautious Guide', score: 1, totalKeywords: 10 }],
      triggerStrategies: { cautious: { mode: 'hybrid', confidence: 0.5 } },
      userId: 'user1',
      isExplicitTrigger: true,
      dismissCounts: {},
    });
    assert.ok(result);
  });

  // ── dismiss-rate suppression ──

  test('suppresses offer after max dismissals (default)', () => {
    const result = evaluateGuideOffer({
      candidates: [{ id: 'add-member', name: '添加成员', score: 3, totalKeywords: 9 }],
      triggerStrategies: {},
      userId: 'user1',
      isExplicitTrigger: false,
      dismissCounts: { 'add-member': DEFAULT_MAX_DISMISSALS },
    });
    assert.equal(result, null);
  });

  test('allows offer below max dismissals', () => {
    const result = evaluateGuideOffer({
      candidates: [{ id: 'add-member', name: '添加成员', score: 3, totalKeywords: 9 }],
      triggerStrategies: {},
      userId: 'user1',
      isExplicitTrigger: false,
      dismissCounts: { 'add-member': DEFAULT_MAX_DISMISSALS - 1 },
    });
    assert.ok(result);
  });

  test('custom max_dismissals overrides default', () => {
    const result = evaluateGuideOffer({
      candidates: [{ id: 'strict', name: 'Strict', score: 3, totalKeywords: 3 }],
      triggerStrategies: { strict: { mode: 'keyword', max_dismissals: 1 } },
      userId: 'user1',
      isExplicitTrigger: false,
      dismissCounts: { strict: 1 },
    });
    assert.equal(result, null);
  });

  test('explicit trigger bypasses dismiss suppression', () => {
    const result = evaluateGuideOffer({
      candidates: [{ id: 'add-member', name: '添加成員', score: 3, totalKeywords: 9 }],
      triggerStrategies: {},
      userId: 'user1',
      isExplicitTrigger: true,
      dismissCounts: { 'add-member': 999 },
    });
    assert.ok(result);
  });

  // ── ranking ──

  test('picks highest confidence candidate among passing filters', () => {
    const result = evaluateGuideOffer({
      candidates: [
        { id: 'low', name: 'Low', score: 1, totalKeywords: 10 },
        { id: 'high', name: 'High', score: 5, totalKeywords: 5 },
      ],
      triggerStrategies: {},
      userId: 'user1',
      isExplicitTrigger: false,
      dismissCounts: {},
    });
    assert.ok(result);
    assert.equal(result.id, 'high');
  });

  test('skips dismissed candidate and falls through to next', () => {
    const result = evaluateGuideOffer({
      candidates: [
        { id: 'dismissed', name: 'Dismissed', score: 5, totalKeywords: 5 },
        { id: 'available', name: 'Available', score: 3, totalKeywords: 5 },
      ],
      triggerStrategies: {},
      userId: 'user1',
      isExplicitTrigger: false,
      dismissCounts: { dismissed: DEFAULT_MAX_DISMISSALS },
    });
    assert.ok(result);
    assert.equal(result.id, 'available');
  });
});

describe('Explicit trigger detection', async () => {
  const { isExplicitGuideRequest, stripExplicitPrefix } = await import(
    '../dist/domains/guides/GuideRoutingInterceptor.js'
  );

  test('/guide prefix triggers explicit mode', () => {
    assert.equal(isExplicitGuideRequest('/guide add-member'), true);
  });

  test('/guide alone triggers explicit mode', () => {
    assert.equal(isExplicitGuideRequest('/guide'), true);
  });

  test('case insensitive', () => {
    assert.equal(isExplicitGuideRequest('/Guide 添加成员'), true);
  });

  test('引导 prefix triggers explicit mode', () => {
    assert.equal(isExplicitGuideRequest('引导 添加成员'), true);
  });

  test('引导 alone triggers explicit mode', () => {
    assert.equal(isExplicitGuideRequest('引导'), true);
  });

  test('normal message does not trigger', () => {
    assert.equal(isExplicitGuideRequest('添加成员'), false);
  });

  test('mid-sentence /guide does not trigger', () => {
    assert.equal(isExplicitGuideRequest('请用 /guide 命令'), false);
  });

  test('stripExplicitPrefix extracts intent', () => {
    assert.equal(stripExplicitPrefix('/guide add-member'), 'add-member');
  });

  test('stripExplicitPrefix handles bare /guide', () => {
    assert.equal(stripExplicitPrefix('/guide'), '');
  });

  test('stripExplicitPrefix handles Chinese intent from /guide', () => {
    assert.equal(stripExplicitPrefix('/guide 添加成员'), '添加成员');
  });

  test('stripExplicitPrefix handles Chinese prefix 引导', () => {
    assert.equal(stripExplicitPrefix('引导 添加成员'), '添加成员');
  });
});

describe('Explicit trigger end-to-end: /guide resolves by ID', async () => {
  const { prepareGuideContext } = await import('../dist/domains/guides/GuideRoutingInterceptor.js');

  test('/guide add-member resolves via direct ID lookup (not keyword match)', async () => {
    const ctx = await prepareGuideContext({
      thread: null,
      targetCats: ['opus'],
      message: '/guide add-member',
      userId: 'test-user',
      threadId: 'test-thread',
    });
    assert.ok(ctx.candidate, 'should resolve candidate from /guide add-member');
    assert.equal(ctx.candidate.id, 'add-member');
    assert.equal(ctx.candidate.isNewOffer, true);
  });

  test('/guide 添加成员 resolves via keyword match', async () => {
    const ctx = await prepareGuideContext({
      thread: null,
      targetCats: ['opus'],
      message: '/guide 添加成员',
      userId: 'test-user',
      threadId: 'test-thread',
    });
    assert.ok(ctx.candidate, 'should resolve candidate from /guide 添加成员');
    assert.equal(ctx.candidate.id, 'add-member');
  });

  test('bare /guide does not crash or match', async () => {
    const ctx = await prepareGuideContext({
      thread: null,
      targetCats: ['opus'],
      message: '/guide',
      userId: 'test-user',
      threadId: 'test-thread',
    });
    assert.equal(ctx.candidate, undefined);
  });
});
