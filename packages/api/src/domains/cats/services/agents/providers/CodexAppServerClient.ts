import type { ProviderNativeFreshnessMissReason } from '../../freshness/FreshnessAttentionEventLog.js';
import type {
  ActiveInvocationFreshnessController,
  PreparedFreshnessNotice,
} from '../../freshness/FreshnessNoticeBroker.js';
import type { CodexNativeResumeReplacementProvenance } from '../../runtime-session/CodexSessionReplacementProvenance.js';
import type {
  AgentCarrierSession,
  PreparedProviderRequestV1,
  ProviderCompactionObservation,
  ProviderContinuityEvidence,
  ProviderRequestGenerationCommitV1,
} from '../../types.js';
import { requireExactPreparedProviderMessage } from '../../types.js';
import {
  asCodexAppServerRecord,
  boundedUnsupportedCodexAppServerNotificationMethod,
  type CodexAppServerJsonObject,
  codexAppServerErrorMessage,
  isCodexAppServerTokenUsageNotification,
  mapCodexAppServerCompactionObservation,
  mapCodexAppServerNotification,
  mapCodexAppServerTokenUsage,
  respondToCodexAppServerRequest,
} from './CodexAppServerEventMapper.js';
import {
  CodexAppServerLifecycle,
  type CodexAppServerLifecycleSnapshot,
  type CodexAppServerLifecycleStage,
} from './CodexAppServerLifecycle.js';
import { CodexAppServerNotificationQueue } from './CodexAppServerNotificationQueue.js';
import { type CodexAppServerThreadVerdict, resolveCodexAppServerThread } from './CodexAppServerThreadResolver.js';
import type { CodexRuntimeInteractionContext } from './CodexRuntimeInteractionAdapter.js';
import {
  type CodexRuntimeInteractionRunState,
  createCodexRuntimeInteractionRunState,
} from './CodexRuntimeInteractionRun.js';
import {
  classifyCodexAppServerToolSurface,
  classifyCodexProtocolItem,
  classifyCodexSafeBoundary,
} from './codex-app-server-boundary.js';
import {
  buildCodexAppServerThreadParams,
  type CodexAppServerApprovalsReviewer,
  closeCodexAppServerTransport,
} from './codex-app-server-client-helpers.js';
import { CodexAppServerRpcError } from './codex-app-server-rpc-error.js';

export type {
  CodexAppServerLifecycleEvent,
  CodexAppServerLifecycleSnapshot,
  CodexAppServerLifecycleStage,
} from './CodexAppServerLifecycle.js';

type JsonObject = CodexAppServerJsonObject;
type RequestId = number;

/**
 * F296 B4a: how this run obtains the bytes it may send.
 *
 * `preflight` deliberately has no prompt field. The adapter can only obtain
 * bytes by calling `settle` with evidence it minted from a real provider
 * response, so "freeze the prompt, then notify that we resumed" cannot be
 * written.
 */
export type CodexAppServerPromptSource =
  | { readonly kind: 'frozen'; readonly prompt: string }
  | {
      readonly kind: 'preflight';
      readonly settle: (input: {
        readonly evidence: ProviderContinuityEvidence;
        readonly compactions?: readonly ProviderCompactionObservation[];
      }) => Promise<{ readonly prompt: string }>;
    };

/** F296 B4b: a compaction observed mid-turn on the bound runtime. */
export interface CodexAppServerContextCompactionEvent {
  readonly type: 'app_server.context_compaction';
  readonly observation: ProviderCompactionObservation;
}

