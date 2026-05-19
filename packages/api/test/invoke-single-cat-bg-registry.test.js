/**
 * F198 Phase C P1-1 fix: invoke-single-cat registers bg carrier sessions
 *
 * When a session_init with metadata.provider === 'claude-bg' arrives,
 * agentPaneRegistry.registerBgCarrier must be called with threadId + daemonShortId.
 * On invocation completion, markBgCarrierDone must be called.
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

describe('F198-C P1-1: registerBgCarrier called on claude-bg session_init', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-bg-registry-'));
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

  it('calls registerBgCarrier when session_init metadata.provider === claude-bg', async () => {
    const registeredCalls = [];
    const doneCalls = [];
    const mockRegistry = {
      registerBgCarrier: (opts) => registeredCalls.push(opts),
      markBgCarrierDone: (invocationId) => doneCalls.push(invocationId),
      getByInvocation: () => undefined, // not a tmux pane
    };

    const service = {
      async *invoke() {
        yield {
          type: 'session_init',
          catId: 'opus',
          sessionId: 'abcd1234',
          timestamp: Date.now(),
          metadata: { provider: 'claude-bg', model: 'claude-opus-4-7' },
        };
        yield { type: 'text', catId: 'opus', content: 'done', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(
        { ...makeDeps(), agentPaneRegistry: mockRegistry },
        {
          catId: 'opus',
          service,
          prompt: 'test prompt',
          userId: 'user-1',
          threadId: 'thread-bg-1',
          isLastCat: true,
        },
      ),
    );

    assert.equal(registeredCalls.length, 1, 'registerBgCarrier must be called exactly once');
    assert.equal(
      registeredCalls[0].daemonShortId,
      'abcd1234',
      'must register with daemon shortId from session_init.sessionId',
    );
    assert.equal(registeredCalls[0].threadId, 'thread-bg-1', 'must register with the invocation threadId');
    assert.equal(registeredCalls[0].catId, 'opus', 'must register with catId');
    assert.ok(registeredCalls[0].invocationId, 'must register with invocationId');
  });

  it('does NOT call registerBgCarrier for non-claude-bg session_init', async () => {
    const registeredCalls = [];
    const mockRegistry = {
      registerBgCarrier: (opts) => registeredCalls.push(opts),
      markBgCarrierDone: () => {},
      getByInvocation: () => undefined,
    };

    const service = {
      async *invoke() {
        // session_init with no metadata (regular CLI provider)
        yield {
          type: 'session_init',
          catId: 'opus',
          sessionId: 'cli-session-xyz',
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: 'hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(
        { ...makeDeps(), agentPaneRegistry: mockRegistry },
        {
          catId: 'opus',
          service,
          prompt: 'test',
          userId: 'user-1',
          threadId: 'thread-cli-1',
          isLastCat: true,
        },
      ),
    );

    assert.equal(registeredCalls.length, 0, 'registerBgCarrier must NOT be called for non-claude-bg session_init');
  });

  it('calls markBgCarrierDone after claude-bg invocation completes', async () => {
    const doneCalls = [];
    let registeredInvocationId = null;
    const mockRegistry = {
      registerBgCarrier: (opts) => {
        registeredInvocationId = opts.invocationId;
      },
      markBgCarrierDone: (invocationId) => doneCalls.push(invocationId),
      getByInvocation: () => undefined,
    };

    const service = {
      async *invoke() {
        yield {
          type: 'session_init',
          catId: 'opus',
          sessionId: 'done1234',
          timestamp: Date.now(),
          metadata: { provider: 'claude-bg', model: 'claude-opus-4-7' },
        };
        yield { type: 'text', catId: 'opus', content: 'result', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(
        { ...makeDeps(), agentPaneRegistry: mockRegistry },
        {
          catId: 'opus',
          service,
          prompt: 'test',
          userId: 'user-1',
          threadId: 'thread-done',
          isLastCat: true,
        },
      ),
    );

    assert.ok(registeredInvocationId, 'must have been registered first');
    assert.ok(
      doneCalls.includes(registeredInvocationId),
      'markBgCarrierDone must be called with the registered invocationId',
    );
  });

  it('active-pane returns 404 when no bg carrier registered (baseline)', async () => {
    // Confirms getBgCarrierByThread returns undefined for unregistered thread
    // (AgentPaneRegistry unit test already covers this; included here for integration visibility)
    const { AgentPaneRegistry } = await import('../dist/domains/terminal/agent-pane-registry.js');
    const registry = new AgentPaneRegistry();
    assert.equal(registry.getBgCarrierByThread('thread-not-registered'), undefined);
  });
});
