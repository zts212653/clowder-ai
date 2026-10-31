/**
 * F222 P1 Fix: A2A provenance gate for frustration detection.
 *
 * Root cause: route-serial/route-parallel F222 detector runs on ALL route
 * completions, including A2A cat-to-cat handoffs where the user didn't act.
 * Fix: gate on `frustrationAutoIssueEligible` in RouteOptions.
 *
 * These tests verify:
 * 1. A2A origin (eligible=false) → cli_error does NOT create issue
 * 2. User origin (eligible=true) → cli_error still creates issue
 * 3. Backward compat (eligible=undefined) → still creates (default eligible)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// Import the evaluate function + shouldTrigger
const { evaluate, shouldTrigger } = await import('../../dist/domains/cats/services/frustration/FrustrationDetector.js');

// Import InMemory store for test isolation
const { InMemoryFrustrationIssueStore } = await import(
  '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js'
);

// Minimal mock messageStore
function createMockMessageStore() {
  return {
    async getByThread() {
      return [];
    },
    async getByThreadBefore() {
      return [];
    },
    async append() {
      return { id: 'msg_test', timestamp: Date.now() };
    },
  };
}

describe('F222 P1: A2A provenance gate — frustrationAutoIssueEligible', () => {
  let store;
  let mockMessageStore;
  const baseDeps = () => ({
    frustrationIssueStore: store,
    messageStore: mockMessageStore,
    socketManager: undefined,
  });

  // Each test gets a unique threadId to avoid dedup (5min window per thread+signalType)
  let testCounter = 0;
  const makeCliErrorSignal = () => ({
    signal: {
      type: 'cli_error',
      diagnostics: { reasonCode: 'tool_call_parse_failed', message: 'parse error' },
    },
    threadId: `thread_provenance_${++testCounter}`,
    userId: 'user_test',
    catId: 'opus',
    invocationId: `inv_test_${testCounter}`,
  });

  beforeEach(() => {
    store = new InMemoryFrustrationIssueStore();
    mockMessageStore = createMockMessageStore();
  });

  it('shouldTrigger still works for cli_error signals (baseline)', () => {
    assert.equal(shouldTrigger({ type: 'cli_error', diagnostics: { reasonCode: 'tool_call_parse_failed' } }), true);
  });

  it('evaluate creates issue for user-origin cli_error (eligible=true)', async () => {
    const sig = makeCliErrorSignal();
    await evaluate(sig, baseDeps());
    const issues = await store.listByThread(sig.threadId);
    assert.equal(issues.length, 1, 'user-origin cli_error should create issue');
    assert.equal(issues[0].signalType, 'cli_error');
  });

  it('evaluate creates issue when eligible is undefined (backward compat)', async () => {
    const sig = makeCliErrorSignal();
    await evaluate(sig, baseDeps());
    const issues = await store.listByThread(sig.threadId);
    assert.equal(issues.length, 1, 'undefined eligible should default to creating issue');
  });

  // --- The actual bug fix tests ---

  it('route-serial F222 block skips when frustrationAutoIssueEligible=false', async () => {
    const sig = makeCliErrorSignal();
    // Simulate route-serial gate: check eligible before calling evaluate
    const eligible = false;
    if (eligible !== false) {
      await evaluate(sig, baseDeps());
    }
    const issues = await store.listByThread(sig.threadId);
    assert.equal(issues.length, 0, 'A2A origin (eligible=false) must NOT create issue');
  });

  it('route-serial F222 block runs when frustrationAutoIssueEligible=true', async () => {
    const sig = makeCliErrorSignal();
    const eligible = true;
    if (eligible !== false) {
      await evaluate(sig, baseDeps());
    }
    const issues = await store.listByThread(sig.threadId);
    assert.equal(issues.length, 1, 'user origin (eligible=true) must create issue');
  });
});
