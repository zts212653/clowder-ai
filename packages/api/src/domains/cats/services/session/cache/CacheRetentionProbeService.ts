import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CatId, SessionRecord } from '@cat-cafe/shared';
import { agentSessionMutex } from '../../agents/invocation/AgentSessionMutex.js';
import type { FrozenExecutionBinding } from '../../agents/invocation/execution-account-binding.js';
import { hostExecutionBoundaryRef } from '../../agents/invocation/host-execution-boundary.js';
import type { InvocationRegistry } from '../../agents/invocation/InvocationRegistry.js';
import { InvocationServiceScope } from '../../agents/invocation/invocation-service-scope.js';
import { persistedToolSurface } from '../../agents/invocation/request-generation-recorder.js';
import { compileL0ViaSubprocess } from '../../agents/providers/l0-compiler.js';
import {
  prepareSessionCredentialFile,
  releaseInvocationCredentialFile,
} from '../../agents/providers/session-credential-file.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import type { AgentService, TokenUsage } from '../../types.js';
import type { TranscriptReader } from '../TranscriptReader.js';
import type { TranscriptWriter } from '../TranscriptWriter.js';
import { type CacheRetentionCost, cacheRetentionCost } from './cache-retention-cost.js';
import type { CacheRetentionWarmProof } from './cache-retention-proof.js';
import {
  type RetentionReceiptScope,
  readRetentionReceipt,
  retentionProbeAttemptRef,
} from './cache-retention-receipt.js';
import { cacheRetentionSendRefusal } from './cache-retention-send-guard.js';
import { readClaudeRetentionSource } from './claude-retention-source.js';
import { sessionCacheRuntimeKey } from './session-cache-runtime.js';
import { projectSessionCacheWarmth } from './session-cache-warmth.js';

export class CacheRetentionProbeRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface CacheRetentionProbeDependencies {
  readonly apiUrl: string;
  readonly sessions: Pick<ISessionChainStore, 'getActive'>;
  readonly executions: ITurnExecutionStore;
  readonly registry: InvocationRegistry;
  readonly reader: Pick<TranscriptReader, 'readInvocationEvents'>;
  readonly writer: Pick<TranscriptWriter, 'appendDurableEvent' | 'keyedContentDigest'>;
  readonly getService: (catId: CatId) => AgentService;
  readonly isBusy: (threadId: string, catId: CatId, userId: string) => boolean;
  readonly compileL0?: typeof compileL0ViaSubprocess;
  readonly prepareBinding: (input: {
    userId: string;
    catId: CatId;
    threadId: string;
    service: AgentService;
    signal: AbortSignal;
  }) => Promise<FrozenExecutionBinding>;
}

export interface CacheRetentionProbeReceipt {
  readonly v: 1;
  readonly invocationId: string;
  readonly sourceInvocationId: string;
  readonly sessionId: string;
  readonly parentNativeSessionId: string;
  readonly forkNativeSessionId?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  /** Canonical member input order immediately before maintenance. Absent in old research originals. */
  readonly returnAfterSequence?: number;
  readonly outcome: 'sample_pass' | 'skipped' | 'failed';
  readonly reason?: string;
  readonly toolAttempts: number;
  readonly canonicalParentUnchanged: boolean;
  readonly readRatio: number;
  readonly writeTokens: number | null;
  readonly usage?: TokenUsage;
  readonly cost?: CacheRetentionCost;
}

/**
 * Manual Host canary only. No scheduler, work Queue, Task or Chat publisher.
 * Keep the principal/provider/teardown transaction together: every exit must drain its
 * owned provider, settle its separate principal and release credentials in the same finally.
 * Source resolution, send eligibility and cost accounting have separate owners. This is
 * still an acceptance probe, not the product scheduler or a complete tail-attribution verdict.
 */
export class CacheRetentionProbeService {
  private readonly active = new Set<AbortController>();
  constructor(private readonly deps: CacheRetentionProbeDependencies) {}
  close(): void {
    for (const stop of this.active) stop.abort();
  }
  readReceipt(input: RetentionReceiptScope): Promise<CacheRetentionProbeReceipt | null> {
    return readRetentionReceipt(this.deps, input);
  }

