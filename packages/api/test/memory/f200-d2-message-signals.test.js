import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

/**
 * F200 AC-D2.1 — Message-based signal detection tests.
 *
 * Covers operator acceptance + reviewer approval via thread message scanning:
 * keyword matching, negation guards, merge-pattern precision,
 * latest-decision-wins ordering, and connector source filtering.
 */

describe('F200 AC-D2.1 — operator acceptance signal', () => {
  let ThreadAwareSignalSources;

  before(async () => {
    const mod = await import(`../../dist/domains/memory/ThreadAwareSignalSources.js?v=${Date.now()}`);
    ThreadAwareSignalSources = mod.ThreadAwareSignalSources;
  });

  /** Empty task store — message-signal tests don't use task data. */
  const EMPTY_TASK_STORE = {
    async listByThread() {
      return [];
    },
  };

  it('detects operator accept from thread messages with Chinese keywords', async () => {
    const messageStore = mockMessageStore([{ id: 'm1', userId: 'user-landy', catId: null, text: '好的，可以合入' }]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isCvoAcceptedForThread('thread-001');
    assert.equal(result, true);
  });

  it('detects operator accept with "通过" keyword', async () => {
    const messageStore = mockMessageStore([{ id: 'm1', userId: 'user-landy', catId: null, text: '看了，通过' }]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isCvoAcceptedForThread('thread-001');
    assert.equal(result, true);
  });

  it('ignores operator accept from cat messages (only human user counts)', async () => {
    const messageStore = mockMessageStore([{ id: 'm1', userId: null, catId: 'opus-46', text: '可以合入了' }]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isCvoAcceptedForThread('thread-001');
    assert.equal(result, false);
  });

  // --- Negation guard ---

  it('rejects operator negation phrases (Chinese + English + word-boundary)', async () => {
    for (const text of [
      '看了，不通过，需要改',
      '不可以合入，有问题',
      'do not merge yet',
      '没通过',
      'this is still unapproved',
      'status: not-approved',
      'not-lgtm, needs work',
      "it's lgtm-ish but not quite",
    ]) {
      const messageStore = mockMessageStore([{ id: 'm1', userId: 'user-landy', catId: null, text }]);
      const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
      const result = await sources.isCvoAcceptedForThread('thread-001');
      assert.equal(result, false, `"${text}" should not trigger cvo_accepted`);
    }
  });

  it('still accepts "没问题" (positive idiom despite 没)', async () => {
    const messageStore = mockMessageStore([{ id: 'm1', userId: 'user-landy', catId: null, text: '看了，没问题' }]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isCvoAcceptedForThread('thread-001');
    assert.equal(result, true, '"没问题" is a positive idiom, should still accept');
  });

  it('rejects operator non-approval context (questions, particles, conditionals)', async () => {
    for (const text of [
      '可以合入吗？',
      'LGTM?',
      'approved?',
      '没问题吗',
      '没问题？',
      '没问题了吗？',
      '这个可以合入了吗？',
      '可以合入吧',
      '可以合入嘛',
      'LGTM? not sure',
      'approved? I need to check one thing',
      '可以合入吗？我不确定',
      '如果没问题再合入',
      '那如果没问题再合入',
      '这个如果没问题再合入',
      '没问题的话再合入',
      '没问题再说',
      '等确认没问题再合入',
      'not yet approved',
      'not quite LGTM',
      'this is almost approved',
      'approved by CI only',
      'LGTM: once tests pass',
      'approved: by CI only',
      'not quite: LGTM',
      'LGTM. But needs fixes',
    ]) {
      const messageStore = mockMessageStore([{ id: 'm1', userId: 'user-landy', catId: null, text }]);
      const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
      const result = await sources.isCvoAcceptedForThread('thread-001');
      assert.equal(result, false, `"${text}" is non-approval context, not operator approval`);
    }
  });

  // --- 通过 pattern precision: technical status ≠ approval ---

  it('rejects operator technical-status uses of "通过" (question + CI/test prefix + gap)', async () => {
    for (const text of [
      'CI 通过了吗？',
      '测试通过了',
      'build 通过了',
      'CI 已通过',
      '测试已经通过了',
      'CI check 通过了',
    ]) {
      const messageStore = mockMessageStore([{ id: 'm1', userId: 'user-landy', catId: null, text }]);
      const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
      const result = await sources.isCvoAcceptedForThread('thread-001');
      assert.equal(result, false, `"${text}" is technical status, not operator approval`);
    }
  });

  it('accepts operator mixed tech-status + explicit approval in same message', async () => {
    for (const text of ['CI 已通过，可以合入', '测试已经通过了，走起', 'CI 已通过，没问题']) {
      const messageStore = mockMessageStore([{ id: 'm1', userId: 'user-landy', catId: null, text }]);
      const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
      const result = await sources.isCvoAcceptedForThread('thread-001');
      assert.equal(result, true, `"${text}" has explicit accept after tech-status — should accept`);
    }
  });

  // --- Merge pattern precision (whole-message anchored) ---

  it('rejects operator merge questions and conditionals (non-imperative)', async () => {
    for (const text of [
      '什么时候 merge?',
      '先讨论再 merge',
      'merge?',
      'merge after CI?',
      'merge 吗？',
      'merge when tests pass',
    ]) {
      const messageStore = mockMessageStore([{ id: 'm1', userId: 'user-landy', catId: null, text }]);
      const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
      const result = await sources.isCvoAcceptedForThread('thread-001');
      assert.equal(result, false, `"${text}" should not trigger cvo_accepted`);
    }
  });

  it('accepts operator imperative "merge" as standalone approval', async () => {
    const messageStore = mockMessageStore([{ id: 'm1', userId: 'user-landy', catId: null, text: 'merge' }]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isCvoAcceptedForThread('thread-001');
    assert.equal(result, true, 'standalone "merge" is an approval signal');
  });

  it('accepts operator imperative "merge it" / "merge please"', async () => {
    for (const text of ['merge it', 'merge this', 'merge please', 'please merge', 'merge!']) {
      const messageStore = mockMessageStore([{ id: 'm1', userId: 'user-landy', catId: null, text }]);
      const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
      const result = await sources.isCvoAcceptedForThread('thread-001');
      assert.equal(result, true, `"${text}" should be accepted as merge approval`);
    }
  });

  // --- Latest decision wins (newest→oldest) ---

  it('operator rejection after approval → latest decision wins (returns false)', async () => {
    const messageStore = mockMessageStore([
      { id: 'm1', userId: 'user-landy', catId: null, text: '可以合入' },
      { id: 'm2', userId: 'user-landy', catId: null, text: '等等，不通过' },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isCvoAcceptedForThread('thread-001');
    assert.equal(result, false, 'later operator rejection should override earlier approval');
  });

  it('operator re-approval after rejection → latest decision wins (returns true)', async () => {
    const messageStore = mockMessageStore([
      { id: 'm1', userId: 'user-landy', catId: null, text: '不通过' },
      { id: 'm2', userId: 'user-landy', catId: null, text: '修好了，可以合入' },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isCvoAcceptedForThread('thread-001');
    assert.equal(result, true, 'later operator re-approval should win');
  });

  // --- Connector/system messages must not trigger operator acceptance ---

  it('ignores connector message with "CI 通过" (has source field)', async () => {
    const messageStore = mockMessageStore([
      {
        id: 'm1',
        userId: 'user-landy',
        catId: null,
        text: '✅ **CI 通过**\n\nPR #42 (repo/name)',
        source: { connector: 'github-ci' },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isCvoAcceptedForThread('thread-001');
    assert.equal(result, false, 'connector message with "通过" should not trigger cvo_accepted');
  });

  it('still detects real operator acceptance when connector messages also present', async () => {
    const messageStore = mockMessageStore([
      {
        id: 'm1',
        userId: 'user-landy',
        catId: null,
        text: '✅ **CI 通过**\n\nPR #42',
        source: { connector: 'github-ci' },
      },
      { id: 'm2', userId: 'user-landy', catId: null, text: '可以合入' },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isCvoAcceptedForThread('thread-001');
    assert.equal(result, true, 'real human message should still be detected alongside connector messages');
  });

  // --- AC-D2.1: Reviewer approval via thread messages ---

  it('detects reviewer approval from cat messages with LGTM', async () => {
    const messageStore = mockMessageStore([{ id: 'm1', userId: null, catId: 'codex-55', text: 'LGTM, 放行' }]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isReviewerApprovedForThread('thread-001');
    assert.equal(result, true);
  });

  it('detects reviewer approval with APPROVED keyword', async () => {
    const messageStore = mockMessageStore([{ id: 'm1', userId: null, catId: 'codex-55', text: 'Round 3: APPROVED' }]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isReviewerApprovedForThread('thread-001');
    assert.equal(result, true);
  });

  it('detects reviewer approval with Chinese "放行" keyword', async () => {
    const messageStore = mockMessageStore([{ id: 'm1', userId: null, catId: 'opus-47', text: '代码层通过，放行' }]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isReviewerApprovedForThread('thread-001');
    assert.equal(result, true);
  });

  it('ignores reviewer approval from human (only cat messages count)', async () => {
    const messageStore = mockMessageStore([{ id: 'm1', userId: 'user-landy', catId: null, text: 'LGTM' }]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isReviewerApprovedForThread('thread-001');
    assert.equal(result, false);
  });

  // --- Negation guard ---

  it('rejects reviewer negation phrases (Chinese + English + hyphenated)', async () => {
    for (const text of [
      'not approved, needs fixes',
      '不通过，退回修改',
      'status: not-approved, rework needed',
      'not-lgtm, rework',
    ]) {
      const messageStore = mockMessageStore([{ id: 'm1', userId: null, catId: 'codex-55', text }]);
      const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
      const result = await sources.isReviewerApprovedForThread('thread-001');
      assert.equal(result, false, `"${text}" should not trigger reviewer_approved`);
    }
  });

  it('accepts reviewer mixed tech-status + explicit approval in same message', async () => {
    for (const text of ['CI 已通过，放行', 'CI check 通过了，approved']) {
      const messageStore = mockMessageStore([{ id: 'm1', userId: null, catId: 'codex-55', text }]);
      const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
      const result = await sources.isReviewerApprovedForThread('thread-001');
      assert.equal(result, true, `"${text}" has explicit approval after tech-status — should accept`);
    }
  });

  // --- 通过 pattern precision: technical status ≠ approval ---

  it('rejects reviewer technical-status "通过" (prefix + gap words)', async () => {
    for (const text of ['CI 通过了，继续吧', 'CI 已通过', '测试已经通过了', 'CI check 通过了']) {
      const messageStore = mockMessageStore([{ id: 'm1', userId: null, catId: 'opus-46', text }]);
      const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
      const result = await sources.isReviewerApprovedForThread('thread-001');
      assert.equal(result, false, `"${text}" is tech status, not review decision`);
    }
  });

  it('rejects reviewer non-approval context (questions, particles, conditionals)', async () => {
    for (const text of [
      '可以合入吗？',
      'LGTM?',
      'approved?',
      '放行吗？',
      '没问题吗',
      '没问题了吗？',
      '可以合入吧',
      '放行嘛',
      'LGTM? not sure',
      'approved? let me check',
      '如果没问题再放行',
      '那如果没问题再放行',
      '没问题的话再放行',
      '等确认没问题再放行',
      'not yet approved',
      'not quite LGTM',
      'LGTM once tests pass',
      'approved after CI passes',
      'LGTM: once tests pass',
      'approved: after CI passes',
      'not quite: LGTM',
      'LGTM. But needs fixes',
    ]) {
      const messageStore = mockMessageStore([{ id: 'm1', userId: null, catId: 'codex-55', text }]);
      const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
      const result = await sources.isReviewerApprovedForThread('thread-001');
      assert.equal(result, false, `"${text}" is non-approval context, not reviewer approval`);
    }
  });

  // --- Latest decision wins (newest→oldest) ---

  it('reviewer rejection after approval → latest decision wins (returns false)', async () => {
    const messageStore = mockMessageStore([
      { id: 'm1', userId: null, catId: 'codex-55', text: 'LGTM, 放行' },
      { id: 'm2', userId: null, catId: 'codex-55', text: 'Wait, not approved — found issue' },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isReviewerApprovedForThread('thread-001');
    assert.equal(result, false, 'later reviewer rejection should override earlier approval');
  });

  it('reviewer re-approval after rejection → latest decision wins (returns true)', async () => {
    const messageStore = mockMessageStore([
      { id: 'm1', userId: null, catId: 'codex-55', text: '不通过，退回修改' },
      { id: 'm2', userId: null, catId: 'codex-55', text: '修好了，approved' },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isReviewerApprovedForThread('thread-001');
    assert.equal(result, true, 'later reviewer re-approval should win');
  });

  // --- Connector/system messages must not trigger reviewer approval ---

  it('ignores connector "CI 通过" with catId + source for reviewer approval', async () => {
    const messageStore = mockMessageStore([
      {
        id: 'm1',
        userId: null,
        catId: 'opus-46',
        text: '✅ **CI 通过**\n\nPR #42 (repo/name)\nAll checks passed.',
        source: { connector: 'github-ci' },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isReviewerApprovedForThread('thread-001');
    assert.equal(result, false, 'connector message with catId + "通过" must not trigger reviewer_approved');
  });

  it('still detects real cat reviewer approval when connector messages also present', async () => {
    const messageStore = mockMessageStore([
      {
        id: 'm1',
        userId: null,
        catId: 'opus-46',
        text: '✅ **CI 通过**\n\nPR #42',
        source: { connector: 'github-ci' },
      },
      { id: 'm2', userId: null, catId: 'codex-55', text: '没问题，approved' },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), messageStore, EMPTY_TASK_STORE);
    const result = await sources.isReviewerApprovedForThread('thread-001');
    assert.equal(result, true, 'real cat message should still trigger reviewer_approved');
  });
});

// --- Test helpers ---
function mockMessageStore(messages) {
  return {
    async getByThread(threadId, _limit, _userId) {
      return messages.map((m) => ({
        id: m.id,
        threadId,
        userId: m.userId ?? null,
        catId: m.catId ?? null,
        content: m.text,
        source: m.source ?? null,
        timestamp: Date.now(),
      }));
    },
  };
}

function mockDb() {
  return { prepare: () => ({ get: () => ({ cnt: 0 }) }) };
}
