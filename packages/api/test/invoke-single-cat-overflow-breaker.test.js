/**
 * F118 Phase C — AC-C6: Overflow Circuit Breaker
 *
 * When a session has >= 3 consecutive restore failures, the circuit breaker
 * trips: auto-seal the session and fall back to fresh instead of resuming.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

let tempDir;
let invokeSingleCat;

describe('F118 overflow circuit breaker (AC-C6)', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-breaker-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeDeps(overrides = {}) {
    let counter = 0;
    return {
      registry: {
        create: () => ({
          invocationId: `inv-breaker-${++counter}`,
          callbackToken: `tok-${counter}`,
        }),
        verify: () => null,
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'your local Clowder API URL',
      ...overrides,
    };
  }

  function makeOkService() {
    return {
      async *invoke() {
        yield { type: 'text', catId: 'codex', content: 'ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
  }

  it('breaks circuit when consecutiveRestoreFailures >= 3', async () => {
    const sealCalls = [];
    const RECENT = Date.now() - 60 * 1000; // 1 min ago (not stale)

    const deps = makeDeps({
      sessionChainStore: {
        getChain: async () => [
          {
            id: 'sess-overflow',
            cliSessionId: 'cli-sess-overflow',
            status: 'active',
            updatedAt: RECENT,
            catId: 'codex',
            threadId: 'thread-overflow',
            userId: 'user1',
            seq: 0,
            messageCount: 10,
            createdAt: RECENT - 60000,
            consecutiveRestoreFailures: 3,
          },
        ],
        updateRecord: async () => {},
      },
      sessionSealer: {
        requestSeal: async (args) => {
          sealCalls.push(args);
          return { accepted: true, status: 'sealing' };
        },
        finalize: async () => {},
        reconcileStuck: async () => 0,
        reconcileAllStuck: async () => 0,
      },
    });

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service: makeOkService(),
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-overflow',
        isLastCat: true,
      }),
    );

    // Circuit breaker should have tripped: auto-seal + fresh session
    assert.equal(sealCalls.length, 1, 'requestSeal should be called once for circuit breaker');
    assert.equal(sealCalls[0].sessionId, 'sess-overflow');

    // Should still complete successfully (fresh session)
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should yield done message',
    );
  });

  it('allows resume when consecutiveRestoreFailures below threshold', async () => {
    const sealCalls = [];
    const RECENT = Date.now() - 60 * 1000;

    const deps = makeDeps({
      sessionChainStore: {
        getChain: async () => [
          {
            id: 'sess-ok',
            cliSessionId: 'cli-sess-ok',
            status: 'active',
            updatedAt: RECENT,
            catId: 'codex',
            threadId: 'thread-ok',
            userId: 'user1',
            seq: 0,
            messageCount: 3,
            createdAt: RECENT - 60000,
            consecutiveRestoreFailures: 1,
          },
        ],
        updateRecord: async () => {},
      },
      sessionSealer: {
        requestSeal: async (args) => {
          sealCalls.push(args);
          return { accepted: true, status: 'sealing' };
        },
        finalize: async () => {},
        reconcileStuck: async () => 0,
        reconcileAllStuck: async () => 0,
      },
    });

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service: makeOkService(),
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-ok',
        isLastCat: true,
      }),
    );

    // Should NOT trip circuit breaker
    assert.equal(sealCalls.length, 0, 'requestSeal should not be called for low failure count');

    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should yield done message',
    );
  });
});
