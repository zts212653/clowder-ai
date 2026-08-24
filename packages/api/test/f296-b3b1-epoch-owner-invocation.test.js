import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';

const CODEX_EXEC = {
  provider: 'openai',
  carrier: 'exec_json',
  reportsRuntimeWindow: true,
  authoritativeUsage: true,
  usageTelemetry: 'available',
  nativeWindowControl: true,
  nativeCompressionControl: true,
  observesCompression: false,
  reason: 'fixture',
};

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

function parseContinuity(messages) {
  return messages.flatMap((message) => {
    if (message.type !== 'system_info' || !message.content) return [];
    try {
      const parsed = JSON.parse(message.content);
      return parsed.type === 'context_continuity' ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

test('F296 B3b-1 resolves the epoch owner before the provider consumes the prompt', async () => {
  const timeline = [];
  const contextEpochOwner = {
    async resolve(input) {
      timeline.push('epoch-owner');
      assert.equal(input.disposition.state, 'fresh');
      return {
        scopeKey: 'owner-1::codex::thread-f296',
        contextEpoch: 1,
        contextMode: 'cold',
        lastTransitionRef: input.disposition.evidenceRef,
        consumedCompactionEventIds: [],
        transition: 'scope_first_seen',
        normalizedDisposition: input.disposition,
        healthSignals: [],
      };
    },
  };
  const service = {
    contextCapability: () => CODEX_EXEC,
    async *invoke() {
      timeline.push('provider-start');
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
  const deps = {
    registry: {
      create: async () => ({ invocationId: 'inv-f296-epoch', callbackToken: 'token-f296' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    contextEpochOwner,
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
  };

  const messages = await collect(
    invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'cold prompt',
      userId: 'owner-1',
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-f296',
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
      isLastCat: true,
    }),
  );

  assert.deepEqual(timeline, ['epoch-owner', 'provider-start']);
  const [continuity] = parseContinuity(messages);
  assert.equal(continuity.contextMode, 'cold');
  assert.equal(continuity.contextEpoch, 1);
  assert.equal(continuity.transition, 'scope_first_seen');
});

test('F296 B3b-1 freezes prompt text and exposure ids only after the epoch decision', async () => {
  const timeline = [];
  const exposed = [];
  const contextEpochOwner = {
    async resolve(input) {
      timeline.push('epoch-owner');
      return {
        scopeKey: 'owner-1::codex::thread-f296',
        contextEpoch: 7,
        contextMode: 'cold',
        lastTransitionRef: input.disposition.evidenceRef,
        consumedCompactionEventIds: [],
        transition: 'unknown',
        normalizedDisposition: input.disposition,
        healthSignals: [],
      };
    },
  };
  const service = {
    contextCapability: () => CODEX_EXEC,
    async *invoke(prompt) {
      timeline.push('provider-start');
      assert.equal(prompt, 'factory-cold-prompt');
      assert.ok(!prompt.includes('route-prebuilt'));
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
  const deps = {
    registry: {
      create: async () => ({ invocationId: 'inv-f296-factory', callbackToken: 'token-f296' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    contextEpochOwner,
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
  };

  await collect(
    invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'route-prebuilt-must-not-reach-provider',
      contextPromptFactory: async ({ decision, handshake }) => {
        timeline.push('prompt-factory');
        assert.equal(decision.contextEpoch, 7);
        assert.equal(decision.contextMode, 'cold');
        assert.equal(handshake.disposition.state, 'fresh');
        return {
          prompt: 'factory-cold-prompt',
          promptMessageIds: ['msg-final'],
        };
      },
      promptMessageIds: ['msg-stale'],
      onPromptMessagesExposed: async (input) => {
        timeline.push('exposure');
        exposed.push(...input.messageIds);
      },
      userId: 'owner-1',
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-f296',
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
      isLastCat: true,
    }),
  );

  assert.deepEqual(timeline, ['epoch-owner', 'prompt-factory', 'exposure', 'provider-start']);
  assert.deepEqual(exposed, ['msg-final']);
});

test('F296 B3b-1 replaces the factory projection after a stale-session generation fails', async () => {
  const decisions = [];
  const factoryEpochs = [];
  const providerPrompts = [];
  const exposed = [];
  let invokeCount = 0;
  const contextEpochOwner = {
    async resolve(input) {
      decisions.push([input.disposition.state, input.disposition.reason]);
      const contextEpoch = decisions.length;
      return {
        scopeKey: 'owner-1::codex::thread-f296',
        contextEpoch,
        contextMode: 'cold',
        lastTransitionRef: input.disposition.evidenceRef,
        consumedCompactionEventIds: [],
        transition: input.disposition.state === 'fresh' ? 'fresh' : 'scope_first_seen',
        normalizedDisposition: input.disposition,
        healthSignals: [],
      };
    },
  };
  const service = {
    contextCapability: () => CODEX_EXEC,
    async *invoke(prompt) {
      providerPrompts.push(prompt);
      invokeCount += 1;
      if (invokeCount === 1) {
        yield {
          type: 'error',
          catId: 'codex',
          error: 'No conversation found with session ID: stale-runtime-session',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        return;
      }
      yield { type: 'text', catId: 'codex', content: 'recovered', timestamp: Date.now() };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
  const deps = {
    registry: {
      create: async () => ({ invocationId: 'inv-f296-replacement', callbackToken: 'token-f296' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => 'stale-runtime-session',
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    contextEpochOwner,
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
  };

  await collect(
    invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'route-placeholder',
      contextPromptFactory: async ({ decision }) => {
        factoryEpochs.push(decision.contextEpoch);
        return {
          prompt: `projection-epoch-${decision.contextEpoch}`,
          promptMessageIds: [`msg-epoch-${decision.contextEpoch}`],
        };
      },
      promptMessageIds: ['msg-stale-route'],
      onPromptMessagesExposed: async (input) => exposed.push(...input.messageIds),
      userId: 'owner-1',
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-f296',
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
      isLastCat: true,
    }),
  );

  assert.deepEqual(decisions, [
    ['unknown', 'signal_unavailable'],
    ['fresh', 'resume_failed'],
  ]);
  assert.deepEqual(factoryEpochs, [1, 2]);
  assert.equal(providerPrompts.length, 2);
  assert.match(providerPrompts[0], /projection-epoch-1/);
  assert.doesNotMatch(providerPrompts[0], /route-placeholder/);
  assert.match(providerPrompts[1], /projection-epoch-2/);
  assert.doesNotMatch(providerPrompts[1], /projection-epoch-1/);
  assert.deepEqual(exposed, ['msg-epoch-1', 'msg-epoch-2']);
});

test('F296 B3b-4 treats the epoch-aware prompt factory as threshold-seal continuity bootstrap', async () => {
  const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
  const sessionChainStore = new SessionChainStore();
  const sealCalls = [];
  const contextEpochOwner = {
    async resolve(input) {
      return {
        scopeKey: 'owner-1::codex::thread-f296-threshold',
        contextEpoch: 1,
        contextMode: 'cold',
        lastTransitionRef: input.disposition.evidenceRef,
        consumedCompactionEventIds: [],
        transition: 'scope_first_seen',
        normalizedDisposition: input.disposition,
        healthSignals: [],
      };
    },
  };
  const service = {
    contextCapability: () => CODEX_EXEC,
    async *invoke() {
      yield {
        type: 'done',
        catId: 'codex',
        timestamp: Date.now(),
        metadata: {
          provider: 'openai',
          model: 'gpt-5.5',
          usage: {
            contextUsedTokens: 90_000,
            lastTurnInputTokens: 90_000,
            outputTokens: 100,
            contextWindowSize: 100_000,
          },
        },
      };
    },
  };
  const deps = {
    registry: {
      create: async () => ({ invocationId: 'inv-f296-threshold', callbackToken: 'token-f296' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    sessionChainStore,
    sessionSealer: {
      requestSeal: async (input) => {
        sealCalls.push(input);
        return { accepted: true, status: 'sealing' };
      },
      finalize: async () => {},
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    },
    contextEpochOwner,
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
  };

  const messages = await collect(
    invokeSingleCat(deps, {
      catId: 'codex',
      service,
      capacitySnapshot: {
        capacity: {
          windowTokens: 100_000,
          inputCeilingTokens: 95_000,
          source: 'reported',
          provenance: 'same carrier report',
          actionable: true,
        },
        capability: CODEX_EXEC,
        memberWindowTokens: null,
        model: 'gpt-5.5',
      },
      prompt: 'route placeholder',
      contextPromptFactory: async () => ({ prompt: 'epoch-owned prompt', promptMessageIds: [] }),
      userId: 'owner-1',
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-f296-threshold',
      invocationOrigin: 'interactive',
      routeTopology: 'parallel',
      isLastCat: true,
    }),
  );

  assert.equal(sealCalls.length, 1);
  const sealEvent = messages.find((message) => {
    if (message.type !== 'system_info') return false;
    try {
      return JSON.parse(message.content).type === 'session_seal_requested';
    } catch {
      return false;
    }
  });
  assert.ok(sealEvent, 'epoch-aware prompt factory must keep threshold sealing available');
});
