/**
 * #1211 self-heal: ACP provider-busy → release carrier + retry fresh
 *
 * When an ACP provider rejects a prompt because an earlier turn is still active,
 * invoke-single-cat must drop the unsafe session/carrier and retry with a fresh
 * session, but only when no substantive model output has been produced.
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

describe('#1211 ACP provider-busy retry', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-busy-retry-'));
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
        get: async () => 'cli-sess-busy',
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

  it('resume + provider_busy + no substantive output → drops session and retries fresh', async () => {
    let attempt = 0;
    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, opts) {
        attempt++;
        optionsSeen.push(opts);
        if (opts?.sessionId) {
          // First attempt: resumed session is busy.
          yield {
            type: 'error',
            catId: 'kimi',
            error:
              'provider_busy: ACP error -32600: Invalid request: Cannot launch a new turn while another turn (ID 6) is active',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'kimi', timestamp: Date.now() };
        } else {
          // Second attempt: fresh session succeeds.
          yield { type: 'text', catId: 'kimi', content: 'recovered after busy', timestamp: Date.now() };
          yield { type: 'done', catId: 'kimi', timestamp: Date.now() };
        }
      },
    };

    const sessionDeletes = [];
    const deps = makeDeps({
      sessionManager: {
        get: async () => 'cli-sess-busy',
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async (userId, catId, threadId) => {
          sessionDeletes.push(`${userId}:${catId}:${threadId}`);
        },
        resolveWorkingDirectory: () => '/tmp/test',
      },
      sessionChainStore: {
        getChain: () => [
          {
            id: 'sess-busy',
            cliSessionId: 'cli-sess-busy',
            status: 'active',
            consecutiveRestoreFailures: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        getActive: async () => ({
          id: 'sess-busy',
          cliSessionId: 'cli-sess-busy',
          consecutiveRestoreFailures: 0,
        }),
        update: async () => {},
      },
      sessionSealer: {
        reconcileStuck: async () => {},
      },
    });

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'kimi',
        service,
        prompt: 'test busy retry',
        userId: 'u1',
        threadId: 't-busy-retry',
        systemPrompt: 'system identity',
      }),
    );

    assert.equal(attempt, 2, 'should retry once after dropping the busy session');
    assert.equal(optionsSeen[0].sessionId, 'cli-sess-busy', 'first attempt should resume');
    assert.equal(optionsSeen[1].sessionId, undefined, 'retry should be fresh');
    assert.deepEqual(sessionDeletes, ['u1:kimi:t-busy-retry'], 'should delete busy session before retry');
    assert.ok(
      msgs.some((m) => m.type === 'text' && m.content === 'recovered after busy'),
      'fresh retry result should be streamed',
    );
    assert.equal(
      msgs.some((m) => m.type === 'error' && String(m.error).includes('Cannot launch a new turn')),
      false,
      'first-attempt busy error should be suppressed when retry succeeds',
    );
  });

  it('provider_busy + substantive model output → does NOT retry', async () => {
    let attempt = 0;
    const service = {
      async *invoke() {
        attempt++;
        // A stale turn notification or genuine partial output arrives before busy.
        yield { type: 'text', catId: 'kimi', content: 'stale or partial output', timestamp: Date.now() };
        yield {
          type: 'error',
          catId: 'kimi',
          error:
            'provider_busy: ACP error -32600: Invalid request: Cannot launch a new turn while another turn (ID 6) is active',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'kimi', timestamp: Date.now() };
      },
    };

    const deps = makeDeps({
      sessionChainStore: {
        getChain: () => [
          {
            id: 'sess-busy-output',
            cliSessionId: 'cli-sess-busy-output',
            status: 'active',
            consecutiveRestoreFailures: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        getActive: async () => ({
          id: 'sess-busy-output',
          consecutiveRestoreFailures: 0,
        }),
        update: async () => {},
      },
      sessionSealer: {
        reconcileStuck: async () => {},
      },
    });

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'kimi',
        service,
        prompt: 'test busy no retry',
        userId: 'u1',
        threadId: 't-busy-no-retry',
      }),
    );

    assert.equal(attempt, 1, 'should not retry when substantive output was already produced');
    assert.ok(
      msgs.some((m) => m.type === 'error' && String(m.error).includes('Cannot launch a new turn')),
      'busy error should be delivered when retry is skipped',
    );
    assert.ok(
      msgs.some((m) => m.type === 'text' && m.content === 'stale or partial output'),
      'existing output must still be delivered',
    );
  });

  it('no sessionId + provider_busy + no output → retries once with fresh carrier', async () => {
    let attempt = 0;
    const service = {
      async *invoke() {
        attempt++;
        yield {
          type: 'error',
          catId: 'kimi',
          error:
            'provider_busy: ACP error -32600: Invalid request: Cannot launch a new turn while another turn (ID 6) is active',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'kimi', timestamp: Date.now() };
      },
    };

    const deps = makeDeps({
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
    });

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'kimi',
        service,
        prompt: 'test busy no session',
        userId: 'u1',
        threadId: 't-busy-no-session',
      }),
    );

    // maxAttempts=2 allows exactly one recovery, even without a resumable session.
    assert.equal(attempt, 2, 'should retry once with a fresh carrier');
    assert.ok(
      msgs.some((m) => m.type === 'error' && String(m.error).includes('Cannot launch a new turn')),
      'busy error should be delivered after retries are exhausted',
    );
  });
});
