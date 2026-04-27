/**
 * #774 self-heal: CLI timeout during session resume → drop session + retry
 *
 * When a CLI times out during session resume and has produced no substantive
 * output (text/tool), the invocation should drop the session and retry fresh.
 * system_info (e.g. timeout_diagnostics) must NOT block the retry path.
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

describe('#774 CLI timeout retry on session resume', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-timeout-retry-'));
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
        get: async () => 'cli-sess-stale',
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

  it('resume + timeout + only system_info → drops session and retries fresh', async () => {
    let attempt = 0;
    const service = {
      async *invoke(_prompt, opts) {
        attempt++;
        if (opts?.sessionId) {
          // First attempt: resume → timeout_diagnostics (system_info) + timeout error
          yield {
            type: 'system_info',
            catId: 'codex',
            content: JSON.stringify({ type: 'timeout_diagnostics', firstEventAt: null }),
            timestamp: Date.now(),
          };
          yield {
            type: 'error',
            catId: 'codex',
            error: '缅因猫 CLI 响应超时 (300s, 未收到首帧)',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        } else {
          // Second attempt: fresh session → success
          yield { type: 'text', catId: 'codex', content: 'recovered!', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        }
      },
    };

    const deps = makeDeps({
      sessionChainStore: {
        getChain: () => [
          {
            id: 'sess-stale',
            cliSessionId: 'cli-sess-stale',
            status: 'active',
            consecutiveRestoreFailures: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        getActive: async () => ({
          id: 'sess-stale',
          consecutiveRestoreFailures: 0,
        }),
        update: async () => {},
      },
      sessionSealer: {
        reconcileStuck: async () => {},
      },
    });

    const params = {
      catId: 'codex',
      userId: 'u1',
      threadId: 't-timeout-retry',
      prompt: 'test timeout retry',
      service,
    };

    const msgs = await collect(invokeSingleCat(deps, params));

    // Should have retried: attempt 1 (timeout) + attempt 2 (success)
    assert.equal(attempt, 2, 'should have made 2 attempts');

    // Should contain the recovered text from the fresh attempt
    const textMsgs = msgs.filter((m) => m.type === 'text');
    assert.ok(textMsgs.length > 0, 'should have text output from retry');
    assert.ok(
      textMsgs.some((m) => m.content === 'recovered!'),
      'should have recovered text',
    );
  });

  it('resume + timeout + substantive model output → does NOT retry', async () => {
    let attempt = 0;
    const service = {
      async *invoke(_prompt, opts) {
        attempt++;
        // Has real model output before timeout → should not retry
        yield { type: 'text', catId: 'codex', content: 'partial work', timestamp: Date.now() };
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({ type: 'timeout_diagnostics', firstEventAt: Date.now() }),
          timestamp: Date.now(),
        };
        yield {
          type: 'error',
          catId: 'codex',
          error: '缅因猫 CLI 响应超时 (300s)',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const deps = makeDeps({
      sessionChainStore: {
        getChain: () => [
          {
            id: 'sess-active',
            cliSessionId: 'cli-sess-active',
            status: 'active',
            consecutiveRestoreFailures: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        getActive: async () => ({
          id: 'sess-active',
          consecutiveRestoreFailures: 0,
        }),
        update: async () => {},
      },
      sessionSealer: {
        reconcileStuck: async () => {},
      },
    });

    const params = {
      catId: 'codex',
      userId: 'u1',
      threadId: 't-no-retry-substantive',
      prompt: 'test no retry with output',
      service,
    };

    const msgs = await collect(invokeSingleCat(deps, params));

    // Should NOT have retried — substantive output means session was working
    assert.equal(attempt, 1, 'should have made only 1 attempt');

    // Error should be present (not suppressed)
    const errors = msgs.filter((m) => m.type === 'error');
    assert.ok(errors.length > 0, 'timeout error should be delivered');
  });

  it('no sessionId + timeout → does NOT retry', async () => {
    let attempt = 0;
    const service = {
      async *invoke() {
        attempt++;
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({ type: 'timeout_diagnostics', firstEventAt: null }),
          timestamp: Date.now(),
        };
        yield {
          type: 'error',
          catId: 'codex',
          error: '缅因猫 CLI 响应超时 (300s, 未收到首帧)',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    // sessionManager returns undefined → no session to resume
    const deps = makeDeps({
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
    });

    const params = {
      catId: 'codex',
      userId: 'u1',
      threadId: 't-no-session',
      prompt: 'test no retry without session',
      service,
    };

    const msgs = await collect(invokeSingleCat(deps, params));

    // Should NOT retry — no session means timeout is genuine, not a resume issue
    assert.equal(attempt, 1, 'should have made only 1 attempt');

    // Error should be present
    const errors = msgs.filter((m) => m.type === 'error');
    assert.ok(errors.length > 0, 'timeout error should be delivered');
  });
});
