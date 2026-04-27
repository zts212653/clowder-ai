/**
 * F118 Phase C — AC-C4/AC-C6: Resume Health Check + Overflow Circuit Breaker
 *
 * Only consecutive restore failures (≥3) trigger auto-seal.
 * Idle sessions (no matter how old) are NOT sealed — idle ≠ toxic.
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

describe('F118 resume health check (AC-C4 + AC-C6)', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-health-'));
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
          invocationId: `inv-${++counter}`,
          callbackToken: `tok-${counter}`,
        }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      ...overrides,
    };
  }

  /** A minimal service that yields done immediately */
  function makeOkService() {
    return {
      async *invoke() {
        yield { type: 'text', catId: 'codex', content: 'ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
  }

  it('auto-seals session after ≥3 consecutive restore failures (overflow)', async () => {
    const sealCalls = [];
    const finalizeCalls = [];
    const ONE_HOUR_AGO = Date.now() - 60 * 60 * 1000;

    const deps = makeDeps({
      sessionChainStore: {
        getChain: async () => [
          {
            id: 'sess-overflow',
            cliSessionId: 'cli-sess-overflow',
            status: 'active',
            updatedAt: ONE_HOUR_AGO,
            consecutiveRestoreFailures: 3,
            catId: 'codex',
            threadId: 'thread-overflow',
            userId: 'user1',
            seq: 0,
            messageCount: 5,
            createdAt: ONE_HOUR_AGO - 60000,
          },
        ],
        updateRecord: async () => {},
      },
      sessionSealer: {
        requestSeal: async (args) => {
          sealCalls.push(args);
          return { accepted: true, status: 'sealing' };
        },
        finalize: async (args) => {
          finalizeCalls.push(args);
        },
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

    // Should auto-seal due to overflow circuit breaker
    assert.equal(sealCalls.length, 1, 'requestSeal should be called once');
    assert.equal(sealCalls[0].sessionId, 'sess-overflow');
    assert.equal(sealCalls[0].reason, 'overflow_circuit_breaker');

    // Must call finalize to write transcript + digest (otherwise session recall 404s)
    // finalize is fire-and-forget, so wait a tick for the async call
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(finalizeCalls.length, 1, 'finalize should be called after requestSeal');
    assert.equal(finalizeCalls[0].sessionId, 'sess-overflow');

    // Should still complete successfully (fresh session)
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should yield done message',
    );
  });

  it('does NOT seal idle session regardless of age', async () => {
    const sealCalls = [];
    const TWO_WEEKS_AGO = Date.now() - 14 * 24 * 60 * 60 * 1000;

    const deps = makeDeps({
      sessionChainStore: {
        getChain: async () => [
          {
            id: 'sess-old-but-healthy',
            cliSessionId: 'cli-sess-old',
            status: 'active',
            updatedAt: TWO_WEEKS_AGO,
            consecutiveRestoreFailures: 0,
            catId: 'codex',
            threadId: 'thread-old',
            userId: 'user1',
            seq: 0,
            messageCount: 20,
            createdAt: TWO_WEEKS_AGO - 86400000,
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
        threadId: 'thread-old',
        isLastCat: true,
      }),
    );

    // Should NOT seal — idle ≠ toxic, even after 2 weeks
    assert.equal(sealCalls.length, 0, 'requestSeal should not be called for idle session');

    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should yield done message',
    );
  });

  it('does NOT seal session with failures below threshold', async () => {
    const sealCalls = [];

    const deps = makeDeps({
      sessionChainStore: {
        getChain: async () => [
          {
            id: 'sess-recovering',
            cliSessionId: 'cli-sess-recovering',
            status: 'active',
            updatedAt: Date.now() - 10 * 60 * 1000,
            consecutiveRestoreFailures: 2,
            catId: 'codex',
            threadId: 'thread-recovering',
            userId: 'user1',
            seq: 0,
            messageCount: 8,
            createdAt: Date.now() - 3600000,
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
        threadId: 'thread-recovering',
        isLastCat: true,
      }),
    );

    // 2 failures < threshold of 3 — should NOT seal
    assert.equal(sealCalls.length, 0, 'requestSeal should not be called when below threshold');

    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should yield done message',
    );
  });
});
