// @ts-check
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const { ReviewFeedbackRouter, buildReviewFeedbackContent } = await import(
  '../dist/infrastructure/email/ReviewFeedbackRouter.js'
);

// ─── Mocks ─────────────────────────────────────────────────────────

function mockMessageStore() {
  const messages = [];
  let counter = 0;
  return {
    store: /** @type {any} */ ({
      append(msg) {
        counter++;
        messages.push({ ...msg });
        return { id: `msg-${counter}`, ...msg, timestamp: msg.timestamp ?? Date.now() };
      },
    }),
    messages,
  };
}

function mockSocketManager() {
  const events = [];
  return {
    manager: {
      broadcastToRoom(room, event, payload) {
        events.push({ room, event, payload });
      },
    },
    events,
  };
}

function noopLog() {
  const noop = () => {};
  return /** @type {any} */ ({
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  });
}

const tracking = { threadId: 'th-1', catId: 'opus', userId: 'u-1' };

// ─── Tests ─────────────────────────────────────────────────────────

describe('ReviewFeedbackRouter', () => {
  let messageMock;
  let socketMock;

  function createRouter() {
    return new ReviewFeedbackRouter({
      deliveryDeps: { messageStore: messageMock.store, socketManager: socketMock.manager },
      log: noopLog(),
    });
  }

  beforeEach(() => {
    messageMock = mockMessageStore();
    socketMock = mockSocketManager();
  });

  it('delivers review feedback with correct connector (AC-A3/A4)', async () => {
    const router = createRouter();
    const result = await router.route(
      {
        repoFullName: 'owner/repo',
        prNumber: 42,
        newComments: [{ id: 1, author: 'alice', body: 'LGTM', createdAt: '2026-01-01', commentType: 'conversation' }],
        newDecisions: [{ id: 1, author: 'alice', state: 'APPROVED', body: '', submittedAt: '2026-01-01' }],
      },
      tracking,
    );

    assert.equal(result.kind, 'notified');
    assert.equal(result.threadId, 'th-1');
    assert.equal(messageMock.messages.length, 1);
    assert.equal(messageMock.messages[0].source.connector, 'github-review-feedback');
  });

  it('skips when no new feedback', async () => {
    const router = createRouter();
    const result = await router.route(
      {
        repoFullName: 'owner/repo',
        prNumber: 42,
        newComments: [],
        newDecisions: [],
      },
      tracking,
    );

    assert.equal(result.kind, 'skipped');
    assert.equal(messageMock.messages.length, 0);
  });

  it('broadcasts socket event', async () => {
    const router = createRouter();
    await router.route(
      {
        repoFullName: 'owner/repo',
        prNumber: 42,
        newComments: [
          {
            id: 1,
            author: 'bob',
            body: 'fix this',
            createdAt: '2026-01-01',
            commentType: 'inline',
            filePath: 'src/a.ts',
            line: 10,
          },
        ],
        newDecisions: [],
      },
      tracking,
    );

    assert.equal(socketMock.events.length, 1);
    assert.equal(socketMock.events[0].room, 'thread:th-1');
    assert.equal(socketMock.events[0].event, 'connector_message');
  });
});

describe('buildReviewFeedbackContent', () => {
  it('renders three-section format (OQ-2)', () => {
    const content = buildReviewFeedbackContent({
      repoFullName: 'owner/repo',
      prNumber: 42,
      newDecisions: [
        { id: 1, author: 'alice', state: 'APPROVED', body: 'Ship it', submittedAt: '2026-01-01' },
        { id: 2, author: 'bob', state: 'CHANGES_REQUESTED', body: 'Needs work', submittedAt: '2026-01-01' },
      ],
      newComments: [
        {
          id: 10,
          author: 'bob',
          body: 'typo here',
          createdAt: '2026-01-01',
          commentType: 'inline',
          filePath: 'src/a.ts',
          line: 5,
        },
        { id: 11, author: 'charlie', body: 'great PR', createdAt: '2026-01-01', commentType: 'conversation' },
      ],
    });

    // Section headers
    assert.ok(content.includes('Review Decisions'));
    assert.ok(content.includes('Inline Comments (1)'));
    assert.ok(content.includes('PR Conversation (1)'));

    // Decision content
    assert.ok(content.includes('alice'));
    assert.ok(content.includes('APPROVED'));
    assert.ok(content.includes('CHANGES_REQUESTED'));

    // Inline comment
    assert.ok(content.includes('src/a.ts:5'));
    assert.ok(content.includes('typo here'));

    // Conversation comment
    assert.ok(content.includes('charlie'));
    assert.ok(content.includes('great PR'));
  });

  it('renders decisions-only message', () => {
    const content = buildReviewFeedbackContent({
      repoFullName: 'owner/repo',
      prNumber: 42,
      newDecisions: [{ id: 1, author: 'alice', state: 'DISMISSED', body: '', submittedAt: '2026-01-01' }],
      newComments: [],
    });

    assert.ok(content.includes('Review Decisions'));
    assert.ok(content.includes('DISMISSED'));
    assert.ok(!content.includes('Inline Comments'));
    assert.ok(!content.includes('PR Conversation'));
  });

  it('renders comments-only message', () => {
    const content = buildReviewFeedbackContent({
      repoFullName: 'owner/repo',
      prNumber: 42,
      newDecisions: [],
      newComments: [{ id: 1, author: 'bob', body: 'check this', createdAt: '2026-01-01', commentType: 'conversation' }],
    });

    assert.ok(!content.includes('Review Decisions'));
    assert.ok(content.includes('PR Conversation'));
  });

  it('truncates long comment bodies to 120 chars', () => {
    const longBody = 'x'.repeat(200);
    const content = buildReviewFeedbackContent({
      repoFullName: 'owner/repo',
      prNumber: 42,
      newDecisions: [],
      newComments: [{ id: 1, author: 'bob', body: longBody, createdAt: '2026-01-01', commentType: 'conversation' }],
    });

    assert.ok(!content.includes(longBody), 'full body should be truncated');
    assert.ok(content.includes('x'.repeat(120)), 'first 120 chars should be present');
  });

  it('includes action hint for CHANGES_REQUESTED (AC-B3)', () => {
    const content = buildReviewFeedbackContent({
      repoFullName: 'owner/repo',
      prNumber: 42,
      newDecisions: [{ id: 1, author: 'alice', state: 'CHANGES_REQUESTED', body: 'fix it', submittedAt: '2026-03-26' }],
      newComments: [],
    });
    assert.ok(content.includes('自动处理'), 'should include action hint section');
    assert.ok(content.includes('receive-review'), 'CHANGES_REQUESTED should reference receive-review mode');
    assert.ok(content.includes('owner/repo#42'), 'should include PR reference');
  });

  it('includes action hint for APPROVED (AC-B3)', () => {
    const content = buildReviewFeedbackContent({
      repoFullName: 'owner/repo',
      prNumber: 42,
      newDecisions: [{ id: 1, author: 'alice', state: 'APPROVED', body: 'lgtm', submittedAt: '2026-03-26' }],
      newComments: [],
    });
    assert.ok(content.includes('自动处理'), 'should include action hint section');
    assert.ok(content.includes('merge'), 'APPROVED should mention merge readiness');
  });
});
