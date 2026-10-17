import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

// Provider CI/merge cases moved to installed-task-signals.test.js and
// installed-pr-observations.test.js; old automationState is no longer a source.

describe('F200 AC-D2 — SqliteSignalSources delegation', () => {
  let ThreadAwareSignalSources;

  before(async () => {
    const mod = await import(`../../dist/domains/memory/ThreadAwareSignalSources.js?v=${Date.now()}`);
    ThreadAwareSignalSources = mod.ThreadAwareSignalSources;
  });

  it('delegates getInvocationStatus to SqliteSignalSources', async () => {
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), mockTaskStore([]));
    const result = await sources.getInvocationStatus('inv-nonexistent');
    assert.equal(result, null);
  });
});

function mockMessageStore() {
  return { getByThread: async () => [] };
}
function mockTaskStore() {
  return { listByThread: async () => [] };
}
function mockDb() {
  return { prepare: () => ({ get: () => ({ cnt: 0 }) }) };
}
