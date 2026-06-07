import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * F222 Phase B: Text frustration keyword detection tests.
 *
 * Tests cover:
 * - detectTextFrustration: keyword matching + context window threshold
 * - shouldTrigger: text_frustration signal integration
 * - False positive prevention (AC-B3)
 */

let detectTextFrustration, FRUSTRATION_KEYWORDS, TEXT_FRUSTRATION_THRESHOLD;
let shouldTrigger, resetDedup;

beforeEach(async () => {
  const keywords = await import('../../dist/domains/cats/services/frustration/text-frustration-keywords.js');
  detectTextFrustration = keywords.detectTextFrustration;
  FRUSTRATION_KEYWORDS = keywords.FRUSTRATION_KEYWORDS;
  TEXT_FRUSTRATION_THRESHOLD = keywords.TEXT_FRUSTRATION_THRESHOLD;

  const detector = await import('../../dist/domains/cats/services/frustration/FrustrationDetector.js');
  shouldTrigger = detector.shouldTrigger;
  resetDedup = detector.resetDedup;
  resetDedup();
});

// ── detectTextFrustration ──────────────────────────────────

describe('F222 Phase B: detectTextFrustration', () => {
  it('detects ≥2 messages with frustration keywords → matched=true', () => {
    const result = detectTextFrustration(['这个不对啊', '又错了', '帮我看看']);
    assert.equal(result.matched, true);
    assert.ok(result.matchCount >= 2);
    assert.ok(result.matchedKeywords.length > 0);
  });

  it('single matching message → matched=false (AC-B3: below threshold)', () => {
    const result = detectTextFrustration(['这个不对', '今天天气不错', '帮我写代码']);
    assert.equal(result.matched, false);
    assert.equal(result.matchCount, 1);
  });

  it('no matching messages → matched=false', () => {
    const result = detectTextFrustration(['你好', '帮我看看代码', '谢谢']);
    assert.equal(result.matched, false);
    assert.equal(result.matchCount, 0);
  });

  it('detects various frustration keywords', () => {
    // Each keyword should be recognized
    const keywords = ['不对', '错了', '怎么回事', '又来了', '什么情况', '搞什么', '没用', '还是不行'];
    for (const kw of keywords) {
      const result = detectTextFrustration([`${kw}啊`, `${kw}吧`]);
      assert.equal(result.matched, true, `keyword "${kw}" should trigger when repeated`);
      assert.ok(result.matchedKeywords.includes(kw), `"${kw}" should appear in matchedKeywords`);
    }
  });

  it('empty messages array → matched=false', () => {
    const result = detectTextFrustration([]);
    assert.equal(result.matched, false);
    assert.equal(result.matchCount, 0);
  });

  it('only scans within window (default 5 messages)', () => {
    // 6 messages, frustration only in first 2 (outside default 5-message window)
    const msgs = [
      '不对啊', // index 0 — outside window if window=5 scans last 5
      '错了', // index 1 — outside window
      '好的', // index 2
      '明白了', // index 3
      '继续吧', // index 4
      '没问题', // index 5
      '谢谢', // index 6
    ];
    const result = detectTextFrustration(msgs);
    assert.equal(result.matched, false, 'old frustration messages outside window should not trigger');
  });

  it('returns matched keyword names', () => {
    const result = detectTextFrustration(['怎么回事啊', '又来了吧']);
    assert.ok(result.matchedKeywords.includes('怎么回事'));
    assert.ok(result.matchedKeywords.includes('又来了'));
  });
});

// ── shouldTrigger: text_frustration ────────────────────────

describe('F222 Phase B: shouldTrigger — text_frustration', () => {
  it('triggers when matchCount >= threshold', () => {
    assert.equal(
      shouldTrigger({
        type: 'text_frustration',
        matchedKeywords: ['不对', '错了'],
        matchCount: 2,
        recentUserMessages: ['不对啊', '错了错了'],
      }),
      true,
    );
  });

  it('does NOT trigger when matchCount < threshold', () => {
    assert.equal(
      shouldTrigger({
        type: 'text_frustration',
        matchedKeywords: ['不对'],
        matchCount: 1,
        recentUserMessages: ['不对啊'],
      }),
      false,
    );
  });

  it('does NOT trigger with matchCount 0', () => {
    assert.equal(
      shouldTrigger({
        type: 'text_frustration',
        matchedKeywords: [],
        matchCount: 0,
        recentUserMessages: [],
      }),
      false,
    );
  });
});

// ── Card builder: text_frustration ─────────────────────────

describe('F222 Phase B: buildFrustrationIssueCard — text_frustration', () => {
  let buildFrustrationIssueCard;

  beforeEach(async () => {
    const cardBuilder = await import('../../dist/domains/cats/services/frustration/frustration-card-builder.js');
    buildFrustrationIssueCard = cardBuilder.buildFrustrationIssueCard;
  });

  it('shows "用户反馈异常" as trigger type (not "操作频繁中断")', () => {
    const card = buildFrustrationIssueCard({
      issueId: 'fi_text_test',
      status: 'draft',
      threadId: 't1',
      userId: 'u1',
      catId: 'cat-test',
      signalType: 'text_frustration',
      signalDetail: { matchedKeywords: ['不对', '错了'], matchCount: 2 },
      context: { recentMessages: [] },
      createdAt: Date.now(),
    });
    const triggerField = card.fields.find((f) => f.label === '触发类型');
    assert.equal(triggerField.value, '用户反馈异常');
    assert.ok(card.fields.some((f) => f.label === '检测关键词'));
    assert.ok(card.bodyMarkdown.includes('负面反馈'));
  });
});
