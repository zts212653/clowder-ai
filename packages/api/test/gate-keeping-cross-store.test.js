/**
 * F167 Phase O PR-O4: cross-store query unit tests.
 *
 * Tests detectEventCallback and verifyKeeperOwnership — the two
 * data-dependency wiring functions that PR-O3 left as skeleton.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F167 PR-O4: detectEventCallback', () => {
  /** Minimal stub — only implements listByThread. */
  function makeStubStore(tasks = []) {
    return {
      listByThread(_threadId) {
        return tasks;
      },
      getBySubject(_key) {
        return null;
      },
    };
  }

  test('returns false when no tasks in thread', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([]);
    const result = await detectEventCallback(store, 'thread_1');
    assert.equal(result, false);
  });

  test('returns false when only work tasks exist', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([
      { kind: 'work', status: 'open', threadId: 'thread_1' },
      { kind: 'work', status: 'in_progress', threadId: 'thread_1' },
    ]);
    const result = await detectEventCallback(store, 'thread_1');
    assert.equal(result, false);
  });

  test('returns true when active PR tracking exists', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([{ kind: 'pr_tracking', status: 'open', threadId: 'thread_1' }]);
    const result = await detectEventCallback(store, 'thread_1');
    assert.equal(result, true);
  });

  test('returns true when active issue tracking exists', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([{ kind: 'issue_tracking', status: 'in_progress', threadId: 'thread_1' }]);
    const result = await detectEventCallback(store, 'thread_1');
    assert.equal(result, true);
  });

  test('returns false when tracking tasks are done', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([
      { kind: 'pr_tracking', status: 'done', threadId: 'thread_1' },
      { kind: 'issue_tracking', status: 'done', threadId: 'thread_1' },
    ]);
    const result = await detectEventCallback(store, 'thread_1');
    assert.equal(result, false);
  });

  test('returns true when mix of done and active tracking', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([
      { kind: 'pr_tracking', status: 'done', threadId: 'thread_1' },
      { kind: 'issue_tracking', status: 'open', threadId: 'thread_1' },
    ]);
    const result = await detectEventCallback(store, 'thread_1');
    assert.equal(result, true);
  });

  test('fail-open: returns false on store error', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = {
      listByThread() {
        throw new Error('Redis connection lost');
      },
      getBySubject() {
        return null;
      },
    };
    const warnings = [];
    const log = { warn: (obj, msg) => warnings.push({ obj, msg }) };
    const result = await detectEventCallback(store, 'thread_1', log);
    assert.equal(result, false, 'fail-open: assume no callback');
    assert.equal(warnings.length, 1, 'warning logged');
    assert.ok(warnings[0].msg.includes('fail-open'));
  });
});

