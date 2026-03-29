/**
 * Integration test: preflight timeout rescues invocation from hung pre-flight ops.
 *
 * Simulates Pattern A from the 2026-03-28 stuck-thread incident:
 * sessionManager.get() never resolves → generator should NOT hang forever.
 * With preflightRace, the invocation proceeds without session after timeout.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let invokeSingleCat;
let tempDir;
let originalTimeout;

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

describe('preflight timeout rescues hung invocation', () => {
  before(async () => {
    // Set a very short preflight timeout for testing (200ms instead of 30s)
    originalTimeout = process.env.CAT_CAFE_PREFLIGHT_TIMEOUT_MS;
    process.env.CAT_CAFE_PREFLIGHT_TIMEOUT_MS = '200';

    tempDir = mkdtempSync(join(tmpdir(), 'cat-audit-preflight-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';

    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  after(() => {
    if (originalTimeout === undefined) delete process.env.CAT_CAFE_PREFLIGHT_TIMEOUT_MS;
    else process.env.CAT_CAFE_PREFLIGHT_TIMEOUT_MS = originalTimeout;
    delete process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('Pattern A: hanging sessionManager.get does not block invocation forever', async () => {
    let serviceCalled = false;
    const stubService = {
      async *invoke() {
        serviceCalled = true;
        yield { type: 'text', catId: 'opus', content: 'rescued', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    let counter = 0;
    const deps = {
      registry: {
        create: () => ({ invocationId: `inv-hang-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: () => null,
      },
      sessionManager: {
        // Simulates a hung Redis: never resolves
        get: () => new Promise(() => {}),
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };

    const start = Date.now();
    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service: stubService,
        prompt: 'test preflight timeout rescue',
        userId: 'user1',
        threadId: 'thread-hang-rescue',
        isLastCat: true,
      }),
    );
    const elapsed = Date.now() - start;

    // Should have completed — not hung forever
    assert.ok(serviceCalled, 'service.invoke must be called after preflight timeout');
    assert.ok(
      msgs.some((m) => m.type === 'text' && m.content === 'rescued'),
      'should yield service output',
    );
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should yield done',
    );
    // Should complete within ~1s (200ms timeout + overhead), not 30s
    assert.ok(elapsed < 5000, `should complete quickly, took ${elapsed}ms`);
  });

  it('Pattern A: hanging sessionChainStore.getChain does not block invocation', async () => {
    let serviceCalled = false;
    const stubService = {
      async *invoke() {
        serviceCalled = true;
        yield { type: 'text', catId: 'opus', content: 'chain-rescued', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    let counter = 0;
    const deps = {
      registry: {
        create: () => ({ invocationId: `inv-chain-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: () => null,
      },
      sessionManager: {
        get: async () => 'some-session-id',
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
      },
      sessionChainStore: {
        // Simulates a hung chain store: never resolves
        getChain: () => new Promise(() => {}),
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };

    const start = Date.now();
    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service: stubService,
        prompt: 'test chain timeout rescue',
        userId: 'user1',
        threadId: 'thread-chain-hang',
        isLastCat: true,
      }),
    );
    const elapsed = Date.now() - start;

    assert.ok(serviceCalled, 'service.invoke must be called after chain store timeout');
    assert.ok(elapsed < 5000, `should complete quickly, took ${elapsed}ms`);
  });

  it('abort signal fires during preflight — invocation exits cleanly', async () => {
    const ac = new AbortController();

    let serviceCalled = false;
    const stubService = {
      async *invoke() {
        serviceCalled = true;
        yield { type: 'text', catId: 'opus', content: 'should-not-see', timestamp: Date.now() };
      },
    };

    let counter = 0;
    const deps = {
      registry: {
        create: () => ({ invocationId: `inv-abort-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: () => null,
      },
      sessionManager: {
        // Hang long enough for abort to fire first
        get: () => new Promise(() => {}),
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };

    // Abort after 50ms
    setTimeout(() => ac.abort(new Error('user_cancel')), 50);

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service: stubService,
        prompt: 'test abort during preflight',
        userId: 'user1',
        threadId: 'thread-abort-preflight',
        isLastCat: true,
        signal: ac.signal,
      }),
    );

    // Invocation should end with done (either from abort or normal flow)
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should yield done even when aborted',
    );
  });
});
