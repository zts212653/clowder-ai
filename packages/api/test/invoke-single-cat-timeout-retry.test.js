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
let SessionChainStore;

describe('#774 CLI timeout retry on session resume', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-timeout-retry-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
    ({ SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js'));
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

  function makeManagedSessionStore({ threadId, cliSessionId, onUpdate }) {
    const store = new SessionChainStore();
    store.create({
      cliSessionId,
      threadId,
      catId: 'codex',
      userId: 'u1',
    });
    if (onUpdate) {
      const update = store.update.bind(store);
      store.update = (id, patch) => {
        onUpdate(id, patch);
        return update(id, patch);
      };
    }
    return store;
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
      sessionChainStore: makeManagedSessionStore({
        threadId: 't-timeout-retry',
        cliSessionId: 'cli-sess-stale',
      }),
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

  it('resume + context-window overflow + no substantive output → drops session and retries fresh', async () => {
    let attempt = 0;
    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, opts) {
        attempt++;
        optionsSeen.push(opts);
        if (opts?.sessionId) {
          yield {
            type: 'error',
            catId: 'codex',
            error:
              "Codex CLI: CLI 异常退出 (code: 1, signal: none)\n最近流错误:\n- Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        } else {
          yield { type: 'text', catId: 'codex', content: 'continued in fresh session', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        }
      },
    };

    const sessionDeletes = [];
    const updateCalls = [];
    const deps = makeDeps({
      sessionManager: {
        get: async () => 'cli-sess-full',
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async (userId, catId, threadId) => {
          sessionDeletes.push(`${userId}:${catId}:${threadId}`);
        },
        resolveWorkingDirectory: () => '/tmp/test',
      },
      sessionChainStore: makeManagedSessionStore({
        threadId: 't-overflow-retry',
        cliSessionId: 'cli-sess-full',
        onUpdate: (id, patch) => updateCalls.push({ id, patch }),
      }),
      sessionSealer: {
        reconcileStuck: async () => {},
      },
    });

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test overflow retry',
        userId: 'u1',
        threadId: 't-overflow-retry',
        systemPrompt: 'system identity',
      }),
    );

    assert.equal(attempt, 2, 'should retry once after dropping the poisoned resumed session');
    assert.equal(optionsSeen[0].sessionId, 'cli-sess-full', 'first attempt should resume');
    assert.equal(optionsSeen[1].sessionId, undefined, 'retry should be fresh');
    assert.deepEqual(sessionDeletes, ['u1:codex:t-overflow-retry'], 'should delete stale session before retry');
    assert.ok(
      updateCalls.some((call) => call.patch.consecutiveRestoreFailures === 1),
      'should increment restore failure count before retry',
    );
    assert.ok(
      msgs.some((m) => m.type === 'text' && m.content === 'continued in fresh session'),
      'fresh retry result should be streamed',
    );
    assert.equal(
      msgs.some((m) => m.type === 'error' && String(m.error).includes('ran out of room')),
      false,
      'first-attempt overflow error should be suppressed when retry succeeds',
    );
  });

  it('resume + timeout + substantive model output → does NOT retry', async () => {
    let attempt = 0;
    const service = {
      async *invoke(_prompt, _opts) {
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
      sessionChainStore: makeManagedSessionStore({
        threadId: 't-no-retry-substantive',
        cliSessionId: 'cli-sess-active',
      }),
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

  // F212 Phase H R1 P1-2 (Sol runtime forensics 2026-07-10): the REAL 217969a7 archive
  // pattern lives at the invoke-single-cat layer, not inside a single spawnCli iteration.
  // The archived sequence:
  //   1. Attempt #1: thread.started → turn.started → 6× error → turn.failed → __cliError (transient CLI exit)
  //   2. invoke-single-cat suppresses the transient error (isTransientCliExitCode1) and retries
  //   3. Attempt #2: thread.started → turn.started → item.completed → turn.completed → success
  // My earlier codex-agent-service.test.js `archive 217969a7 recovery pattern` test compressed
  // both attempts into a single mock process which does NOT reflect the real control flow.
  // It was refactored to `semanticDone contract` (still valid but honestly named). This test
  // covers the authentic retry boundary at the correct layer.
  // Provenance: cat-cafe-runtime/packages/api/data/cli-raw-archive/2026-07-09/217969a7-*.ndjson
  it('F212 Phase H R1 P1-2 archive 217969a7 authentic pattern: transient exit-1 → retry → success', async () => {
    let attempt = 0;
    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, opts) {
        attempt++;
        optionsSeen.push(opts);
        if (attempt === 1) {
          // Attempt #1: mirrors real archive first spawn — six transient upstream error
          // events + turn.failed + cli-spawn synthesizes __cliError with the F212
          // canonical "CLI 异常退出" message that isTransientCliExitCode1 matches on.
          for (let i = 0; i < 6; i++) {
            yield {
              type: 'system_info',
              catId: 'codex',
              content: JSON.stringify({ type: 'stream_error', message: 'stream disconnected before completion' }),
              timestamp: Date.now(),
            };
          }
          yield {
            type: 'error',
            catId: 'codex',
            error: 'CLI 异常退出 (code: 1, signal: none)',
            metadata: {
              cliDiagnostics: {
                reasonCode: undefined,
                publicSummary: '未识别的 CLI 错误',
                publicHint: '重试或换猫',
                safeExcerpt: 'stream disconnected before completion',
                debugRef: { command: 'codex', exitCode: 1, signal: null },
              },
            },
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        } else {
          // Attempt #2: fresh spawn, semantic success (item.completed + turn.completed
          // → canonical semanticDone → cli-spawn does NOT synthesize __cliError even
          // if the shell exits 1 as the Codex 0.98+ quirk).
          yield {
            type: 'text',
            catId: 'codex',
            content: 'Recovered result after transient exit retry.',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        }
      },
    };

    // Session resume path (matches archive: existing runtime session cliSessionId).
    const deps = makeDeps({
      sessionChainStore: makeManagedSessionStore({
        threadId: 't-archive-217969a7',
        cliSessionId: 'cli-sess-217969a7',
      }),
      sessionSealer: {
        reconcileStuck: async () => {},
      },
    });

    const params = {
      catId: 'codex',
      userId: 'u1',
      threadId: 't-archive-217969a7',
      prompt: 'archive-driven retry pattern',
      service,
    };

    const msgs = await collect(invokeSingleCat(deps, params));

    // The invariant: two SEPARATE service.invoke() calls, second yields recovered text.
    assert.equal(attempt, 2, 'authentic 217969a7 pattern requires two separate service.invoke calls');

    // Attempt #1 transient error must NOT appear as a persisted user-visible error —
    // the retry path swallowed it. Only the recovered text should surface.
    const textMsgs = msgs.filter((m) => m.type === 'text');
    assert.ok(textMsgs.length > 0, 'recovered text from attempt #2 must reach consumer');
    assert.ok(
      textMsgs.some((m) => m.content === 'Recovered result after transient exit retry.'),
      'the exact recovered content should be yielded',
    );

    // Attempt #1's transient error must be suppressed (not yielded as user-facing error)
    // since retry succeeded. This is the authentic 217969a7 outcome.
    const errors = msgs.filter((m) => m.type === 'error');
    assert.equal(
      errors.length,
      0,
      'transient exit-1 must be suppressed when retry succeeds (matches archive 217969a7 real outcome)',
    );
  });
});