describe('F167 PR-O4 R1: extractRepoAndNumber', () => {
  test('parses PR subjectKey', async () => {
    const { extractRepoAndNumber } = await import('../dist/routes/gate-keeping-cross-store.js');
    const result = extractRepoAndNumber('pr:owner/repo#42');
    assert.deepEqual(result, { repo: 'owner/repo', number: '42' });
  });

  test('parses issue subjectKey', async () => {
    const { extractRepoAndNumber } = await import('../dist/routes/gate-keeping-cross-store.js');
    const result = extractRepoAndNumber('issue:org/my-repo#99');
    assert.deepEqual(result, { repo: 'org/my-repo', number: '99' });
  });

  test('parses GitHub issues URL', async () => {
    const { extractRepoAndNumber } = await import('../dist/routes/gate-keeping-cross-store.js');
    const result = extractRepoAndNumber('https://github.com/owner/repo/issues/42');
    assert.deepEqual(result, { repo: 'owner/repo', number: '42' });
  });

  test('parses GitHub issues URL with comment anchor', async () => {
    const { extractRepoAndNumber } = await import('../dist/routes/gate-keeping-cross-store.js');
    const result = extractRepoAndNumber('https://github.com/owner/repo/issues/42#issuecomment-123');
    assert.deepEqual(result, { repo: 'owner/repo', number: '42' });
  });

  test('parses GitHub pull URL', async () => {
    const { extractRepoAndNumber } = await import('../dist/routes/gate-keeping-cross-store.js');
    const result = extractRepoAndNumber('https://github.com/owner/repo/pull/7');
    assert.deepEqual(result, { repo: 'owner/repo', number: '7' });
  });

  test('R3: parses bare repo ref (owner/repo#42)', async () => {
    const { extractRepoAndNumber } = await import('../dist/routes/gate-keeping-cross-store.js');
    const result = extractRepoAndNumber('AgeOfLearning/cat-cafe#200');
    assert.deepEqual(result, { repo: 'ageoflearning/cat-cafe', number: '200' });
  });

  test('R3: parses bare repo ref with comment suffix (owner/repo#42/comment/123)', async () => {
    const { extractRepoAndNumber } = await import('../dist/routes/gate-keeping-cross-store.js');
    const result = extractRepoAndNumber('AgeOfLearning/cat-cafe#200/comment/42');
    assert.deepEqual(result, { repo: 'ageoflearning/cat-cafe', number: '200' });
  });

  test('R4: normalizes repo to lowercase (case-insensitive matching)', async () => {
    const { extractRepoAndNumber } = await import('../dist/routes/gate-keeping-cross-store.js');
    // All three patterns should normalize repo to lowercase
    assert.deepEqual(
      extractRepoAndNumber('pr:AgeOfLearning/Cat-Cafe#42'),
      { repo: 'ageoflearning/cat-cafe', number: '42' },
      'subjectKey format normalizes',
    );
    assert.deepEqual(
      extractRepoAndNumber('https://github.com/AgeOfLearning/Cat-Cafe/issues/42'),
      { repo: 'ageoflearning/cat-cafe', number: '42' },
      'GitHub URL format normalizes',
    );
    assert.deepEqual(
      extractRepoAndNumber('AgeOfLearning/Cat-Cafe#42'),
      { repo: 'ageoflearning/cat-cafe', number: '42' },
      'bare ref format normalizes',
    );
  });

  test('returns null for unrecognized input', async () => {
    const { extractRepoAndNumber } = await import('../dist/routes/gate-keeping-cross-store.js');
    assert.equal(extractRepoAndNumber('some-random-text'), null);
    assert.equal(extractRepoAndNumber('thread:abc-123'), null);
    assert.equal(extractRepoAndNumber('https://example.com/page'), null);
  });
});

