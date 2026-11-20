import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createCatId, type SessionRecord } from '@cat-cafe/shared';
import { hostExecutionBoundaryRef } from '../../src/domains/cats/services/agents/invocation/host-execution-boundary.js';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { createRequestGenerationRecorder } from '../../src/domains/cats/services/agents/invocation/request-generation-recorder.js';
import {
  type CacheRetentionProbeDependencies,
  CacheRetentionProbeService,
} from '../../src/domains/cats/services/session/cache/CacheRetentionProbeService.js';
import { TranscriptReader } from '../../src/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../../src/domains/cats/services/session/TranscriptWriter.js';
import { InMemoryTurnExecutionStore } from '../../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import type { AgentService, PreparedProviderRequestV1, TokenUsage } from '../../src/domains/cats/services/types.js';

/** Real Host owners and transcripts; only the paid provider and L0 compiler are replaced. */
export async function retentionProbeFixture(
  t: TestContext,
  atSend: (record: SessionRecord) => void = () => {},
  usage: Partial<TokenUsage> = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'f338-host-contract-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const previousCredDir = process.env.CAT_CAFE_MCP_CREDS_DIR;
  process.env.CAT_CAFE_MCP_CREDS_DIR = join(dataDir, 'credentials');
  t.after(() => {
    if (previousCredDir === undefined) delete process.env.CAT_CAFE_MCP_CREDS_DIR;
    else process.env.CAT_CAFE_MCP_CREDS_DIR = previousCredDir;
  });
  const catId = createCatId('haiku55');
  const boundary = {
    v: 1 as const,
    clientId: 'anthropic',
    carrier: 'claude_agent_sdk',
    implementationKey: 'sdk-fixture',
    implementationGeneration: '1',
    accountRef: 'fixture-account',
    workspaceRoot: dataDir,
    projectRoot: dataDir,
  };
  const record: SessionRecord = {
    id: 'session',
    threadId: 'thread',
    catId,
    userId: 'owner',
    seq: 0,
    status: 'active',
    cliSessionId: 'native-parent',
    hostExecutionBoundary: boundary,
    messageCount: 1,
    compressionCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUsage: {
      cacheObservation: {
        invocationId: 'source',
        nativeSessionId: 'native-parent',
        runtime: 'anthropic:sdk',
        model: 'claude-haiku-5-5',
        executionBoundaryRef: hostExecutionBoundaryRef(boundary),
        requestStartedAt: Date.now() - 1000,
        observedAt: Date.now(),
        timeSource: 'invocation_start_lower_bound',
        contextTokens: 100_000,
        compressionCount: 0,
        retentionMs: 3_600_000,
        retentionSource: 'usage_ttl',
        confirmedWarmGapsMs: [],
      },
    },
  };
  const sessions = { getActive: async () => structuredClone(record) };
  const writer = new TranscriptWriter({ dataDir });
  const reader = new TranscriptReader({ dataDir });
  const prepared: PreparedProviderRequestV1 = {
    v: 1,
    message: { body: 'frozen task' },
    nativeInstructions: [{ body: 'FROZEN L0', injectionDecision: 'native_l0_compiled' }],
    runtime: { provider: 'anthropic', carrier: 'agent_sdk', model: 'claude-haiku-5-5' },
    tools: { finalSurface: 'declared_only', declaredServerNames: ['cat-cafe-collab'] },
    providerNativeVisibility: 'unknown',
  };
  const recorder = createRequestGenerationRecorder({
    invocationId: 'source',
    userId: 'owner',
    catId,
    threadId: 'thread',
    transcriptWriter: writer,
    sessionChainStore: sessions,
    snapshot: () => ({
      continuity: { capability: 'unknown', compactionRefs: [] },
      messageSourceRefs: [],
      nativeInstructionSourceRefs: [],
      presentations: [],
    }),
  });
  await recorder.recordTerminal(await recorder.recordPrepared(prepared, { attempt: 1 }), 'accepted');
  const counters = { providerEntries: 0, modelRequests: 0 };
  const service: AgentService = {
    freshnessCarrierCapability: () => ({
      provider: 'anthropic',
      carrier: 'claude_agent_sdk',
      deliverySemantics: 'queued_internal_turn',
      activeInvocationGuidance: 'supported',
    }),
    async *invoke(_prompt, options) {
      counters.providerEntries++;
      atSend(record);
      await options?.beforeProviderLaunch?.(prepared);
      counters.modelRequests++;
      yield { type: 'session_init', catId, sessionId: 'native-fork' };
      yield {
        type: 'done',
        catId,
        metadata: {
          usage: {
            inputTokens: 100_004,
            outputTokens: 1,
            cacheReadTokens: 100_000,
            cacheCreation1hTokens: 4,
            cacheCreation5mTokens: 0,
            numTurns: 1,
            ...usage,
          },
        },
      };
    },
  };
  const executions = new InMemoryTurnExecutionStore();
  const registry = new InvocationRegistry({ turnExecutionStore: executions });
  const dependencies: CacheRetentionProbeDependencies = {
    apiUrl: 'http://127.0.0.1:1',
    sessions,
    executions,
    registry,
    reader,
    writer,
    isBusy: () => false,
    getService: () => service,
    compileL0: async () => 'FROZEN L0',
    prepareBinding: async () => ({
      workspace: { usesDefaultWorkspace: false, workingDirectory: dataDir },
      projectRoot: dataDir,
      resolvedAccount: null,
      hostExecutionBoundary: boundary,
      sharedMcpLaunch: {
        transport: 'shared',
        context: {
          v: 1,
          deploymentId: 'isolated-fixture',
          workspaceRoot: dataDir,
          dataDir,
          allowedWorkspaceDirs: [dataDir],
          capabilityRoot: dataDir,
          families: [],
        },
      },
    }),
  };
  const probe = new CacheRetentionProbeService(dependencies);
  t.after(() => probe.close());
  return {
    record,
    counters,
    reader,
    executions,
    restart: () => {
      const restarted = new CacheRetentionProbeService({ ...dependencies, reader: new TranscriptReader({ dataDir }) });
      t.after(() => restarted.close());
      return restarted;
    },
    run: (overrides: Partial<Parameters<CacheRetentionProbeService['probe']>[0]> = {}) =>
      probe.probe({
        userId: 'owner',
        catId,
        threadId: 'thread',
        signal: new AbortController().signal,
        assertCurrent() {},
        ...overrides,
      }),
  };
}
