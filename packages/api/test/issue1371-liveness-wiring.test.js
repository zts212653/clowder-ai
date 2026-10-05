import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('production reaper receives the native exit reader and exact tracker fence', () => {
  const source = read('index.ts');
  const start = source.indexOf('new InvocationOwnerReaper({');
  assert.ok(start > 0);
  const wiring = source.slice(start, source.indexOf('\n  });', start));
  assert.match(wiring, /\.\.\.createExitedCliExecutionRecovery\(invocationTracker\)/);
  assert.match(wiring, /\bturnExecutionStore,/);
  assert.match(wiring, /\binvocationRecordStore,/);
});

test('Codex lifecycle producer binds the exact child as well as the parent control identity', () => {
  const source = read('domains/cats/services/agents/providers/CodexAgentService.ts');
  assert.match(
    source,
    /recordCodexAppServerLifecycle\(\{[^}]*invocationId: auditContext\.executionId \?\? auditContext\.invocationId,[^}]*childInvocationId: auditContext\.invocationId,[^}]*lifecycle,/s,
  );
});