describe('F167 PR-O4 R1: detectEventCallback (subject-aware)', () => {
  /**
   * Stub store supporting both listByThread and getBySubject.
   * @param tasks - tasks returned by listByThread (same-thread)
   * @param subjectIndex - map of subjectKey → TaskItem for cross-thread lookup
   */
  function makeStubStore(tasks = [], subjectIndex = {}) {
    return {
      listByThread(_threadId) {
        return tasks;
      },
      getBySubject(key) {
        return subjectIndex[key] ?? null;
      },
    };
  }

  test('matching subject + active tracking → true (event-backed)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([
      { kind: 'pr_tracking', status: 'open', threadId: 'thread_1', subjectKey: 'pr:owner/repo#42' },
    ]);
    const waitSourceRef = { kind: 'github_issue', value: 'https://github.com/owner/repo/issues/42#issuecomment-9' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, true, 'tracking for same subject → callback covers this wait');
  });

  test('UNRELATED tracking + waitSourceRef → false (hold NOT redundant)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([
      { kind: 'issue_tracking', status: 'open', threadId: 'thread_1', subjectKey: 'issue:owner/repo#99' },
    ]);
    const waitSourceRef = { kind: 'github_issue', value: 'https://github.com/owner/repo/issues/42' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, false, 'unrelated tracking must NOT block hold (P1 fix: 误杀 prevention)');
  });

  test('no waitSourceRef + active tracking → true (thread-level fallback)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([
      { kind: 'pr_tracking', status: 'open', threadId: 'thread_1', subjectKey: 'pr:owner/repo#42' },
    ]);
    // No waitSourceRef → falls back to thread-level detection
    const result = await detectEventCallback(store, 'thread_1');
    assert.equal(result, true, 'no waitSourceRef → conservative thread-level fallback');
  });

  test('R2: non-GitHub waitSourceRef kind + active tracking → false (GitHub tracking cannot cover non-GitHub wait)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([
      { kind: 'pr_tracking', status: 'open', threadId: 'thread_1', subjectKey: 'pr:owner/repo#42' },
    ]);
    const waitSourceRef = { kind: 'thread_message', value: 'msg_abc123' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, false, 'non-GitHub wait cannot be covered by GitHub tracking');
  });

  test('R2: reporter_handle kind + active tracking → false (non-GitHub kind)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([
      { kind: 'issue_tracking', status: 'open', threadId: 'thread_1', subjectKey: 'issue:owner/repo#99' },
    ]);
    const waitSourceRef = { kind: 'reporter_handle', value: 'user@example.com' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, false, 'reporter_handle wait not covered by GitHub tracking');
  });

  test('R2: unparseable GitHub URL + active tracking → true (conservative fallback)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([
      { kind: 'pr_tracking', status: 'open', threadId: 'thread_1', subjectKey: 'pr:owner/repo#42' },
    ]);
    // GitHub kind but unusual URL format → extractRepoAndNumber returns null → conservative
    const waitSourceRef = { kind: 'github_issue', value: 'https://gitlab.com/different/format/42' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, true, 'unparseable GitHub-kind URL → conservative thread-level fallback');
  });

  test('R3: bare ref waitSourceRef + matching tracking → true (subject match)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([
      { kind: 'issue_tracking', status: 'open', threadId: 'thread_1', subjectKey: 'issue:AgeOfLearning/cat-cafe#200' },
    ]);
    const waitSourceRef = { kind: 'github_issue', value: 'AgeOfLearning/cat-cafe#200' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, true, 'bare ref matches tracking subjectKey → callback covers this wait');
  });

  test('R3: bare ref with comment suffix + UNRELATED tracking → false', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([
      { kind: 'pr_tracking', status: 'open', threadId: 'thread_1', subjectKey: 'pr:owner/repo#42' },
    ]);
    const waitSourceRef = { kind: 'github_comment', value: 'AgeOfLearning/cat-cafe#200/comment/42' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, false, 'bare ref with comment suffix does not match unrelated tracking');
  });

  test('R4: case-insensitive repo matching (cloud P2 fix)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    // Tracking stores mixed-case, hold arrives with lowercase — must still match
    const store = makeStubStore([
      { kind: 'pr_tracking', status: 'open', threadId: 'thread_1', subjectKey: 'pr:AgeOfLearning/cat-cafe#200' },
    ]);
    const waitSourceRef = { kind: 'github_issue', value: 'https://github.com/ageoflearning/cat-cafe/issues/200' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, true, 'case difference in repo must not break subject matching');
  });

  test('R5: cross-thread tracking for same subject → true (downstream owns, block hold)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    // No same-thread tracking, but downstream thread_2 has active tracking for same issue
    const store = makeStubStore([], {
      'issue:owner/repo#42': {
        kind: 'issue_tracking',
        status: 'open',
        threadId: 'thread_2',
        subjectKey: 'issue:owner/repo#42',
      },
    });
    const waitSourceRef = { kind: 'github_issue', value: 'https://github.com/owner/repo/issues/42' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, true, 'downstream thread tracking same issue → block hold (spec L900-904)');
  });

  test('R5: cross-thread tracking for DIFFERENT subject → false (no coverage)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    // Downstream tracks issue #99, but hold is for issue #42
    const store = makeStubStore([], {
      'issue:owner/repo#99': {
        kind: 'issue_tracking',
        status: 'open',
        threadId: 'thread_2',
        subjectKey: 'issue:owner/repo#99',
      },
    });
    const waitSourceRef = { kind: 'github_issue', value: 'https://github.com/owner/repo/issues/42' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, false, 'downstream tracks different issue → hold allowed');
  });

  test('R5: cross-thread tracking in SAME thread → false (not cross-thread)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    // getBySubject finds a task but it's in the same thread — not a cross-thread block
    const store = makeStubStore([], {
      'pr:owner/repo#42': {
        kind: 'pr_tracking',
        status: 'open',
        threadId: 'thread_1',
        subjectKey: 'pr:owner/repo#42',
      },
    });
    const waitSourceRef = { kind: 'github_issue', value: 'https://github.com/owner/repo/issues/42' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, false, 'same-thread getBySubject hit is not cross-thread');
  });

  test('R5: cross-thread tracking done status → false (tracking completed)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    // Downstream had tracking but it's done — no active callback
    const store = makeStubStore([], {
      'issue:owner/repo#42': {
        kind: 'issue_tracking',
        status: 'done',
        threadId: 'thread_2',
        subjectKey: 'issue:owner/repo#42',
      },
    });
    const waitSourceRef = { kind: 'github_issue', value: 'https://github.com/owner/repo/issues/42' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, false, 'done cross-thread tracking → no active callback');
  });

  test('R5: no same-thread tasks + no waitSourceRef → false (thread-level, no tracking)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    // No tasks in this thread, no waitSourceRef → thread-level check → false
    const store = makeStubStore([]);
    const result = await detectEventCallback(store, 'thread_1');
    assert.equal(result, false, 'no same-thread tracking + no waitSourceRef → false');
  });

  test('tracking without subjectKey + GitHub waitSourceRef → false (no match possible)', async () => {
    const { detectEventCallback } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore([{ kind: 'pr_tracking', status: 'open', threadId: 'thread_1', subjectKey: null }]);
    const waitSourceRef = { kind: 'github_issue', value: 'https://github.com/owner/repo/issues/42' };
    const result = await detectEventCallback(store, 'thread_1', undefined, waitSourceRef);
    assert.equal(result, false, 'tracking without subjectKey cannot match → no callback');
  });
});

