import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * F222: FrustrationDetector tests.
 *
 * Tests cover:
 * - shouldTrigger: CLI error codes (trigger vs excluded)
 * - shouldTrigger: cancel burst threshold
 * - isDuplicate / dedup window
 * - buildFrustrationIssueCard: card structure
 * - buildFrustrationIssueInteractive: interactive block structure
 * - evaluate: full pipeline (mock messageStore)
 */

let shouldTrigger, isDuplicate, markTriggered, resetDedup;
let TRIGGERING_REASON_CODES, CANCEL_BURST_THRESHOLD;
let buildFrustrationIssueCard, buildFrustrationIssueInteractive;
let evaluate;

beforeEach(async () => {
  const detector = await import('../../dist/domains/cats/services/frustration/FrustrationDetector.js');
  shouldTrigger = detector.shouldTrigger;
  isDuplicate = detector.isDuplicate;
  markTriggered = detector.markTriggered;
  resetDedup = detector.resetDedup;
  TRIGGERING_REASON_CODES = detector.TRIGGERING_REASON_CODES;
  CANCEL_BURST_THRESHOLD = detector.CANCEL_BURST_THRESHOLD;
  evaluate = detector.evaluate;

  const cardBuilder = await import('../../dist/domains/cats/services/frustration/frustration-card-builder.js');
  buildFrustrationIssueCard = cardBuilder.buildFrustrationIssueCard;
  buildFrustrationIssueInteractive = cardBuilder.buildFrustrationIssueInteractive;

  // Reset dedup state between tests
  resetDedup();
});

afterEach(async () => {
  const detector = await import('../../dist/domains/cats/services/frustration/FrustrationDetector.js');
  detector.resetDedup();
});

// ── shouldTrigger: CLI error ───────────────────────────────────

describe('F222: shouldTrigger — CLI error', () => {
  it('triggers on auth_failed', () => {
    const result = shouldTrigger({
      type: 'cli_error',
      diagnostics: { reasonCode: 'auth_failed', publicSummary: 'Auth failed', publicHint: 'Check key' },
    });
    assert.equal(result, true);
  });

  it('triggers on quota_exceeded', () => {
    assert.equal(
      shouldTrigger({
        type: 'cli_error',
        diagnostics: { reasonCode: 'quota_exceeded', publicSummary: 'Quota', publicHint: 'Wait' },
      }),
      true,
    );
  });

  it('triggers on network_error', () => {
    assert.equal(
      shouldTrigger({
        type: 'cli_error',
        diagnostics: { reasonCode: 'network_error', publicSummary: 'Net', publicHint: 'Retry' },
      }),
      true,
    );
  });

  it('does NOT trigger on server_overloaded (transient)', () => {
    assert.equal(
      shouldTrigger({
        type: 'cli_error',
        diagnostics: { reasonCode: 'server_overloaded', publicSummary: 'Busy', publicHint: 'Wait' },
      }),
      false,
    );
  });

  it('does NOT trigger on missing_rollout (internal)', () => {
    assert.equal(
      shouldTrigger({
        type: 'cli_error',
        diagnostics: { reasonCode: 'missing_rollout', publicSummary: 'No rollout', publicHint: '-' },
      }),
      false,
    );
  });

  it('does NOT trigger when reasonCode is undefined', () => {
    assert.equal(
      shouldTrigger({
        type: 'cli_error',
        diagnostics: { publicSummary: 'Unknown', publicHint: '-' },
      }),
      false,
    );
  });
});

// ── shouldTrigger: Cancel burst ────────────────────────────────

