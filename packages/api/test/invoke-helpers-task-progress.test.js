import assert from 'node:assert/strict';
import { test } from 'node:test';

const { TASK_TOOL_NAMES, normalizeTaskStatus, extractTaskProgress } = await import(
  '../dist/domains/cats/services/agents/invocation/invoke-helpers.js'
);

// ── F055-fix: TASK_TOOL_NAMES includes lowercase 'todowrite' (opencode variant) ──

test('TASK_TOOL_NAMES includes TodoWrite', () => {
  assert.ok(TASK_TOOL_NAMES.has('TodoWrite'));
});

test('TASK_TOOL_NAMES includes write_todos', () => {
  assert.ok(TASK_TOOL_NAMES.has('write_todos'));
});

test('TASK_TOOL_NAMES includes todowrite (opencode lowercase)', () => {
  assert.ok(TASK_TOOL_NAMES.has('todowrite'));
});

// ── F055-fix: normalizeTaskStatus maps non-standard values ──

test('normalizeTaskStatus: completed → completed', () => {
  assert.equal(normalizeTaskStatus('completed'), 'completed');
});

test('normalizeTaskStatus: done → completed', () => {
  assert.equal(normalizeTaskStatus('done'), 'completed');
});

test('normalizeTaskStatus: finished → completed', () => {
  assert.equal(normalizeTaskStatus('finished'), 'completed');
});

test('normalizeTaskStatus: DONE (case-insensitive) → completed', () => {
  assert.equal(normalizeTaskStatus('DONE'), 'completed');
});

test('normalizeTaskStatus: in_progress → in_progress', () => {
  assert.equal(normalizeTaskStatus('in_progress'), 'in_progress');
});

test('normalizeTaskStatus: doing → in_progress', () => {
  assert.equal(normalizeTaskStatus('doing'), 'in_progress');
});

test('normalizeTaskStatus: active → in_progress', () => {
  assert.equal(normalizeTaskStatus('active'), 'in_progress');
});

test('normalizeTaskStatus: running → in_progress', () => {
  assert.equal(normalizeTaskStatus('running'), 'in_progress');
});

test('normalizeTaskStatus: pending → pending', () => {
  assert.equal(normalizeTaskStatus('pending'), 'pending');
});

test('normalizeTaskStatus: unknown value → pending (fallback)', () => {
  assert.equal(normalizeTaskStatus('whatever'), 'pending');
});

test('normalizeTaskStatus: non-string input (number) → pending (defensive)', () => {
  assert.equal(normalizeTaskStatus(1), 'pending');
});

test('normalizeTaskStatus: non-string input (null) → pending (defensive)', () => {
  assert.equal(normalizeTaskStatus(null), 'pending');
});

test('normalizeTaskStatus: non-string input (undefined) → pending (defensive)', () => {
  assert.equal(normalizeTaskStatus(undefined), 'pending');
});

test('normalizeTaskStatus: non-string input (object) → pending (defensive)', () => {
  assert.equal(normalizeTaskStatus({ status: 'done' }), 'pending');
});

test('normalizeTaskStatus: whitespace-padded string → trimmed and normalized', () => {
  assert.equal(normalizeTaskStatus('  done  '), 'completed');
});

// ── F055-fix: extractTaskProgress with lowercase todowrite ──

test('extractTaskProgress: todowrite (lowercase) triggers extraction', () => {
  const result = extractTaskProgress('todowrite', {
    todos: [
      { content: 'Fix the bug', status: 'in_progress' },
      { content: 'Write tests', status: 'pending' },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.action, 'snapshot');
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].subject, 'Fix the bug');
  assert.equal(result.tasks[0].status, 'in_progress');
});

test('extractTaskProgress: normalizes non-standard status from tool input', () => {
  const result = extractTaskProgress('TodoWrite', {
    todos: [
      { content: 'Task A', status: 'done' },
      { content: 'Task B', status: 'doing' },
      { content: 'Task C', status: 'pending' },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.tasks[0].status, 'completed');
  assert.equal(result.tasks[1].status, 'in_progress');
  assert.equal(result.tasks[2].status, 'pending');
});

test('extractTaskProgress: unknown tool name → null', () => {
  assert.equal(extractTaskProgress('SomeOtherTool', { todos: [{ content: 'x', status: 'done' }] }), null);
});

test('extractTaskProgress: missing toolInput → null', () => {
  assert.equal(extractTaskProgress('TodoWrite', undefined), null);
});

test('extractTaskProgress: non-array todos → null', () => {
  assert.equal(extractTaskProgress('TodoWrite', { todos: 'not-an-array' }), null);
});

test('extractTaskProgress: truncates subject to 120 chars', () => {
  const longContent = 'A'.repeat(200);
  const result = extractTaskProgress('TodoWrite', {
    todos: [{ content: longContent, status: 'pending' }],
  });
  assert.ok(result !== null);
  assert.equal(result.tasks[0].subject.length, 120);
});

test('extractTaskProgress: non-string status in todo item → pending (no crash)', () => {
  const result = extractTaskProgress('TodoWrite', {
    todos: [
      { content: 'numeric status', status: 1 },
      { content: 'object status', status: { value: 'done' } },
      { content: 'null status', status: null },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.tasks[0].status, 'pending');
  assert.equal(result.tasks[1].status, 'pending');
  assert.equal(result.tasks[2].status, 'pending');
});
