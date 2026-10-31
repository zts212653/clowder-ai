/**
 * F089 → F117 KD-22 (J4): a member that stops producing output must not leave "正在回复中" hanging
 * forever when its service generator neither yields done nor throws. F089's outer 2× timer is
 * gone; the member output timeout (CLI_TIMEOUT_MS of silence) fires once and the Queue stops the
 * member through its signal with reason `timeout`, the way Stop does.
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

describe('member output timeout at the invocation (F089 → F117 KD-22)', () => {
  before(async () => {
    savedAuditLogDir = process.env.AUDIT_LOG_DIR;
    savedCliTimeoutMs = process.env.CLI_TIMEOUT_MS;
    const tempDir = await mkdtemp(join(tmpdir(), 'cat-inv-timeout-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    // A short member output timeout for testing: 200ms without output.
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
    };
  }

  /**
   * The Queue side of a member timeout: stop the member through its own signal with reason
   * `timeout`, the way QueueProcessor's stop hook cancels the slot (F117 KD-22).
   */
  function stoppedOnTimeout() {
    const controller = new AbortController();
    const fired = [];
    return {
      fired,
      signal: controller.signal,
      onMemberTimeout: (timeout) => {
        fired.push(timeout);
        controller.abort('timeout');
      },
    };
  }

  it('a member that never produces output again is stopped by its output timeout', async () => {
    // One output, then a stuck provider: without the member timeout this would block forever.
    const hangingService = {
      async *invoke() {
        yield { type: 'text', catId: 'codex', content: 'thinking...', timestamp: Date.now() };
        await new Promise(() => {});
      },
    };
    const stop = stoppedOnTimeout();

    const start = Date.now();
    const msgs = await withKeepAlive(
      collect(
        invokeSingleCat(makeDeps(), {
          catId: 'codex',
          service: hangingService,
          prompt: 'test',
          userId: 'user1',
          threadId: 'thread-hang',
          parentInvocationId: 'parent-exec-hang',
          isLastCat: true,
          signal: stop.signal,
          onMemberTimeout: stop.onMemberTimeout,
        }),
      ),
    );
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `should converge quickly, took ${elapsed}ms`);
    assert.equal(stop.fired.length, 1, 'the timeout fires once');
    assert.equal(stop.fired[0].executionId, 'parent-exec-hang', 'keyed by the Queue execution, not the child turn');
    assert.ok(stop.fired[0].diagnostics.silenceDurationMs >= 200);
    assert.equal(stop.fired[0].diagnostics.lastEventType, 'text');
    // The stop winds the run down like any Stop: always error + done.
    assert.ok(
      msgs.some((m) => m.type === 'error'),
      'the stop should produce an error event',
    );
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'the stop should always produce a done event',
    );
  });

  it('a stopped last member still yields done with isFinal=true', async () => {
    const hangingService = {
      async *invoke() {
        await new Promise(() => {});
      },
    };
    const stop = stoppedOnTimeout();

    const msgs = await withKeepAlive(
      collect(
        invokeSingleCat(makeDeps(), {
          catId: 'codex',
          service: hangingService,
          prompt: 'test',
          userId: 'user1',
          threadId: 'thread-final',
          isLastCat: true,
          signal: stop.signal,
          onMemberTimeout: stop.onMemberTimeout,
        }),
      ),
    );

    const doneMsg = msgs.find((m) => m.type === 'done');
    assert.ok(doneMsg, 'must have done event');
    assert.equal(doneMsg.isFinal, true, 'done should have isFinal=true for last cat');
  });

  it('CLI_TIMEOUT_MS=0 never times a member out', async () => {
    const savedTimeout = process.env.CLI_TIMEOUT_MS;
    process.env.CLI_TIMEOUT_MS = '0';
    try {
      // Output, then 300ms of silence (> the 200ms the other cases use), then done.
      const quietService = {
        async *invoke() {
          yield { type: 'text', catId: 'codex', content: 'hello', timestamp: Date.now() };
          await new Promise((r) => setTimeout(r, 300));
          yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
        },
      };
      const stop = stoppedOnTimeout();

      const msgs = await withKeepAlive(
        collect(
          invokeSingleCat(makeDeps(), {
            catId: 'codex',
            service: quietService,
            prompt: 'test',
            userId: 'user1',
            threadId: 'thread-zero-timeout',
            isLastCat: true,
            signal: stop.signal,
            onMemberTimeout: stop.onMemberTimeout,
          }),
        ),
      );

      assert.equal(stop.fired.length, 0, 'CLI_TIMEOUT_MS=0 arms no timeout');
      assert.ok(!msgs.some((m) => m.type === 'error'), 'the member finishes normally');
      assert.ok(
        msgs.some((m) => m.type === 'text' && m.content === 'hello'),
        'should receive events from service',
      );
    } finally {
      process.env.CLI_TIMEOUT_MS = savedTimeout;
    }
  });

  it('user cancel (AbortSignal) stops a member before its timeout', async () => {
    const ac = new AbortController();
    const hangingService = {
      async *invoke() {
        yield { type: 'text', catId: 'codex', content: 'hi', timestamp: Date.now() };
        await new Promise(() => {});
      },
    };

    // Cancel after 100ms — before the 200ms member timeout
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

    // Must always end with done
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'cancel should produce done event',
    );
    assert.ok(
      msgs.some((m) => m.type === 'error'),
      'cancel should produce error event',
    );
  });

  it('user cancel closes the abandoned service iterator exactly once', async () => {
    const ac = new AbortController();
    let returnCalls = 0;
    let emitted = false;
    const service = {
      invoke() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (!emitted) {
                  emitted = true;
                  return {
                    done: false,
                    value: { type: 'text', catId: 'codex', content: 'started', timestamp: Date.now() },
                  };
                }
                return new Promise(() => {});
              },
              async return() {
                returnCalls++;
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    };

    setTimeout(() => ac.abort('user_cancel'), 50);
    await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-cancel-cleanup',
        isLastCat: true,
        signal: ac.signal,
      }),
    );

    assert.equal(returnCalls, 1, 'abortableNext rejection must not abandon the provider iterator');
  });

  it('steady output keeps a member alive; heartbeats alone do not', async () => {
    const progressiveService = {
      async *invoke() {
        for (const tick of ['tick-1', 'tick-2', 'tick-3']) {
          yield { type: 'text', catId: 'codex', content: tick, timestamp: Date.now() };
          yield { type: 'status', catId: 'codex', content: 'working', timestamp: Date.now() };
          await new Promise((r) => setTimeout(r, 150));
        }
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    };
    const stop = stoppedOnTimeout();

    const msgs = await withKeepAlive(
      collect(
        invokeSingleCat(makeDeps(), {
          catId: 'codex',
          service: progressiveService,
          prompt: 'test',
          userId: 'user1',
          threadId: 'thread-progress',
          isLastCat: true,
          signal: stop.signal,
          onMemberTimeout: stop.onMemberTimeout,
        }),
      ),
      2_000,
    );

    assert.equal(stop.fired.length, 0, 'output every 150ms stays under the 200ms timeout');
    assert.equal(msgs.filter((m) => m.type === 'text').length, 3, 'should receive all progress events before done');
  });
});
