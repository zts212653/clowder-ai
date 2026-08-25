import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';

const CLAUDE_PRINT = {
  provider: 'anthropic',
  carrier: 'print_sdk',
  reportsRuntimeWindow: true,
  authoritativeUsage: true,
  usageTelemetry: 'available',
  nativeWindowControl: false,
  nativeCompressionControl: false,
  observesCompression: true,
  reason: 'fixture',
};

test('F296 B3b-3 typed compact_boundary reaches the epoch owner through the real provider loop', async () => {
  const observations = [];
  const contextEpochOwner = {
    async resolve(input) {
      return {
        scopeKey: 'owner-1::opus::thread-f296',
        contextEpoch: 1,
        contextMode: 'cold',
        lastTransitionRef: input.disposition.evidenceRef,
        consumedCompactionEventIds: [],
        transition: 'scope_first_seen',
        normalizedDisposition: input.disposition,
        healthSignals: [],
      };
    },
    async observeCompaction(input) {
      observations.push(input);
      return {
        scopeKey: 'owner-1::opus::thread-f296',
        contextEpoch: 2,
        contextMode: 'cold',
        lastTransitionRef: input.event.evidenceRef,
        consumedCompactionEventIds: [input.event.eventId],
        transition: 'context_compacted',
        replayed: false,
      };
    },
  };
  const service = {
    contextCapability: () => CLAUDE_PRINT,
    async *invoke() {
      yield {
        type: 'provider_signal',
        catId: 'opus',
        contextCompaction: { eventSource: 'claude_compact_boundary', preTokens: 42_000 },
        content: JSON.stringify({ type: 'compact_boundary', preTokens: 42_000 }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };
  const activeRecord = {
    id: 'logical-session-1',
    cliSessionId: 'claude-runtime-1',
    userId: 'owner-1',
    catId: 'opus',
    threadId: 'thread-f296',
    compressionCount: 1,
  };
  const deps = {
    registry: {
      create: async () => ({ invocationId: 'inv-f296-compact', callbackToken: 'token-f296' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => 'claude-runtime-1',
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    sessionChainStore: {
      getActive: async () => activeRecord,
      getChainByThread: async () => [],
      getChain: async () => [],
      create: async () => activeRecord,
      update: async () => activeRecord,
    },
    contextEpochOwner,
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
  };

  for await (const _message of invokeSingleCat(deps, {
    catId: 'opus',
    service,
    prompt: 'placeholder',
    contextPromptFactory: async () => ({ prompt: 'trusted cold prompt', promptMessageIds: [] }),
    userId: 'owner-1',
    ownerAuthProvenance: 'unknown',
    threadId: 'thread-f296',
    invocationOrigin: 'interactive',
    routeTopology: 'serial',
    isLastCat: true,
  })) {
    // consume the complete provider path
  }

  assert.equal(observations.length, 1);
  assert.equal(observations[0].event.eventId, 'context-compaction:logical-session-1:1');
  assert.equal(observations[0].event.runtimeSessionId, 'claude-runtime-1');
  assert.match(observations[0].event.evidenceRef, /^claude_compact_boundary:/);
});