describe('F222: shouldTrigger — cancel burst', () => {
  it('triggers when ≥3 denials in 60s', () => {
    const now = Date.now();
    assert.equal(
      shouldTrigger({
        type: 'cancel_burst',
        recentDenials: [
          { action: 'git_commit', timestamp: now - 30_000 },
          { action: 'rm_file', timestamp: now - 20_000 },
          { action: 'git_push', timestamp: now - 10_000 },
        ],
      }),
      true,
    );
  });

  it('does NOT trigger with only 2 denials', () => {
    const now = Date.now();
    assert.equal(
      shouldTrigger({
        type: 'cancel_burst',
        recentDenials: [
          { action: 'git_commit', timestamp: now - 30_000 },
          { action: 'rm_file', timestamp: now - 20_000 },
        ],
      }),
      false,
    );
  });

  it('does NOT trigger when denials are older than 60s', () => {
    const now = Date.now();
    assert.equal(
      shouldTrigger({
        type: 'cancel_burst',
        recentDenials: [
          { action: 'a', timestamp: now - 90_000 },
          { action: 'b', timestamp: now - 80_000 },
          { action: 'c', timestamp: now - 70_000 },
        ],
      }),
      false,
    );
  });
});

// ── Dedup ──────────────────────────────────────────────────────

describe('F222: isDuplicate / dedup', () => {
  it('returns false on first trigger for a thread+signal', () => {
    assert.equal(isDuplicate('thread_1', 'cli_error'), false);
  });

  it('returns true after markTriggered within window', () => {
    markTriggered('thread_1', 'cli_error');
    assert.equal(isDuplicate('thread_1', 'cli_error'), true);
  });

  it('different signal types are independent', () => {
    markTriggered('thread_1', 'cli_error');
    assert.equal(isDuplicate('thread_1', 'cancel_burst'), false);
  });

  it('different threads are independent', () => {
    markTriggered('thread_1', 'cli_error');
    assert.equal(isDuplicate('thread_2', 'cli_error'), false);
  });

  it('resetDedup clears all state', () => {
    markTriggered('thread_1', 'cli_error');
    resetDedup();
    assert.equal(isDuplicate('thread_1', 'cli_error'), false);
  });
});

// ── Card builder ───────────────────────────────────────────────

describe('F222: buildFrustrationIssueCard', () => {
  const mockIssue = {
    issueId: 'fi_test123',
    status: 'draft',
    threadId: 'thread_t1',
    userId: 'user_u1',
    catId: 'cat-test',
    signalType: 'cli_error',
    signalDetail: { reasonCode: 'auth_failed', publicSummary: 'Auth failed', publicHint: 'Check your API key' },
    context: {
      recentMessages: [{ role: 'user', content: 'help me with auth', timestamp: 1000 }],
      errorLogs: 'Error: 401 Unauthorized',
    },
    createdAt: Date.now(),
  };

  it('produces a card block with kind=card and correct meta.kind', () => {
    const card = buildFrustrationIssueCard(mockIssue);
    assert.equal(card.kind, 'card');
    assert.equal(card.v, 1);
    assert.equal(card.meta.kind, 'frustration_auto_issue');
    assert.equal(card.meta.issueId, 'fi_test123');
  });

  it('has warning tone', () => {
    const card = buildFrustrationIssueCard(mockIssue);
    assert.equal(card.tone, 'warning');
  });

  it('includes signal-specific fields', () => {
    const card = buildFrustrationIssueCard(mockIssue);
    const fieldLabels = card.fields.map((f) => f.label);
    assert.ok(fieldLabels.includes('触发类型'));
    assert.ok(fieldLabels.includes('错误类型'));
  });

  it('includes error logs in body', () => {
    const card = buildFrustrationIssueCard(mockIssue);
    assert.ok(card.bodyMarkdown.includes('401 Unauthorized'));
  });
});

