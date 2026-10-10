import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const CLAUDE_SDK = { ...CLAUDE_PRINT, carrier: 'agent_sdk' };

test('F296 B3b-3 typed compact_boundary consumes a same-invocation legacy unknown-count attestation', async () => {
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
    compressionCount: null,
    compressionObservation: {
      invocationId: 'inv-f296-compact',
      sequence: 1,
      observedAt: 1,
    },
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
    hookAuthenticationReady: true,
    contextEpochOwner,
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
  };

  await withCompactionCarrierRoot(writeCarrierFixtureRoot(), async () => {
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
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].event.eventId, 'context-compaction:logical-session-1:1');
  assert.equal(observations[0].event.runtimeSessionId, 'claude-runtime-1');
  assert.match(observations[0].event.evidenceRef, /^claude_compact_boundary:/);
});

async function invokeBoundaryWithReadiness({
  hookAuthenticationReady,
  carrierReady = true,
  claudeProjectHookCarrierReady = () => carrierReady,
  threadStore,
  activeRecord: suppliedActiveRecord,
  boundaryCount = 1,
  observeCompaction,
  carrierCapability = CLAUDE_PRINT,
  claudeCompactionHooks,
}) {
  let boundaryEmitted = false;
  let receivedOptions;
  let postBoundarySessionReads = 0;
  const activeRecord = suppliedActiveRecord ?? {
    id: 'logical-session-no-hook',
    cliSessionId: 'claude-runtime-1',
    userId: 'owner-1',
    catId: 'opus',
    threadId: 'thread-f296',
    compressionCount: 7,
    compressionObservation: {
      invocationId: 'inv-f296-previous',
      sequence: 7,
      observedAt: 1,
    },
  };
  const service = {
    contextCapability: () => carrierCapability,
    async *invoke(_prompt, options) {
      receivedOptions = options;
      for (let index = 0; index < boundaryCount; index += 1) {
        boundaryEmitted = true;
        yield {
          type: 'provider_signal',
          catId: 'opus',
          contextCompaction: { eventSource: 'claude_compact_boundary', preTokens: 42_000 },
          content: JSON.stringify({ type: 'compact_boundary', preTokens: 42_000 }),
          timestamp: Date.now(),
        };
      }
    },
  };
  const deps = {
    registry: {
      create: async () => ({ invocationId: 'inv-f296-no-hook-auth', callbackToken: 'token-f296' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => 'claude-runtime-1',
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    sessionChainStore: {
      getActive: async () => {
        if (boundaryEmitted) postBoundarySessionReads += 1;
        return activeRecord;
      },
      getChainByThread: async () => [],
      getChain: async () => [],
      create: async () => activeRecord,
      update: async () => activeRecord,
    },
    hookAuthenticationReady,
    claudeProjectHookCarrierReady,
    ...(claudeCompactionHooks ? { claudeCompactionHooks } : {}),
    contextEpochOwner: {
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
      async observeCompaction() {
        if (observeCompaction) return observeCompaction();
        throw new Error('epoch owner must not observe an unauthenticated boundary');
      },
    },
    threadStore,
    apiUrl: 'http://127.0.0.1:3004',
  };

  const messages = [];
  await withCompactionCarrierRoot(carrierReady ? writeCarrierFixtureRoot() : emptyCarrierRoot(), async () => {
    for await (const message of invokeSingleCat(deps, {
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
      messages.push(message);
    }
  });
  const terminalError = messages.find((message) => message.type === 'error');
  return { terminalError, postBoundarySessionReads, receivedOptions };
}

test('Claude compact_boundary fails actionably before sequence lookup when hook auth is unavailable', async () => {
  const { terminalError, postBoundarySessionReads } = await invokeBoundaryWithReadiness({
    hookAuthenticationReady: false,
    threadStore: null,
  });

  assert.match(String(terminalError?.error), /authoritative_compaction_unsupported:hook_authentication_unavailable/);
  assert.equal(postBoundarySessionReads, 0, 'missing hook auth must be classified before sequence derivation');
});

test('Claude compact_boundary fails closed when no launch-plan carrier resolves for the invocation', async () => {
  const { terminalError, postBoundarySessionReads } = await invokeBoundaryWithReadiness({
    hookAuthenticationReady: true,
    carrierReady: false,
    threadStore: null,
  });

  assert.match(String(terminalError?.error), /authoritative_compaction_unsupported:hook_carrier_unavailable/);
  assert.equal(
    postBoundarySessionReads,
    0,
    'a missing launch-plan carrier must be classified before sequence derivation',
  );
});

test('Claude compact_boundary rejects a stale sequence that was authenticated for a different invocation', async () => {
  const { terminalError, postBoundarySessionReads } = await invokeBoundaryWithReadiness({
    hookAuthenticationReady: true,
    threadStore: null,
  });

  assert.match(
    String(terminalError?.error),
    /authoritative_compaction_unsupported:hook_invocation_attestation_unavailable/,
  );
  assert.equal(postBoundarySessionReads, 1, 'attestation must be read only after auth and carrier prerequisites pass');
});

test('Claude compact_boundary rejects a torn observation whose sequence no longer matches the session counter', async () => {
  const { terminalError } = await invokeBoundaryWithReadiness({
    hookAuthenticationReady: true,
    threadStore: null,
    activeRecord: {
      id: 'logical-session-torn-observation',
      cliSessionId: 'claude-runtime-1',
      userId: 'owner-1',
      catId: 'opus',
      threadId: 'thread-f296',
      compressionCount: 9,
      compressionObservation: {
        invocationId: 'inv-f296-no-hook-auth',
        sequence: 8,
        observedAt: 1,
      },
    },
  });

  assert.match(
    String(terminalError?.error),
    /authoritative_compaction_unsupported:hook_invocation_attestation_unavailable/,
  );
});

function writeCarrierFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'f296-carrier-root-'));
  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'hooks', 'f24-compaction.mjs'),
    [
      '// fixture canonical Node carrier',
      '"use /api/sessions/seal";',
      'CAT_CAFE_INVOCATION_ID CAT_CAFE_CALLBACK_TOKEN',
      'X-Invocation-Id X-Callback-Token X-Clowder-Compaction-Carrier',
    ].join('\n'),
  );
  return root;
}