export interface CodexAppServerRunInput {
  prompt: CodexAppServerPromptSource;
  thread: { kind: 'start' } | { kind: 'resume'; threadId: string };
  model?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  developerInstructions?: string;
  config?: JsonObject;
  /** F291: omitted inherits Codex config; null explicitly requests Standard. */
  serviceTier?: string | null;
  /**
   * F306: exact app-server wire enum. There is deliberately no default;
   * production selection of `user` remains blocked on the Phase B interaction
   * surface, while this adapter seam can carry an explicitly approved route.
   */
  approvalsReviewer?: CodexAppServerApprovalsReviewer;
  /** F306: current-turn response constraint; never persisted as thread config. */
  outputSchema?: JsonObject;
  /** F306 Alpha: explicit current-turn provider collaboration preset. */
  collaborationMode?: {
    readonly mode: 'plan' | 'default';
    readonly settings: {
      readonly model: string;
      readonly reasoning_effort?: string | null;
      readonly developer_instructions?: string | null;
    };
  };
  imagePaths?: readonly string[];
  signal?: AbortSignal;
  /** Inactivity timeout. Zero keeps the F118 manual-cancel-only default. */
  timeoutMs?: number;
  /** Grace after turn/interrupt before the transport process is terminated. */
  interruptGraceMs?: number;
  /** Zero-based transport recovery attempt, projected with lifecycle events. */
  recoveryAttempt?: number;
  /** Internal fence: a dead resume carrier is being replaced by this fresh start. */
  resumeReplacement?: CodexNativeResumeReplacementProvenance;
  /**
   * Provider-internal continuation instruction. App-server receives this as
   * application context with no user input item, so recovery cannot append a
   * synthetic user message to the native thread.
   */
  recoveryInstruction?: string;
  /** F299: build and durably commit the exact request immediately before turn/start. */
  prepareRequest?: (
    promptBytes: string,
    boundaryReason?: PreparedProviderRequestV1['boundaryReason'],
  ) => PreparedProviderRequestV1;
  /** F299: recovery has no user message, but its application context is still model-visible input. */
  prepareRecoveryRequest?: (recoveryInstruction: string) => PreparedProviderRequestV1;
  beforeProviderLaunch?: (request: PreparedProviderRequestV1) => Promise<ProviderRequestGenerationCommitV1>;
  /** F306: one provider-neutral interaction surface bound to this exact invocation. */
  runtimeInteraction?: Omit<CodexRuntimeInteractionContext, 'signal'>;
}

export interface CodexAppServerClientDeps {
  wire: AgentCarrierSession;
  freshnessController?: ActiveInvocationFreshnessController;
  onEnvelope?: (direction: 'inbound' | 'outbound', envelope: JsonObject) => void | Promise<void>;
  onUnsupportedNotification?: (observation: { method: string }) => void | Promise<void>;
  onLifecycle?: (snapshot: CodexAppServerLifecycleSnapshot) => void;
  now?: () => number;
}

const DEFAULT_INTERRUPT_GRACE_MS = 1_500;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** F296 B4a: lets a JSON-RPC error name the call it rejected. */
  method: string;
  params: JsonObject;
}

/**
 * F296 B4a: normalize an adapter-observed thread verdict into provider-agnostic
 * continuity evidence. `resumed` survives only when the provider echoed back
 * exactly the requested id; a differing id becomes `mismatched`, never resumed.
 */
export function continuityEvidenceFromVerdict(verdict: CodexAppServerThreadVerdict): ProviderContinuityEvidence {
  switch (verdict.kind) {
    case 'started':
      return { kind: 'started', runtimeSessionId: verdict.threadId };
    case 'resumed':
      return {
        kind: 'resumed',
        requestedRuntimeSessionId: verdict.requestedThreadId,
        runtimeSessionId: verdict.threadId,
      };
    case 'replaced':
      return {
        kind: 'replaced',
        requestedRuntimeSessionId: verdict.requestedThreadId,
        runtimeSessionId: verdict.threadId,
      };
    case 'mismatched':
      return {
        kind: 'mismatched',
        requestedRuntimeSessionId: verdict.requestedThreadId,
        runtimeSessionId: verdict.threadId,
      };
  }
}

export class CodexAppServerClient {
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly notifications = new CodexAppServerNotificationQueue();
  private nextRequestId = 1;
  private pumpPromise: Promise<void> | null = null;
  private pumpFailure: Error | null = null;
  private pumpEnded = false;
  private readonly observedUnsupportedNotificationMethods = new Set<string>();
  private readonly lifecycle: CodexAppServerLifecycle;