describe('F222: buildFrustrationIssueInteractive', () => {
  const mockIssue = {
    issueId: 'fi_test456',
    status: 'draft',
    threadId: 'thread_t1',
    userId: 'user_u1',
    catId: 'cat-test',
    signalType: 'cancel_burst',
    signalDetail: { cancelCount: 3, windowMs: 60000 },
    context: { recentMessages: [] },
    createdAt: Date.now(),
  };

  it('produces interactive block with confirm type', () => {
    const block = buildFrustrationIssueInteractive(mockIssue);
    assert.equal(block.kind, 'interactive');
    assert.equal(block.interactiveType, 'confirm');
  });

  it('has confirm and skip options', () => {
    const block = buildFrustrationIssueInteractive(mockIssue);
    assert.equal(block.options.length, 2);
    assert.equal(block.options[0].id, 'confirm');
    assert.equal(block.options[1].id, 'skip');
  });

  it('confirm option has customInput for user description', () => {
    const block = buildFrustrationIssueInteractive(mockIssue);
    assert.equal(block.options[0].customInput, true);
    assert.ok(block.options[0].customInputPlaceholder);
  });

  it('options have callback actions with correct endpoints', () => {
    const block = buildFrustrationIssueInteractive(mockIssue);
    assert.equal(block.options[0].action.type, 'callback');
    assert.ok(block.options[0].action.endpoint.includes('fi_test456'));
    assert.ok(block.options[0].action.endpoint.includes('confirm'));
    assert.equal(block.options[1].action.type, 'callback');
    assert.ok(block.options[1].action.endpoint.includes('skip'));
  });
});

// ── evaluate: full pipeline ────────────────────────────────────

describe('F222: evaluate — full pipeline', () => {
  /** Minimal mock messageStore with getByThread */
  function createMockMessageStore(messages = []) {
    return {
      getByThread: () => messages,
      append: (msg) => ({ id: 'msg_mock', ...msg }),
    };
  }

  it('creates draft issue on CLI error trigger', async () => {
    const { InMemoryFrustrationIssueStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js'
    );
    const store = new InMemoryFrustrationIssueStore();
    const mockMsgStore = createMockMessageStore();

    const result = await evaluate(
      {
        signal: {
          type: 'cli_error',
          diagnostics: { reasonCode: 'auth_failed', publicSummary: 'Auth failed', publicHint: 'Check key' },
        },
        threadId: 'thread_eval1',
        userId: 'user_eval',
        catId: 'cat-opus',
        invocationId: 'inv_123',
      },
      { frustrationIssueStore: store, messageStore: mockMsgStore },
    );

    assert.ok(result, 'should return created issue');
    assert.equal(result.status, 'draft');
    assert.equal(result.signalType, 'cli_error');
    assert.equal(result.threadId, 'thread_eval1');

    // Verify it's in the store
    const fromStore = await store.getById(result.issueId);
    assert.ok(fromStore);
    assert.equal(fromStore.status, 'draft');
  });

  it('returns null on excluded error (server_overloaded)', async () => {
    const { InMemoryFrustrationIssueStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js'
    );
    const store = new InMemoryFrustrationIssueStore();

    const result = await evaluate(
      {
        signal: {
          type: 'cli_error',
          diagnostics: { reasonCode: 'server_overloaded', publicSummary: 'Busy', publicHint: 'Wait' },
        },
        threadId: 'thread_eval2',
        userId: 'user_eval',
        catId: 'cat-opus',
      },
      { frustrationIssueStore: store, messageStore: createMockMessageStore() },
    );

    assert.equal(result, null);
  });

  it('deduplicates same thread+signal within window', async () => {
    const { InMemoryFrustrationIssueStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js'
    );
    const store = new InMemoryFrustrationIssueStore();
    const signal = {
      type: 'cli_error',
      diagnostics: { reasonCode: 'auth_failed', publicSummary: 'Auth', publicHint: 'Key' },
    };

    const first = await evaluate(
      { signal, threadId: 'thread_dedup', userId: 'u', catId: 'c' },
      { frustrationIssueStore: store, messageStore: createMockMessageStore() },
    );
    assert.ok(first);

    const second = await evaluate(
      { signal, threadId: 'thread_dedup', userId: 'u', catId: 'c' },
      { frustrationIssueStore: store, messageStore: createMockMessageStore() },
    );
    assert.equal(second, null, 'second trigger should be deduped');
  });
});