function emptyCarrierRoot() {
  return mkdtempSync(join(tmpdir(), 'f296-empty-carrier-root-'));
}

function withCompactionCarrierRoot(root, run) {
  const previous = process.env.CAT_CAFE_COMPACTION_CARRIER_ROOT;
  process.env.CAT_CAFE_COMPACTION_CARRIER_ROOT = root;
  return run().finally(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_COMPACTION_CARRIER_ROOT;
    else process.env.CAT_CAFE_COMPACTION_CARRIER_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

test('one authenticated seal observation cannot authorize two compact boundaries in the same invocation', async () => {
  let observations = 0;
  const { terminalError, postBoundarySessionReads } = await invokeBoundaryWithReadiness({
    hookAuthenticationReady: true,
    threadStore: null,
    activeRecord: {
      id: 'logical-session-current-hook',
      cliSessionId: 'claude-runtime-1',
      userId: 'owner-1',
      catId: 'opus',
      threadId: 'thread-f296',
      compressionCount: 8,
      compressionObservation: {
        invocationId: 'inv-f296-no-hook-auth',
        sequence: 8,
        observedAt: 1,
      },
    },
    boundaryCount: 2,
    observeCompaction: async () => {
      observations += 1;
      return {
        scopeKey: 'owner-1::opus::thread-f296',
        contextEpoch: 2,
        contextMode: 'cold',
        lastTransitionRef: 'fixture',
        consumedCompactionEventIds: ['context-compaction:logical-session-current-hook:8'],
        transition: 'context_compacted',
        replayed: false,
      };
    },
  });

  assert.equal(observations, 1);
  assert.equal(postBoundarySessionReads, 2);
  assert.match(
    String(terminalError?.error),
    /authoritative_compaction_unsupported:hook_invocation_attestation_unavailable/,
  );
});

function inProcessHooksFixture() {
  const identities = [];
  return {
    identities,
    claudeCompactionHooks(identity) {
      identities.push(identity);
      return { preCompact: async () => {}, postCompactContext: async () => undefined };
    },
  };
}

const ATTESTED_BY_THIS_INVOCATION = {
  id: 'logical-session-sdk-hook',
  cliSessionId: 'claude-runtime-1',
  userId: 'owner-1',
  catId: 'opus',
  threadId: 'thread-f296',
  compressionCount: 8,
  compressionObservation: { invocationId: 'inv-f296-no-hook-auth', sequence: 8, observedAt: 1 },
};

test('F117 K2: the Agent SDK boundary is proven by the in-process hooks it was handed, not by the workspace', async () => {
  const hooks = inProcessHooksFixture();
  let observations = 0;
  const { terminalError, receivedOptions } = await invokeBoundaryWithReadiness({
    carrierCapability: CLAUDE_SDK,
    claudeCompactionHooks: hooks.claudeCompactionHooks,
    hookAuthenticationReady: false,
    claudeProjectHookCarrierReady: () => false,
    threadStore: null,
    activeRecord: ATTESTED_BY_THIS_INVOCATION,
    observeCompaction: async () => {
      observations += 1;
      return {
        scopeKey: 'owner-1::opus::thread-f296',
        contextEpoch: 2,
        contextMode: 'cold',
        lastTransitionRef: 'fixture',
        consumedCompactionEventIds: ['context-compaction:logical-session-sdk-hook:8'],
        transition: 'context_compacted',
        replayed: false,
      };
    },
  });

  assert.equal(terminalError, undefined, String(terminalError?.error));
  assert.equal(observations, 1, 'the boundary advances the epoch once');
  assert.deepEqual(hooks.identities, [
    { invocationId: 'inv-f296-no-hook-auth', userId: 'owner-1', catId: 'opus', threadId: 'thread-f296' },
  ]);
  assert.equal(typeof receivedOptions.claudeCompactionHooks?.preCompact, 'function');
});

test('F117 K2: without an in-process observation from this invocation the Agent SDK boundary still fails closed', async () => {
  const hooks = inProcessHooksFixture();
  const { terminalError, postBoundarySessionReads } = await invokeBoundaryWithReadiness({
    carrierCapability: CLAUDE_SDK,
    claudeCompactionHooks: hooks.claudeCompactionHooks,
    hookAuthenticationReady: false,
    claudeProjectHookCarrierReady: () => false,
    threadStore: null,
  });

  assert.match(
    String(terminalError?.error),
    /authoritative_compaction_unsupported:hook_invocation_attestation_unavailable/,
  );
  assert.equal(
    postBoundarySessionReads,
    1,
    'the observation is looked up, and one from a previous invocation does not count',
  );
});

test('F117 K2: the print carrier is never handed in-process hooks and keeps its project-hook proof', async () => {
  const hooks = inProcessHooksFixture();
  const { terminalError, receivedOptions } = await invokeBoundaryWithReadiness({
    claudeCompactionHooks: hooks.claudeCompactionHooks,
    hookAuthenticationReady: false,
    claudeProjectHookCarrierReady: () => true,
    threadStore: null,
  });

  assert.deepEqual(hooks.identities, []);
  assert.equal(receivedOptions.claudeCompactionHooks, undefined);
  assert.match(String(terminalError?.error), /authoritative_compaction_unsupported:hook_authentication_unavailable/);
});