  async probe(input: {
    captureReturnBoundary?: () => Promise<number>;
    userId: string;
    catId: CatId;
    threadId: string;
    signal: AbortSignal;
    assertCurrent: () => void | Promise<void>;
    /** Server-owned durable window claim; manual callers cannot choose another attempt. */
    attemptId?: string;
    warmProof?: CacheRetentionWarmProof;
  }): Promise<CacheRetentionProbeReceipt> {
    const stop = new AbortController();
    this.active.add(stop);
    const signal = AbortSignal.any([input.signal, stop.signal, AbortSignal.timeout(90_000)]);
    const releases: Array<() => void> = [];
    const selected = this.deps.getService(input.catId);
    const scope = new InvocationServiceScope();
    const service = scope.pin(selected);
    let invocationId: string | undefined;
    let credentialPath: string | undefined;
    let createdExecution = false;
    let providerStarted = false;
    let principalSettled = false;
    let monitor: ReturnType<typeof setInterval> | undefined;
    try {
      const before = await this.current(input);
      const carrier = service.freshnessCarrierCapability?.().carrier;
      if (!['claude_print_sdk', 'claude_agent_sdk'].includes(carrier ?? '') || !before.cliSessionId)
        throw new CacheRetentionProbeRefusal('cache_retention_unsupported_carrier');
      const runtime = sessionCacheRuntimeKey({ clientId: 'anthropic', carrier });
      if (!runtime) throw new CacheRetentionProbeRefusal('cache_retention_unsupported_carrier');
      const owner = { invocationId: randomUUID(), executionId: randomUUID(), ...input, acquiredAt: Date.now() };
      releases.push(
        await agentSessionMutex.acquire(
          { ...owner, key: `policy:${input.userId}:${input.catId}:${input.threadId}` },
          signal,
        ),
      );
      releases.push(await agentSessionMutex.acquire({ ...owner, key: `runtime:${before.cliSessionId}` }, signal));
      const record = await this.current(input);
      if (record.id !== before.id || record.cliSessionId !== before.cliSessionId)
        throw new CacheRetentionProbeRefusal('cache_retention_parent_changed');
      const source = await readClaudeRetentionSource(this.deps.reader, record);
      const binding = await this.deps.prepareBinding({ ...input, service, signal });
      if (
        !binding.sharedMcpLaunch?.context ||
        !binding.hostExecutionBoundary ||
        record.lastUsage?.cacheObservation?.executionBoundaryRef !==
          hostExecutionBoundaryRef(binding.hostExecutionBoundary)
      )
        throw new CacheRetentionProbeRefusal('cache_retention_binding_changed');
      if (
        projectSessionCacheWarmth(record, Date.now(), { model: source.runtime.model, runtime }, input.warmProof)
          .status !== 'warm'
      )
        throw new CacheRetentionProbeRefusal('cache_retention_window_unknown');
      const l0 = await (this.deps.compileL0 ?? compileL0ViaSubprocess)({
        catId: input.catId,
        userId: input.userId,
        frozenInput: binding.frozenL0Input,
        requireFrozenInput: true,
      });
      if (l0 !== source.nativeSystemPrompt)
        throw new CacheRetentionProbeRefusal('cache_retention_system_prefix_changed');
      const attemptRef = retentionProbeAttemptRef({
        sessionId: record.id,
        sourceInvocationId: source.sourceInvocationId,
        attemptId: input.attemptId ?? 'manual',
      });
      if ((await this.deps.executions.listByParent(attemptRef)).length > 0)
        throw new CacheRetentionProbeRefusal('cache_retention_source_already_attempted');
      await input.assertCurrent();
      const policy = { mode: 'callback_allowlist' as const, allowedCallbackRoutes: [] };
      const principal = await this.deps.registry.create(
        input.userId,
        input.catId,
        input.threadId,
        attemptRef,
        undefined,
        policy,
        undefined,
        'strict',
        undefined,
        binding.sharedMcpLaunch.context,
      );
      invocationId = principal.invocationId;
      const startedAt = Date.now();
      const returnAfterSequence = await input.captureReturnBoundary?.();
      const created = await this.deps.executions.createRunning({
        invocationId,
        parentInvocationId: attemptRef,
        userId: input.userId,
        threadId: input.threadId,
        catId: input.catId,
        executionKind: 'cache_retention',
        providerLifecycleTracked: true,
        startedAt,
      });
      if (created.outcome !== 'created') throw new CacheRetentionProbeRefusal('cache_retention_admission_conflict');
      createdExecution = true;
      const context = binding.sharedMcpLaunch.context;
      const callbackEnv: Record<string, string> = {
        CAT_CAFE_API_URL: this.deps.apiUrl,
        CAT_CAFE_USER_ID: input.userId,
        CAT_CAFE_CAT_ID: input.catId,
        CAT_CAFE_THREAD_ID: input.threadId,
        CAT_CAFE_INVOCATION_ID: invocationId,
        CAT_CAFE_CALLBACK_TOKEN: principal.callbackToken,
        CAT_CAFE_MCP_TRANSPORT: binding.sharedMcpLaunch.transport,
        CAT_CAFE_DATA_DIR: context.dataDir,
        ALLOWED_WORKSPACE_DIRS: context.allowedWorkspaceDirs.join(','),
        CAT_CAFE_ANTHROPIC_PROFILE_MODE: binding.resolvedAccount?.authType === 'api_key' ? 'api_key' : 'subscription',
        ...(binding.executionPreferences?.model
          ? { CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: binding.executionPreferences.model }
          : {}),
      };
      const credential = prepareSessionCredentialFile('cache-retention-probe', callbackEnv);
      if (!credential) throw new CacheRetentionProbeRefusal('cache_retention_binding_unavailable');
      credentialPath = credential.path;
      callbackEnv.CAT_CAFE_CREDENTIAL_FILE = credential.path;
      const transcript = {
        sessionId: record.id,
        threadId: record.threadId,
        catId: record.catId,
        seq: record.seq,
        cliSessionId: record.cliSessionId,
      };
      await this.deps.writer.appendDurableEvent(
        transcript,
        { type: 'cache_retention_started', sourceInvocationId: source.sourceInvocationId, startedAt },
        invocationId,
      );
      monitor = setInterval(() => {
        if (this.deps.isBusy(input.threadId, input.catId, input.userId)) stop.abort();
      }, 250);
      monitor.unref();
      let usage: TokenUsage | undefined;
      let forkNativeSessionId: string | undefined;
      let toolAttempts = 0;
      let reason: string | undefined;
      let skipped = false;
      const assertSendCurrent = async () => {
        signal.throwIfAborted();
        try {
          await input.assertCurrent();
          const current = await this.current(input);
          const refusal = cacheRetentionSendRefusal({
            before: record,
            current,
            sourceInvocationId: source.sourceInvocationId,
            model: source.runtime.model,
            runtime,
            now: Date.now(),
            warmProof: input.warmProof,
          });
          if (refusal) throw new CacheRetentionProbeRefusal(refusal);
        } catch (error) {
          skipped = true;
          reason = error instanceof CacheRetentionProbeRefusal ? error.code : 'cache_retention_source_changed';
          throw error;
        }
      };
      try {
        for await (const event of service.invoke('Reply OK. Do not use tools.', {
          ...binding.providerOptions,
          executionPreferences: binding.executionPreferences,
          reasoningEffortOverride: binding.threadPreferences?.reasoningEffortOverride,
          ...(binding.accountEnv ? { accountEnv: binding.accountEnv } : {}),
          ...(binding.resolvedAccount?.claude ? { claudeTokenAccount: true } : {}),
          ...(binding.executionAccount ? { executionAccount: binding.executionAccount } : {}),
          ...(binding.catConfig?.cliConfigArgs ? { cliConfigArgs: [...binding.catConfig.cliConfigArgs] } : {}),
          invocationId,
          sessionId: record.cliSessionId,
          workingDirectory: binding.workspace.workingDirectory,
          callbackEnv,
          toolExecutionPolicy: policy,
          signal,
          requireExactResume: true,
          cacheRetentionReplay: { ...source, assertSendCurrent },
          auditContext: {
            invocationId,
            executionId: attemptRef,
            threadId: input.threadId,
            userId: input.userId,
            catId: input.catId,
          },
          beforeProviderLaunch: async (prepared) => {
            signal.throwIfAborted();
            const tools = await persistedToolSurface(prepared.tools, (value) =>
              this.deps.writer.keyedContentDigest(value),
            );
            if (!isDeepStrictEqual(tools, source.tools) || !isDeepStrictEqual(prepared.runtime, source.runtime)) {
              reason = 'cache_retention_runtime_or_tools_changed';
              throw new CacheRetentionProbeRefusal('cache_retention_runtime_or_tools_changed');
            }
            // The SDK repeats this after async preparation, immediately before query().
            await assertSendCurrent();
            return { requestGenerationId: invocationId!, generationOrdinal: 1, sessionId: record.id };
          },
        })) {
          if (event.type === 'session_init') {
            forkNativeSessionId = event.sessionId;
            await this.deps.executions.markProviderStarted(invocationId, Date.now());
            providerStarted = true;
          }
          if (event.type === 'tool_use') {
            toolAttempts++;
            reason = 'cache_retention_tool_attempt';
            stop.abort();
          }
          if ((event.type === 'error' || event.errorCode) && !reason)
            reason = signal.aborted ? 'cache_retention_interrupted' : 'cache_retention_provider_error';
          if (event.type === 'done' && event.metadata?.usage) usage = event.metadata.usage;
        }
      } catch {
        reason ??= signal.aborted ? 'cache_retention_interrupted' : 'cache_retention_provider_error';
      }
      const after = await this.deps.sessions.getActive(input.catId, input.threadId, input.userId);
      const canonicalParentUnchanged =
        after?.id === record.id &&
        after.cliSessionId === record.cliSessionId &&
        isDeepStrictEqual(after.lastUsage, record.lastUsage);
      const readRatio = (usage?.cacheReadTokens ?? 0) / record.lastUsage!.cacheObservation!.contextTokens;
      const writeTokens =
        usage?.cacheCreation1hTokens !== undefined && usage.cacheCreation5mTokens !== undefined
          ? usage.cacheCreation1hTokens + usage.cacheCreation5mTokens
          : null;
      const cost = cacheRetentionCost(source.runtime.model, usage);
      if (!reason && (!usage?.cacheCreation1hTokens || usage.cacheCreation5mTokens !== 0))
        reason = 'cache_retention_ttl_unconfirmed';
      if (!reason && usage?.numTurns !== 1) reason = 'cache_retention_request_count_unconfirmed';
      if (
        !reason &&
        (!canonicalParentUnchanged ||
          !forkNativeSessionId ||
          forkNativeSessionId === record.cliSessionId ||
          toolAttempts > 0 ||
          readRatio < 0.95 ||
          writeTokens === null ||
          !cost ||
          cost.writeReadRatio > 0.5)
      )
        reason = 'cache_retention_sample_failed';
      const receipt: CacheRetentionProbeReceipt = {
        v: 1,
        invocationId,
        sourceInvocationId: source.sourceInvocationId,
        sessionId: record.id,
        parentNativeSessionId: record.cliSessionId!,
        ...(forkNativeSessionId ? { forkNativeSessionId } : {}),
        startedAt,
        endedAt: Date.now(),
        ...(returnAfterSequence !== undefined ? { returnAfterSequence } : {}),
        outcome: skipped ? 'skipped' : reason ? 'failed' : 'sample_pass',
        ...(reason ? { reason } : {}),
        toolAttempts,
        canonicalParentUnchanged,
        readRatio,
        writeTokens,
        ...(usage ? { usage } : {}),
        ...(cost ? { cost } : {}),
      };
      await this.deps.writer.appendDurableEvent(transcript, { type: 'cache_retention_result', receipt }, invocationId);
      if (providerStarted) await this.deps.executions.recordProviderTeardown(invocationId, receipt.endedAt);
      await this.deps.executions.transitionTerminal(invocationId, {
        status: reason ? 'failed' : 'succeeded',
        endedAt: receipt.endedAt,
        terminalReason: reason ?? 'cache_retention_probe_complete',
      });
      await this.deps.registry.commitTerminal({
        invocationId,
        disposition: reason ? 'failed' : 'completed',
        endedAt: receipt.endedAt,
        endReason: reason ?? 'cache_retention_probe_complete',
      });
      principalSettled = true;
      await this.deps.executions.clearResponsePending(invocationId);
      return receipt;
    } finally {
      this.active.delete(stop);
      if (monitor) clearInterval(monitor);
      if (invocationId) {
        const execution = createdExecution ? await this.deps.executions.get(invocationId) : null;
        if (execution?.status === 'running') {
          if (providerStarted) await this.deps.executions.recordProviderTeardown(invocationId, Date.now());
          await this.deps.executions.transitionTerminal(invocationId, {
            status: 'failed',
            endedAt: Date.now(),
            terminalReason: 'cache_retention_probe_failed',
          });
          await this.deps.executions.clearResponsePending(invocationId);
        }
        if (!principalSettled)
          await this.deps.registry.commitTerminal({
            invocationId,
            disposition: 'failed',
            endedAt: Date.now(),
            endReason: 'cache_retention_probe_closed',
          });
      }
      for (const release of releases.reverse()) release();
      await scope.dispose();
      if (credentialPath) releaseInvocationCredentialFile(credentialPath);
    }
  }

  private async current(input: { userId: string; catId: CatId; threadId: string }): Promise<SessionRecord> {
    if (this.deps.isBusy(input.threadId, input.catId, input.userId))
      throw new CacheRetentionProbeRefusal('cache_retention_session_busy');
    const record = await this.deps.sessions.getActive(input.catId, input.threadId, input.userId);
    if (
      !record ||
      record.userId !== input.userId ||
      record.threadId !== input.threadId ||
      record.catId !== input.catId ||
      record.status !== 'active'
    )
      throw new CacheRetentionProbeRefusal('cache_retention_source_unavailable');
    return record;
  }
}
