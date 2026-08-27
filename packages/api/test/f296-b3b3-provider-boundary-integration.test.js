import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { findMonorepoRoot } from '../dist/utils/monorepo-root.js';

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
    claudeProjectHookCarrierReady: () => true,
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

async function invokeBoundaryWithReadiness({
  hookAuthenticationReady,
  claudeProjectHookCarrierReady,
  threadStore,
  activeRecord: suppliedActiveRecord,
  boundaryCount = 1,
  observeCompaction,
}) {
  let boundaryEmitted = false;
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
    contextCapability: () => CLAUDE_PRINT,
    async *invoke() {
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
  const terminalError = messages.find((message) => message.type === 'error');
  return { terminalError, postBoundarySessionReads };
}

test('Claude compact_boundary fails actionably before sequence lookup when hook auth is unavailable', async () => {
  const { terminalError, postBoundarySessionReads } = await invokeBoundaryWithReadiness({
    hookAuthenticationReady: false,
    claudeProjectHookCarrierReady: () => true,
    threadStore: null,
  });

  assert.match(String(terminalError?.error), /authoritative_compaction_unsupported:hook_authentication_unavailable/);
  assert.equal(postBoundarySessionReads, 0, 'missing hook auth must be classified before sequence derivation');
});

test('Claude compact_boundary checks the active workspace hook carrier before sequence lookup', async () => {
  let inspectedProjectRoot;
  const externalProject = mkdtempSync(join(tmpdir(), 'f296-external-project-'));
  try {
    const { terminalError, postBoundarySessionReads } = await invokeBoundaryWithReadiness({
      hookAuthenticationReady: true,
      claudeProjectHookCarrierReady(projectRoot) {
        inspectedProjectRoot = projectRoot;
        return false;
      },
      threadStore: {
        get: async () => ({
          id: 'thread-f296',
          title: 'external workspace fixture',
          createdBy: 'owner-1',
          projectPath: externalProject,
        }),
      },
    });

    assert.equal(inspectedProjectRoot, findMonorepoRoot(realpathSync(externalProject)));
    assert.match(String(terminalError?.error), /authoritative_compaction_unsupported:hook_carrier_unavailable/);
    assert.equal(
      postBoundarySessionReads,
      0,
      'missing workspace carrier must be classified before sequence derivation',
    );
  } finally {
    rmSync(externalProject, { recursive: true, force: true });
  }
});

test('Claude compact_boundary rejects a stale sequence that was authenticated for a different invocation', async () => {
  const { terminalError, postBoundarySessionReads } = await invokeBoundaryWithReadiness({
    hookAuthenticationReady: true,
    claudeProjectHookCarrierReady: () => true,
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
    claudeProjectHookCarrierReady: () => true,
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

test('one authenticated seal observation cannot authorize two compact boundaries in the same invocation', async () => {
  let observations = 0;
  const { terminalError, postBoundarySessionReads } = await invokeBoundaryWithReadiness({
    hookAuthenticationReady: true,
    claudeProjectHookCarrierReady: () => true,
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