  constructor(private readonly deps: CodexAppServerClientDeps) {
    this.lifecycle = new CodexAppServerLifecycle({
      wire: deps.wire,
      request: (method, params) => this.request(method, params),
      ...(deps.onLifecycle ? { onLifecycle: deps.onLifecycle } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  async *run(input: CodexAppServerRunInput): AsyncGenerator<unknown> {
    const runtimeInteraction = createCodexRuntimeInteractionRunState(input.runtimeInteraction, input.approvalsReviewer);
    this.pumpPromise = this.pump(runtimeInteraction);
    // Pending requests / notifications propagate the same failure; attach immediately
    // so carrier shutdown grace cannot expose it as unhandled under Node strict mode.
    void this.pumpPromise.catch(() => {});
    let activeNotice: PreparedFreshnessNotice | null = null;
    let latestUsage: JsonObject | null = null;
    let activeThreadId: string | null = null;
    let activeTurnId: string | null = null;
    let transportDisposition: 'release' | 'evict' = 'release';
    const timeoutMs = Math.max(0, input.timeoutMs ?? 0);
    const interruptGraceMs = Math.max(0, input.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS);
    const recoveryInstruction = input.recoveryInstruction?.trim();
    const abortHandler = (): void => {
      runtimeInteraction?.close('provider_cancelled');
      void this.lifecycle.interrupt(activeThreadId, activeTurnId, 'user_cancel', interruptGraceMs);
    };
    const timeoutHandler = (): void => {
      void this.lifecycle.interrupt(activeThreadId, activeTurnId, 'timeout', interruptGraceMs);
    };
    input.signal?.addEventListener('abort', abortHandler, { once: true });
    const childSpawned = this.lifecycle.transition('child_spawned', { recoveryAttempt: input.recoveryAttempt ?? 0 });
    yield this.lifecycle.event(childSpawned);
    if (input.signal?.aborted) abortHandler();
    this.lifecycle.armInactivityTimeout(timeoutMs, timeoutHandler);
    try {
      await this.request('initialize', {
        clientInfo: { name: 'cat-cafe', title: 'Clowder AI', version: '1' },
        capabilities: recoveryInstruction || input.collaborationMode ? { experimentalApi: true } : {},
      });
      await this.write({ method: 'initialized' });
      yield this.lifecycle.event(this.lifecycle.transition('initialized'));
      this.lifecycle.armInactivityTimeout(timeoutMs, timeoutHandler);

      const verdict = await resolveCodexAppServerThread({
        thread: input.thread,
        params: buildCodexAppServerThreadParams(
          input,
          input.thread.kind === 'resume' ? { threadId: input.thread.threadId } : undefined,
        ),
        startParams: buildCodexAppServerThreadParams(input),
        ...(input.resumeReplacement ? { resumeReplacement: input.resumeReplacement } : {}),
        localLiveLease: this.deps.wire.reusedSessionHost === true,
        request: (method, params) => this.request(method, params),
        now: this.deps.now ?? Date.now,
      });
      const threadId = verdict.threadId;
      activeThreadId = threadId;
      yield this.lifecycle.event(this.lifecycle.transition('thread_ready', { threadId }));
      this.lifecycle.armInactivityTimeout(timeoutMs, timeoutHandler);
      yield {
        type: 'thread.started',
        thread_id: threadId,
        ...(verdict.kind === 'replaced' ? { session_replacement: verdict.replacement } : {}),
      };
      yield { type: 'app_server.continuity_verdict', verdict };

      // F296 B4a preflight fence. The provider verdict exists; buffered
      // compaction for the bound runtime has been drained; only now may the
      // final prompt bytes come into existence. Everything above this line ran
      // without ever holding them.
      //
      // A capacity-recovery turn is the exception: it sends `input: []` below,
      // so it has no prompt to build. Settling anyway is not a harmless read —
      // it drains buffered compactions, rebuilds a cold prompt, exposes new
      // message ids and reserves a ledger generation, all of which are then
      // discarded, while the epoch owner still records the cold as consumed
      // because the provider accepted *a* turn. The next invocation would then
      // project hot context over a cold rebuild nobody ever saw. Leave the
      // compaction buffered; the next real turn is the one that must consume it.
      // One boolean decides both 'do we settle' and 'do we send bytes'. They were
      // two separate conditions for about a minute, and `'  '` (a whitespace-only
      // instruction, trimmed to '') already made them disagree: no settle, but a
      // prompt still sent. Same shape as the required-vs-producible field lists.
      const isRecoveryTurn = Boolean(recoveryInstruction);
      // Drain unconditionally. What the provider already told us is not the
      // recovery turn's to skip: the observation lives in this client's private
      // queue, and `finally` closes the transport, so anything still buffered
      // when a turn is rejected dies with the client. A recovery turn skips
      // *building a generation*, never *recording what happened*.
      const compactions = this.drainBufferedCompactions(threadId);
      // On a recovery turn nothing settles, so the drained observations have no
      // generation to ride along with. Deliver them directly, before turn/start
      // can fail — exactly once, since settle() will not also receive them.
      if (isRecoveryTurn) {
        for (const observation of compactions) {
          yield { type: 'app_server.context_compaction', observation };
        }
      }
      const promptBytes = isRecoveryTurn
        ? ''
        : input.prompt.kind === 'frozen'
          ? input.prompt.prompt
          : (
              await input.prompt.settle({
                evidence: continuityEvidenceFromVerdict(verdict),
                ...(compactions.length > 0 ? { compactions } : {}),
              })
            ).prompt;
      const preparedRequest = isRecoveryTurn
        ? input.prepareRecoveryRequest?.(recoveryInstruction as string)
        : input.prepareRequest?.(promptBytes, (input.recoveryAttempt ?? 0) > 0 ? 'transient_cli_exit' : undefined);
      if (input.beforeProviderLaunch) {
        if (!preparedRequest) throw new Error('codex_app_server_request_evidence_unavailable');
        await input.beforeProviderLaunch(preparedRequest);
      }
      const submittedPrompt = preparedRequest ? requireExactPreparedProviderMessage(preparedRequest) : promptBytes;

      this.lifecycle.patch({ turnStartSent: true });
      const turnResult = asCodexAppServerRecord(
        await this.request('turn/start', {
          threadId,
          input: isRecoveryTurn
            ? []
            : [
                { type: 'text', text: submittedPrompt },
                ...(input.imagePaths ?? []).map((path) => ({ type: 'localImage', path })),
              ],
          ...(isRecoveryTurn && recoveryInstruction
            ? {
                additionalContext: {
                  'cat-cafe.capacity-recovery': {
                    kind: 'application',
                    value: recoveryInstruction,
                  },
                },
              }
            : {}),
          ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
          ...(input.collaborationMode ? { collaborationMode: input.collaborationMode } : {}),
        }),
      );
      const turn = asCodexAppServerRecord(turnResult?.turn);
      if (typeof turn?.id !== 'string') throw new Error('Codex app-server did not return a turn id');
      activeTurnId = turn.id;
      yield this.lifecycle.event(
        this.lifecycle.transition('turn_accepted', { threadId, turnId: activeTurnId, turnAccepted: true }),
      );
      this.lifecycle.armInactivityTimeout(timeoutMs, timeoutHandler);
      if (input.signal?.aborted) {
        void this.lifecycle.interrupt(threadId, activeTurnId, 'user_cancel', interruptGraceMs);
      }

      for (;;) {
        const next = await this.notifications.next();
        if (next.done) throw new Error('Codex app-server stream ended before turn completion');
        const envelope = next.value;
        this.lifecycle.touch(timeoutMs, timeoutHandler);
        const record = asCodexAppServerRecord(envelope);
        const params = asCodexAppServerRecord(record?.params);
        const itemObserved = record?.method === 'item/started' || record?.method === 'item/completed';
        const exactCompletedItem =
          record?.method === 'item/completed' && params?.threadId === threadId && params?.turnId === activeTurnId;
        if (exactCompletedItem && this.deps.freshnessController?.observeProtocolItem) {
          const observation = classifyCodexProtocolItem(envelope);
          if (observation) {
            try {
              await this.deps.freshnessController.observeProtocolItem(observation);
            } catch {
              // Protocol telemetry must not abort provider work.
            }
          }
        }
        if (record?.method === 'turn/started' || itemObserved) {
          yield this.lifecycle.event(
            this.lifecycle.transition('active', {
              threadId,
              turnId: activeTurnId,
              ...(itemObserved ? { itemObserved: true } : {}),
              ...(classifyCodexAppServerToolSurface(envelope) ? { toolSurfaceObserved: true } : {}),
            }),
          );
        } else {
          yield this.lifecycle.event();
        }
        const boundary = classifyCodexSafeBoundary(envelope);
        if (
          boundary &&
          boundary.threadId === threadId &&
          boundary.turnId === activeTurnId &&
          this.deps.freshnessController
        ) {
          try {
            activeNotice = await this.deps.freshnessController.prepare(boundary);
            if (activeNotice) {
              await this.deliverNotice(activeNotice, threadId);
              activeNotice = null;
            }
          } catch {
            // Freshness is an attention aid; Redis/telemetry failure cannot abort provider work.
            activeNotice = null;
          }
        }

        if (isCodexAppServerTokenUsageNotification(record)) {
          latestUsage = mapCodexAppServerTokenUsage(asCodexAppServerRecord(record?.params)?.tokenUsage) ?? latestUsage;
        }

        // F296 B4b (kimi review A4): a compaction can also arrive *during* the
        // turn (auto-compact). The pre-turn drain only covers the gap between
        // turns, so without this the event would be consumed as an ordinary
        // item and the epoch would never advance — leaving the next projection
        // hot when it must be cold. Binding is checked against the runtime we
        // actually bound; a compaction for any other thread is ignored here.
        const midTurnCompaction = mapCodexAppServerCompactionObservation(envelope);
        if (midTurnCompaction && midTurnCompaction.runtimeSessionId === threadId) {
          yield { type: 'app_server.context_compaction', observation: midTurnCompaction };
        }

        const mapped = mapCodexAppServerNotification(envelope);
        await this.observeUnsupportedNotification(envelope);
        if (mapped?.type === 'turn.completed' && latestUsage) mapped.usage = latestUsage;
        if (mapped) yield mapped;
        if (record?.method === 'turn/completed') {
          runtimeInteraction?.close('provider_cancelled');
          try {
            await this.deps.freshnessController?.markTurnCompleted(activeTurnId);
          } catch {
            // Preserve provider terminal truth even when freshness persistence is unavailable.
          }
          const completedTurn = asCodexAppServerRecord(params?.turn);
          const completedStatus = completedTurn?.status;
          const failureReason =
            completedStatus === 'failed' ? codexAppServerErrorMessage(completedTurn?.error) : undefined;
          const terminalStage: CodexAppServerLifecycleStage =
            completedStatus === 'failed' ? 'failed' : completedStatus === 'interrupted' ? 'interrupted' : 'completed';
          if (completedStatus === 'interrupted') {
            // An app-server can acknowledge the interrupt while retaining its
            // stale active-turn slot. Never return that process to the warm pool.
            transportDisposition = 'evict';
          }
          this.lifecycle.markAuthoritativeTerminal();
          yield this.lifecycle.event(
            this.lifecycle.transition(terminalStage, {
              threadId,
              turnId: activeTurnId,
              ...(failureReason ? { failureReason } : {}),
            }),
          );
          if (completedStatus === 'failed') {
            throw new Error(failureReason);
          }
          break;
        }
      }
    } catch (error) {
      runtimeInteraction?.close('transport_lost');
      const failure = error instanceof Error ? error : new Error(String(error));
      if (activeNotice && this.deps.freshnessController) {
        try {
          await this.deps.freshnessController.markMissed(activeNotice, 'transport_failed');
        } catch {
          // Preserve the original provider/transport failure as terminal truth.
        }
      }
      const failed = this.lifecycle.transitionToFailure(failure.message);
      if (failed) yield this.lifecycle.event(failed);
      throw failure;
    } finally {
      runtimeInteraction?.close('provider_cancelled');
      const { closing, closed } = await closeCodexAppServerTransport(
        this.deps.wire,
        this.lifecycle,
        this.pumpPromise,
        input.signal,
        abortHandler,
        (error) => this.rejectPending(error),
        transportDisposition,
      );
      yield this.lifecycle.event(closing);
      yield this.lifecycle.event(closed);
    }
  }

  /**
   * F296 B4a/B4b: consume compaction notifications already buffered for the
   * bound runtime, before the final prompt is built.
   *
   * Only events whose envelope threadId equals the runtime we actually bound
   * are taken; a compaction for some other thread is left in the stream and can
   * never advance this invocation's epoch.
   */
  private drainBufferedCompactions(threadId: string): ProviderCompactionObservation[] {
    const observations: ProviderCompactionObservation[] = [];
    this.notifications.takeBuffered((value) => {
      const observation = mapCodexAppServerCompactionObservation(value);
      if (!observation || observation.runtimeSessionId !== threadId) return false;
      observations.push(observation);
      return true;
    });
    return observations;
  }

  private async deliverNotice(notice: PreparedFreshnessNotice, threadId: string): Promise<void> {
    if (!this.deps.freshnessController) return;
    let result: JsonObject | null;
    try {
      result = asCodexAppServerRecord(
        await this.request('turn/steer', {
          threadId,
          expectedTurnId: notice.expectedTurnId,
          input: [{ type: 'text', text: notice.text }],
        }),
      );
    } catch (error) {
      const reason: ProviderNativeFreshnessMissReason = /turn|active/i.test(codexAppServerErrorMessage(error))
        ? 'turn_mismatch'
        : 'rpc_rejected';
      await this.deps.freshnessController.markMissed(notice, reason);
      return;
    }
    const acceptedTurnId = result?.turnId;
    if (typeof acceptedTurnId !== 'string' || acceptedTurnId !== notice.expectedTurnId) {
      await this.deps.freshnessController.markMissed(notice, 'turn_mismatch');
      return;
    }
    // Transport acceptance is already truth at this point. If durable telemetry
    // is unavailable, let the caller's freshness fail-open guard absorb the
    // persistence error; never relabel an accepted steer as rpc_rejected.
    await this.deps.freshnessController.commitDelivered(notice, { acceptedTurnId });
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    if (this.pumpFailure) return Promise.reject(this.pumpFailure);
    if (this.pumpEnded) return Promise.reject(new Error('Codex app-server stream is already closed'));
    const id = this.nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject, method, params }),
    );
    // The stream can close while the transport write is still in flight. Mark the
    // response promise handled now; the returned write chain still propagates it.
    void promise.catch(() => {});
    return this.write({ id, method, params })
      .then(() => {
        if (this.pumpFailure) throw this.pumpFailure;
        if (this.pumpEnded) throw new Error('Codex app-server stream is already closed');
        return promise;
      })
      .catch((error) => {
        this.pending.delete(id);
        throw error;
      });
  }

  private async pump(runtimeInteraction: CodexRuntimeInteractionRunState | null): Promise<void> {
    try {
      for await (const value of this.deps.wire.read()) {
        const message = asCodexAppServerRecord(value);
        if (!message) continue;
        await this.deps.onEnvelope?.('inbound', message);
        if (typeof message.id === 'number' && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          if (Object.hasOwn(message, 'error')) {
            // F296 B4a: a JSON-RPC error is a provider verdict, not a broken
            // pipe. Type it so continuity classification never has to guess.
            const errorRecord = asCodexAppServerRecord(message.error);
            const code = errorRecord?.code;
            pending.reject(
              new CodexAppServerRpcError({
                message: codexAppServerErrorMessage(message.error),
                method: pending.method,
                ...(typeof code === 'number' ? { code } : {}),
              }),
            );
          } else {
            if (pending.method === 'turn/start') {
              const params = asCodexAppServerRecord(pending.params);
              const result = asCodexAppServerRecord(message.result);
              const turn = asCodexAppServerRecord(result?.turn);
              if (typeof params?.threadId === 'string' && typeof turn?.id === 'string') {
                runtimeInteraction?.bindProviderTurn({ threadId: params.threadId, turnId: turn.id });
              }
            }
            pending.resolve(message.result);
          }
          continue;
        }
        if (typeof message.id === 'number' && typeof message.method === 'string') {
          if (runtimeInteraction) {
            runtimeInteraction.dispatch(
              message,
              (response) => this.write(response),
              (failure) => this.failDetachedRuntimeInteraction(failure),
            );
          } else {
            const response = respondToCodexAppServerRequest(message);
            if (response) await this.write(response);
          }
          continue;
        }
        if (typeof message.method === 'string') this.notifications.push(message);
      }
      this.pumpEnded = true;
      runtimeInteraction?.close('transport_lost');
      this.notifications.end();
      this.rejectPending(new Error('Codex app-server stream closed'));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.pumpFailure = failure;
      this.pumpEnded = true;
      runtimeInteraction?.close('transport_lost');
      this.notifications.end(failure);
      this.rejectPending(failure);
      throw failure;
    }
  }

  private async write(message: JsonObject): Promise<void> {
    await this.deps.onEnvelope?.('outbound', message);
    await this.deps.wire.write(message);
  }

  private async observeUnsupportedNotification(envelope: unknown): Promise<void> {
    const method = boundedUnsupportedCodexAppServerNotificationMethod(envelope);
    if (!method || this.observedUnsupportedNotificationMethods.has(method)) return;
    if (this.observedUnsupportedNotificationMethods.size >= 8) return;
    this.observedUnsupportedNotificationMethods.add(method);
    try {
      await this.deps.onUnsupportedNotification?.({ method });
    } catch {
      // Runtime health telemetry must never abort provider work.
    }
  }

  private failDetachedRuntimeInteraction(failure: Error): void {
    this.pumpFailure = failure;
    this.pumpEnded = true;
    this.notifications.end(failure);
    this.rejectPending(failure);
    void this.deps.wire.terminate?.().catch(() => {});
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
