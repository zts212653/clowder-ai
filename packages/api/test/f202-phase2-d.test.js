/** Host TaskStore tracking-kind eviction and shared subject-key coverage. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');

// D1: subject key helpers (must exist in shared)
const { issueSubjectKey, parseIssueSubjectKey } = await import('@cat-cafe/shared');

// ── AC-D1: issue_tracking TaskKind + eviction protection ──────────

describe('AC-D1: issue_tracking TaskKind', () => {
  test('TaskStore accepts kind=issue_tracking', () => {
    const store = new TaskStore();
    const task = store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:owner/repo#42',
      title: 'Issue tracking: owner/repo#42',
      why: 'Tracking issue',
      createdBy: 'cat1',
    });
    assert.strictEqual(task.kind, 'issue_tracking');
    assert.strictEqual(task.subjectKey, 'issue:owner/repo#42');
  });

  test('issue_tracking tasks are protected from eviction', () => {
    const store = new TaskStore({ maxTasks: 3 });

    // Create issue_tracking task (protected)
    store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:o/r#1',
      title: 'Issue #1',
      why: 'track',
      createdBy: 'cat1',
    });

    // Create 2 work tasks (not protected)
    store.create({ kind: 'work', threadId: 't1', title: 'w1', why: 'w', createdBy: 'cat1' });
    store.create({ kind: 'work', threadId: 't1', title: 'w2', why: 'w', createdBy: 'cat1' });

    // Trigger eviction — issue_tracking should survive
    store.create({ kind: 'work', threadId: 't1', title: 'w3', why: 'w', createdBy: 'cat1' });

    const issueTask = store.getBySubject('issue:o/r#1');
    assert.ok(issueTask, 'issue_tracking task should survive eviction');
    assert.strictEqual(issueTask.kind, 'issue_tracking');
  });

  test('done issue_tracking tasks are NOT protected from eviction', () => {
    const store = new TaskStore({ maxTasks: 2 });

    // Create issue_tracking task and mark done
    const task = store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:o/r#2',
      title: 'Issue #2',
      why: 'track',
      createdBy: 'cat1',
    });
    store.update(task.id, { status: 'done' });

    // Fill to capacity
    store.create({ kind: 'work', threadId: 't1', title: 'w1', why: 'w', createdBy: 'cat1' });
    store.create({ kind: 'work', threadId: 't1', title: 'w2', why: 'w', createdBy: 'cat1' });

    const evicted = store.getBySubject('issue:o/r#2');
    assert.strictEqual(evicted, null, 'done issue_tracking task should be evicted');
  });

  test('listByKind returns issue_tracking tasks', () => {
    const store = new TaskStore();
    store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:o/r#10',
      title: 'Issue #10',
      why: 'track',
      createdBy: 'cat1',
    });
    store.create({ kind: 'work', threadId: 't1', title: 'w1', why: 'w', createdBy: 'cat1' });

    const issues = store.listByKind('issue_tracking');
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].kind, 'issue_tracking');
  });
});

// ── Subject key helpers ───────────────────────────────────────────

describe('Issue subject key helpers', () => {
  test('issueSubjectKey generates correct format', () => {
    assert.strictEqual(issueSubjectKey('owner/repo', 42), 'issue:owner/repo#42');
  });

  test('parseIssueSubjectKey parses valid key', () => {
    const parsed = parseIssueSubjectKey('issue:owner/repo#42');
    assert.deepStrictEqual(parsed, { repoFullName: 'owner/repo', issueNumber: 42 });
  });

  test('parseIssueSubjectKey returns null for non-issue key', () => {
    assert.strictEqual(parseIssueSubjectKey('pr:owner/repo#42'), null);
  });

  test('parseIssueSubjectKey returns null for malformed key', () => {
    assert.strictEqual(parseIssueSubjectKey('issue:nohash'), null);
  });

  test('parseIssueSubjectKey returns null for partially-numeric issue number (Cloud R12 P2)', () => {
    // parseInt("123abc") === 123 (not NaN), but the projector rejects non-pure-digit suffixes.
    // The parser must be strict to prevent accepting keys that would cause projector 500s.
    assert.strictEqual(
      parseIssueSubjectKey('issue:owner/repo#123abc'),
      null,
      'partially numeric issue number must be rejected',
    );
  });
});
