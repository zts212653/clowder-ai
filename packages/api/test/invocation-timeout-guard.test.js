/**
 * F089: Invocation-level hard timeout guard
 *
 * Regression tests for the invocation timeout that prevents "正在回复中" from
 * hanging forever when the service generator neither yields done nor throws.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

async function withKeepAlive(promise, ms = 1_000) {
  const keepAlive = setTimeout(() => {}, ms);
  try {
    return await promise;
  } finally {
    clearTimeout(keepAlive);
  }
}

let invokeSingleCat;
let savedAuditLogDir;
let savedCliTimeoutMs;

describe('invocation-level hard timeout (F089)', () => {
  before(async () => {
    savedAuditLogDir = process.env.AUDIT_LOG_DIR;
    savedCliTimeoutMs = process.env.CLI_TIMEOUT_MS;
    const tempDir = await mkdtemp(join(tmpdir(), 'cat-inv-timeout-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    // Override CLI_TIMEOUT_MS to make invocation timeout short for testing.
    // Invocation timeout = CLI_TIMEOUT_MS * 2 = 400ms
    process.env.CLI_TIMEOUT_MS = '200';
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  after(() => {
    if (savedAuditLogDir === undefined) delete process.env.AUDIT_LOG_DIR;
    else process.env.AUDIT_LOG_DIR = savedAuditLogDir;
    if (savedCliTimeoutMs === undefined) delete process.env.CLI_TIMEOUT_MS;
    else process.env.CLI_TIMEOUT_MS = savedCliTimeoutMs;
  });

  function makeDeps() {
    let counter = 0;
    return {
      registry: {
        create: () => ({ invocationId: `inv-timeout-${++counter}`, callbackToken: `tok-${counter}` }),
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
      apiUrl: 'http://127.0.0.1:3004',
    };
  }

  it('service that never yields done converges via invocation timeout', async () => {
    // A service that emits one content event then hangs forever.
    // Without the invocation timeout, this would block forever.
    const hangingService = {
      async *invoke() {
        yield { type: 'text', catId: 'codex', content: 'thinking...', timestamp: Date.now() };
        // Hang indefinitely — simulates a stuck CLI/provider
        await new Promise(() => {});
      },
    };

    const start = Date.now();
    const msgs = await withKeepAlive(
      collect(
        invokeSingleCat(makeDeps(), {
          catId: 'codex',
          service: hangingService,
          prompt: 'test',
          userId: 'user1',
          threadId: 'thread-hang',
          isLastCat: true,
        }),
      ),
    );
    const elapsed = Date.now() - start;

    // Should have converged within a reasonable time (invocation timeout = 400ms)
    assert.ok(elapsed < 5000, `should converge quickly, took ${elapsed}ms`);

    // Must always end with error + done
    const hasError = msgs.some((m) => m.type === 'error');
    const hasDone = msgs.some((m) => m.type === 'done');
    assert.ok(hasError, 'timeout should produce an error event');
    assert.ok(hasDone, 'timeout should always produce a done event');
  });

  it('timeout yields done with isFinal=true for last cat', async () => {
    const hangingService = {
      async *invoke() {
        await new Promise(() => {});
      },
    };

    const msgs = await withKeepAlive(
      collect(
        invokeSingleCat(makeDeps(), {
          catId: 'codex',
          service: hangingService,
          prompt: 'test',
          userId: 'user1',
          threadId: 'thread-final',
          isLastCat: true,
        }),
      ),
    );

    const doneMsg = msgs.find((m) => m.type === 'done');
    assert.ok(doneMsg, 'must have done event');
    assert.equal(doneMsg.isFinal, true, 'done should have isFinal=true for last cat');
  });

  it('CLI_TIMEOUT_MS=0 does not produce instant invocation timeout', async () => {
    // When CLI_TIMEOUT_MS=0 (meaning "disable CLI timeout"), invocation timeout
    // must NOT become 0ms. It should fall back to a sane maximum.
    const savedTimeout = process.env.CLI_TIMEOUT_MS;
    process.env.CLI_TIMEOUT_MS = '0';
    try {
      // Re-import to pick up new env value
      const freshMod = await import(
        `../dist/domains/cats/services/agents/invocation/invoke-single-cat.js?t=${Date.now()}`
      );
      const freshInvoke = freshMod.invokeSingleCat;

      // A service that yields one event then completes quickly (50ms).
      // If invocation timeout is 0ms, this would be killed before it finishes.
      const quickService = {
        async *invoke() {
          yield { type: 'text', catId: 'codex', content: 'hello', timestamp: Date.now() };
          await new Promise((r) => setTimeout(r, 50));
          yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
        },
      };

      const msgs = await collect(
        freshInvoke(makeDeps(), {
          catId: 'codex',
          service: quickService,
          prompt: 'test',
          userId: 'user1',
          threadId: 'thread-zero-timeout',
          isLastCat: true,
        }),
      );

      // The service should complete normally — no error from invocation timeout
      const hasInvocationError = msgs.some((m) => m.type === 'error' && m.error?.includes?.('invocation_timeout'));
      assert.ok(!hasInvocationError, 'CLI_TIMEOUT_MS=0 should not produce invocation_timeout error');

      // Should have the text event from the service
      const hasText = msgs.some((m) => m.type === 'text' && m.content === 'hello');
      assert.ok(hasText, 'should receive events from service');
    } finally {
      process.env.CLI_TIMEOUT_MS = savedTimeout;
    }
  });

  it('user cancel (AbortSignal) still works alongside invocation timeout', async () => {
    const ac = new AbortController();
    const hangingService = {
      async *invoke() {
        yield { type: 'text', catId: 'codex', content: 'hi', timestamp: Date.now() };
        await new Promise(() => {});
      },
    };

    // Cancel after 100ms — should be faster than invocation timeout (400ms)
    setTimeout(() => ac.abort(), 100);

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'codex',
        service: hangingService,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-cancel',
        isLastCat: true,
        signal: ac.signal,
      }),
    );

    // Must always end with done — regardless of whether user cancel or invocation timeout triggered
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'cancel should produce done event',
    );
    assert.ok(
      msgs.some((m) => m.type === 'error'),
      'cancel should produce error event',
    );
  });
});
