/**
 * F198 Phase C P2-1 fix: 'status' messages must be non-substantive
 *
 * 'status' messages (daemon detail progress) must NOT:
 *   1. Reset the invocation timeout (causes "forever" with endless status updates)
 *   2. Set attemptHasContentOutput / attemptHasSubstantiveOutput
 *      (would prevent retry when the only output before a timeout was status messages)
 *
 * This test validates property (2) via retry behavior:
 * if status IS treated as substantive, the retry won't fire.
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

describe('F198-C P2-1: status messages treated as non-substantive', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-bg-status-'));
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
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => 'stale-cli-session',
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

  it('retry fires after status-only attempt + CLI timeout (status does not block retry)', async () => {
    // If 'status' messages set attemptHasSubstantiveOutput, the retry guard at:
    //   if (allowSessionRetry && options.sessionId && !attemptHasSubstantiveOutput && isCliTimeoutError)
    // would NOT suppress the timeout error, and retry would NOT fire.
    let attemptCount = 0;
    const service = {
      async *invoke(_prompt, _opts) {
        attemptCount++;
        if (attemptCount === 1) {
          // First attempt: only status messages, then timeout error
          yield {
            type: 'status',
            catId: 'opus',
            content: 'reading F198 spec...',
            timestamp: Date.now(),
          };
          yield {
            type: 'status',
            catId: 'opus',
            content: 'loading context...',
            timestamp: Date.now(),
          };
          yield {
            type: 'error',
            catId: 'opus',
            error: '缅因猫 CLI 响应超时 (300s, 未收到首帧)',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        } else {
          // Second attempt: fresh session produces real output
          yield { type: 'text', catId: 'opus', content: 'recovered output', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }
      },
    };

    const deps = makeDeps({
      sessionChainStore: {
        getChain: () => [
          {
            id: 'sess-1',
            cliSessionId: 'stale-cli-session',
            status: 'active',
            consecutiveRestoreFailures: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        getActive: async () => ({
          id: 'sess-1',
          cliSessionId: 'stale-cli-session',
          status: 'active',
          consecutiveRestoreFailures: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
        update: async () => {},
        create: async () => ({ id: 'sess-2', cliSessionId: null }),
      },
    });

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test prompt',
        userId: 'user-1',
        threadId: 'thread-status-retry',
        isLastCat: true,
        sessionId: 'stale-cli-session',
      }),
    );

    assert.equal(attemptCount, 2, 'must retry: status messages alone must not prevent retry on timeout');
    const textMsgs = msgs.filter((m) => m.type === 'text');
    assert.ok(
      textMsgs.some((m) => m.content === 'recovered output'),
      'must contain recovered output from retry attempt',
    );
  });

  it('status messages pass through to caller (not dropped)', async () => {
    // Verify 'status' is delivered downstream; it must not be silently discarded
    const service = {
      async *invoke() {
        yield {
          type: 'status',
          catId: 'opus',
          content: 'processing...',
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: 'result', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user-1',
        threadId: 'thread-status-passthrough',
        isLastCat: true,
      }),
    );

    const statusMsgs = msgs.filter((m) => m.type === 'status');
    assert.ok(statusMsgs.length >= 1, 'status messages must pass through to caller');
    assert.equal(statusMsgs[0].content, 'processing...');
  });
});