describe('F167 PR-O4: verifyKeeperOwnership', () => {
  function makeStubStore(existingTask = null) {
    return {
      listByThread() {
        return [];
      },
      getBySubject(_key) {
        return existingTask;
      },
    };
  }

  test('returns keeper when no existing task for subject', async () => {
    const { verifyKeeperOwnership } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore(null);
    const result = await verifyKeeperOwnership(store, 'thread_gk', 'issue:org/repo#42');
    assert.equal(result, 'keeper');
  });

  test('returns keeper when existing task is in same thread', async () => {
    const { verifyKeeperOwnership } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore({
      kind: 'issue_tracking',
      status: 'open',
      threadId: 'thread_gk',
      subjectKey: 'issue:org/repo#42',
    });
    const result = await verifyKeeperOwnership(store, 'thread_gk', 'issue:org/repo#42');
    assert.equal(result, 'keeper');
  });

  test('returns distributed when existing task is in different thread', async () => {
    const { verifyKeeperOwnership } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = makeStubStore({
      kind: 'issue_tracking',
      status: 'open',
      threadId: 'thread_downstream_99',
      subjectKey: 'issue:org/repo#42',
    });
    const result = await verifyKeeperOwnership(store, 'thread_gk', 'issue:org/repo#42');
    assert.equal(result, 'distributed');
  });

  test('fail-open: returns distributed on store error (conservative deny)', async () => {
    const { verifyKeeperOwnership } = await import('../dist/routes/gate-keeping-cross-store.js');
    const store = {
      listByThread() {
        return [];
      },
      getBySubject() {
        throw new Error('Redis timeout');
      },
    };
    const warnings = [];
    const log = { warn: (obj, msg) => warnings.push({ obj, msg }) };
    const result = await verifyKeeperOwnership(store, 'thread_gk', 'issue:org/repo#42', log);
    assert.equal(result, 'distributed', 'fail-open: deny unverified claim');
    assert.equal(warnings.length, 1, 'warning logged');
  });
});
