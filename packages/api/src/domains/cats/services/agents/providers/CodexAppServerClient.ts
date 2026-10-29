import { randomUUID } from 'node:crypto';
import { deploymentDefaults } from '@cat-cafe/shared';
import { normalizeJsonUnicode } from '../../../../../utils/json-unicode.js';
import {
  CodexActiveWriterRecoveryError,
  type CodexNativeResumeReplacementProvenance,
} from '../../runtime-session/CodexSessionReplacementProvenance.js';
import type {
  AgentCarrierSession,
  AgentClientActiveRunDispatchRegistration,
  AgentClientActiveRunHandle,
  LiveProviderInputOutcome,
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
import { type CodexLiveRunPort, CodexLiveStartupCancelledError, isLiveDraftEvent } from './CodexLiveRunPort.js';
import { CodexLiveTurnInput, type LiveProviderInput } from './CodexLiveTurnInput.js';
import { assertCodexRequiredToolsAvailable } from './CodexRequiredToolsPreflight.js';
import type { CodexRuntimeInteractionContext } from './CodexRuntimeInteractionAdapter.js';
import {
  type CodexRuntimeInteractionRunState,
  createCodexRuntimeInteractionRunState,
} from './CodexRuntimeInteractionRun.js';
import { createCodexSubexecutionTracker, isExactCodexRootTurnCompletion } from './CodexSubexecutionTracker.js';
import { classifyCodexAppServerToolSurface, classifyCodexSafeBoundary } from './codex-app-server-boundary.js';
import {
  buildCodexAppServerThreadParams,
  type CodexAppServerApprovalsReviewer,
  closeCodexAppServerTransport,
} from './codex-app-server-client-helpers.js';
import {
  CodexAppServerRequestError,
  CodexAppServerRpcError,
  CodexAppServerTurnStartTimeoutError,
} from './codex-app-server-rpc-error.js';
import { inspectCodexInput, readCodexTurnMetadata } from './codex-history-reader.js';

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
  requireExactResume?: boolean;
  /** F317: explicit Host-owned continuous call. Ordinary invocations remain single-turn. */
  live?: CodexLiveRunPort;
  prompt: CodexAppServerPromptSource;
  thread: { kind: 'start' } | { kind: 'resume'; threadId: string };
  model?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  developerInstructions?: string;
  /** Server-qualified (`serverName::toolName`) dependencies checked against the effective thread inventory before turn/start. */
  requiredTools?: readonly string[];
  config?: JsonObject;
  /** Same-host account/configuration fence, before any thread/model/turn operation. */
  validateConfiguration?: (
    request: (method: string, params: JsonObject) => Promise<unknown>,
    config: JsonObject,
  ) => Promise<void>;
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
  /** Runner-owned deadline for startup only; never times out a running turn. */
  startupCheckSignal?: AbortSignal;
  /** Inactivity timeout. Zero keeps the F118 manual-cancel-only default. */
  timeoutMs?: number;
  /** Grace after turn/interrupt before the transport process is terminated. */
  interruptGraceMs?: number;
  /** Zero-based transport recovery attempt, projected with lifecycle events. */
  recoveryAttempt?: number;
  /** Zero-based ownership retry count; only the first conflict may retire a stale affinity host. */
  activeWriterAttempt?: number;
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
  prepareLiveRequest?: (input: LiveProviderInput) => PreparedProviderRequestV1;
  onLiveInputOutcome?: (receipt: LiveProviderInputOutcome) => Promise<void>;
  beforeProviderLaunch?: (request: PreparedProviderRequestV1) => Promise<ProviderRequestGenerationCommitV1>;
  /** F306: one provider-neutral interaction surface bound to this exact invocation. */
  runtimeInteraction?: Omit<CodexRuntimeInteractionContext, 'signal'>;
  /** #1354: lifecycle-owned registration for this exact accepted provider turn. */
  activeRunDispatch?: AgentClientActiveRunDispatchRegistration;
}

export interface CodexAppServerClientDeps {
  wire: AgentCarrierSession;
  onEnvelope?: (direction: 'inbound' | 'outbound', envelope: JsonObject) => void | Promise<void>;
  onUnsupportedNotification?: (observation: { method: string }) => void | Promise<void>;
  onLifecycle?: (snapshot: CodexAppServerLifecycleSnapshot) => void;
  now?: () => number;
}

const DEFAULT_INTERRUPT_GRACE_MS = 1_500;
// Receipt only: accepted turns retain the separate manual-cancel-only default.
const TURN_START_RECEIPT_TIMEOUT_MS = 120_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** F296 B4a: lets a JSON-RPC error name the call it rejected. */
  method: string;
  params: JsonObject;
  sent?: boolean;
  receiptTimer?: ReturnType<typeof setTimeout>;
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
  private readonly observedTurnIds = new Map<string, Set<string>>();
  private readonly completeTurnBaselines = new Set<string>();
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
    if (this.deps.wire.hostAcquisitionMode) input.live?.observeHostAcquisition?.(this.deps.wire.hostAcquisitionMode);
    const runtimeInteraction = createCodexRuntimeInteractionRunState(input.runtimeInteraction, input.approvalsReviewer);
    this.pumpPromise = this.pump(runtimeInteraction);
    // Pending requests / notifications propagate the same failure; attach immediately
    // so carrier shutdown grace cannot expose it as unhandled under Node strict mode.
    void this.pumpPromise.catch(() => {});
    let latestUsage: JsonObject | null = null;
    let activeThreadId: string | null = null;
    let activeTurnId: string | null = null;
    let activeRunDispatchOpen = false;
    const inputReadCallbacks = new Map<string, { turnId: string; notify: () => Promise<void>; observing: boolean }>();
    let releaseActiveRunDispatch: (() => void) | undefined;
    let transportDisposition: 'release' | 'evict' = 'release';
    let liveHasPendingChildren = false;
    const liveEnd = Symbol('live-end');
    const liveFailure = Symbol('live-failure');
    let liveFinished = false;
    let liveError: Error | undefined;
    let runClosed = false;
    let boundaryOpen = false;
    const assertLiveStartupActive = (): void => {
      if (!input.live) return;
      input.live.startupSignal?.throwIfAborted();
      input.signal?.throwIfAborted();
      if (liveError) throw liveError;
      if (liveFinished) throw new CodexLiveStartupCancelledError();
    };
    const canSubmitLiveInput = () =>
      Boolean(input.live) &&
      !runClosed &&
      !liveFinished &&
      !liveError &&
      !input.signal?.aborted &&
      input.live?.acceptsInput?.() !== false;
    const liveInputs = new CodexLiveTurnInput({
      enqueue: (value) => this.notifications.push(value),
      isOpen: canSubmitLiveInput,
      request: (method, params) => this.request(method, params),
      ...(input.prepareLiveRequest ? { prepare: input.prepareLiveRequest } : {}),
      ...(input.beforeProviderLaunch ? { commit: input.beforeProviderLaunch } : {}),
      ...(input.onLiveInputOutcome ? { outcome: input.onLiveInputOutcome } : {}),
    });
    void input.live?.finished.then(
      () => {
        liveFinished = true;
        if (!runClosed) this.notifications.push(liveEnd);
      },
      (error: unknown) => {
        liveError = error instanceof Error ? error : new Error(String(error));
        if (!runClosed) this.notifications.push(liveFailure);
      },
    );
    const timeoutMs = Math.max(0, input.timeoutMs ?? 0);
    const interruptGraceMs = Math.max(0, input.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS);
    let accountCheckComplete = false;
    const recoveryInstruction = input.recoveryInstruction?.trim();
    const abortHandler = (): void => {
      runtimeInteraction?.close('provider_cancelled');
      if (!this.lifecycle.snapshot().turnStartSent) {
        this.rejectPending(
          input.signal?.reason instanceof Error ? input.signal.reason : new Error('Codex startup cancelled'),
        );
        void this.deps.wire.close().catch(() => {});
        return;
      }
      void this.lifecycle.interrupt(activeThreadId, activeTurnId, 'user_cancel', interruptGraceMs);
    };
    const startupAbortHandler = (): void => {
      this.rejectPending(
        input.startupCheckSignal?.reason instanceof Error
          ? input.startupCheckSignal.reason
          : new Error('Codex startup deadline exceeded'),
      );
      void this.deps.wire.close().catch(() => {});
    };
    const timeoutHandler = (): void => {
      void this.lifecycle.interrupt(activeThreadId, activeTurnId, 'timeout', interruptGraceMs);
    };
    input.signal?.addEventListener('abort', abortHandler, { once: true });
    input.startupCheckSignal?.addEventListener('abort', startupAbortHandler, { once: true });
    const childSpawned = this.lifecycle.transition('child_spawned', { recoveryAttempt: input.recoveryAttempt ?? 0 });
    yield this.lifecycle.event(childSpawned);
    if (input.signal?.aborted) abortHandler();
    this.lifecycle.armInactivityTimeout(timeoutMs, timeoutHandler);
    try {
      input.signal?.throwIfAborted();
      input.startupCheckSignal?.throwIfAborted();
      const preflightRequest = (method: string, params: JsonObject) =>
        this.request(method, params).catch((error) => {
          if (
            error instanceof CodexAppServerRpcError ||
            error instanceof CodexLiveStartupCancelledError ||
            input.signal?.aborted ||
            input.startupCheckSignal?.aborted
          )
            throw error;
          throw new CodexAppServerRequestError(method, error);
        });
      await preflightRequest('initialize', {
        clientInfo: { name: 'cat-cafe', title: `${deploymentDefaults.brand.displayName}`, version: '1' },
        capabilities: recoveryInstruction || input.collaborationMode || input.live ? { experimentalApi: true } : {},
      });
      await this.write({ method: 'initialized' });
      yield this.lifecycle.event(this.lifecycle.transition('initialized'));
      this.lifecycle.armInactivityTimeout(timeoutMs, timeoutHandler);

      yield { type: 'app_server.account_check', stage: 'checking' };
      input.startupCheckSignal?.throwIfAborted();
      await input.validateConfiguration?.(preflightRequest, input.config ?? {});
      await validateCodexAccountConfiguration(this.deps.wire, preflightRequest, input.config ?? {});
      input.signal?.throwIfAborted();
      input.startupCheckSignal?.throwIfAborted();
      input.startupCheckSignal?.removeEventListener('abort', startupAbortHandler);
      accountCheckComplete = true;
      yield { type: 'app_server.account_check', stage: 'ready' };

      if (input.live) {
        // config/read without cwd sees global servers, while a resumed thread
        // also loads project servers at its persisted cwd. Fence the exact scope.
        let liveCwd = input.cwd;
        if (!liveCwd && input.thread.kind === 'resume') {
          const stored = asCodexAppServerRecord(
            await this.request('thread/read', { threadId: input.thread.threadId, includeTurns: false }),
          );
          const thread = asCodexAppServerRecord(stored?.thread);
          if (thread?.id !== input.thread.threadId || typeof thread.cwd !== 'string' || !thread.cwd.trim())
            throw new Error('Live native cwd unavailable');
          liveCwd = thread.cwd;
        }
        liveCwd ??= process.cwd();
        const loaded = asCodexAppServerRecord(
          await this.request('config/read', { cwd: liveCwd, includeLayers: false }),
        );
        if (!asCodexAppServerRecord(loaded?.config)) throw new Error('Live native config unavailable');
        const configured = asCodexAppServerRecord(asCodexAppServerRecord(loaded?.config)?.mcp_servers) ?? {};
        const allowed = asCodexAppServerRecord(input.config?.mcp_servers) ?? {};
        input = {
          ...input,
          cwd: liveCwd,
          config: {
            ...input.config,
            mcp_servers: {
              ...Object.fromEntries(Object.keys(configured).map((name) => [name, { enabled: false }])),
              ...allowed,
            },
            'features.shell_tool': false,
            'features.apply_patch_freeform': false,
            'apps._default.enabled': false,
          },
        };
      }

      if (input.thread.kind === 'resume') this.completeTurnBaselines.delete(input.thread.threadId);
      const verdict = await resolveCodexAppServerThread({
        thread: input.thread,
        params: buildCodexAppServerThreadParams(
          input,
          input.thread.kind === 'resume' ? { threadId: input.thread.threadId, excludeTurns: true } : undefined,
        ),
        startParams: buildCodexAppServerThreadParams(input),
        requireExactResume: input.requireExactResume || Boolean(recoveryInstruction),
        ...(input.resumeReplacement ? { resumeReplacement: input.resumeReplacement } : {}),
        // A reused affinity host reaches this point only after its local lease
        // was released. A writer conflict here is therefore provider-side stale
        // ownership, not this process concurrently writing the same turn.
        localLiveLease: false,
        request: (method, params) => this.request(method, params),
        now: this.deps.now ?? Date.now,
        onResumeMetadata: async (threadId) => {
          // The standalone pagination RPC is non-experimental. A resume's
          // initialTurnsPage would require broadening the session capability set.
          for await (const turn of readCodexTurnMetadata((method, params) => this.request(method, params), threadId)) {
            this.rememberTurn(threadId, turn.id);
          }
          this.completeTurnBaselines.add(threadId);
        },
      });
      const threadId = verdict.threadId;
      if (verdict.kind === 'started' || verdict.kind === 'replaced') this.completeTurnBaselines.add(threadId);
      activeThreadId = threadId;
      if (input.collaborationMode) {
        const adopted = asCodexAppServerRecord(verdict.raw);
        const mode = input.collaborationMode;
        const model = mode.settings.model || (typeof adopted?.model === 'string' ? adopted.model : '');
        if (!model) throw new Error('Codex collaboration mode requires an adopted model');
        const effort = mode.settings.reasoning_effort ?? adopted?.reasoningEffort;
        input = {
          ...input,
          collaborationMode: {
            ...mode,
            settings: {
              ...mode.settings,
              model,
              ...(typeof effort === 'string' && effort ? { reasoning_effort: effort } : {}),
            },
          },
        };
      }
      yield this.lifecycle.event(this.lifecycle.transition('thread_ready', { threadId }));
      this.lifecycle.armInactivityTimeout(timeoutMs, timeoutHandler);
      yield {
        type: 'thread.started',
        thread_id: threadId,
        ...(verdict.kind === 'replaced' ? { session_replacement: verdict.replacement } : {}),
      };
      yield { type: 'app_server.continuity_verdict', verdict };

      await assertCodexRequiredToolsAvailable({
        threadId,
        requiredTools: input.requiredTools ?? [],
        request: (method, params) => this.request(method, params),
      });
      assertLiveStartupActive();

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
      // Stop/failure may arrive while deferred Host context is being built.
      // A closed call must not reserve a new request or start a native turn.
      assertLiveStartupActive();
      const preparedRequest = isRecoveryTurn
        ? input.prepareRecoveryRequest?.(recoveryInstruction as string)
        : input.prepareRequest?.(promptBytes, (input.recoveryAttempt ?? 0) > 0 ? 'transient_cli_exit' : undefined);
      if (input.beforeProviderLaunch) {
        if (!preparedRequest) throw new Error('codex_app_server_request_evidence_unavailable');
        await input.beforeProviderLaunch(preparedRequest);
      }
      assertLiveStartupActive();
      const submittedPrompt = preparedRequest ? requireExactPreparedProviderMessage(preparedRequest) : promptBytes;

      let resolveInitialInputRead!: (at: number) => void;
      const initialInputRead = new Promise<number>((resolve) => {
        resolveInitialInputRead = resolve;
      });
      const initialClientId = input.activeRunDispatch && !isRecoveryTurn ? randomUUID() : undefined;
      this.lifecycle.patch({ turnStartSent: true });
      const turnResult = asCodexAppServerRecord(
        await this.request('turn/start', {
          threadId,
          ...(initialClientId ? { clientUserMessageId: initialClientId } : {}),
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
      if (initialClientId) {
        inputReadCallbacks.set(initialClientId, {
          turnId: activeTurnId,
          notify: async () => resolveInitialInputRead(Date.now()),
          observing: false,
        });
      }
      assertLiveStartupActive();
      const subexecutionTracker = createCodexSubexecutionTracker({
        binding: { threadId, turnId: activeTurnId },
        emitChildTurnStarts: Boolean(input.live),
        readThread: (childThreadId) => this.request('thread/read', { threadId: childThreadId, includeTurns: false }),
        ...(this.deps.now ? { now: this.deps.now } : {}),
      });
      const bindAcceptedLiveTurn = async (accepted: string): Promise<void> => {
        if (accepted === activeTurnId || !input.live) return;
        activeTurnId = accepted;
        latestUsage = null;
        // The RPC receipt is authoritative even when retries arrive before turn/started.
        this.lifecycle.transition('turn_accepted', {
          threadId,
          turnId: accepted,
          turnAccepted: true,
          itemObserved: false,
          toolSurfaceObserved: false,
        });
        subexecutionTracker.advanceRootTurn(accepted);
        await input.live.observe({ method: 'turn/started', params: { threadId, turn: { id: accepted } } });
      };
      const deliverAtBoundary = async (kind: 'idle' | 'tool_complete' | 'turn_complete'): Promise<void> => {
        if (!input.live?.onSafeBoundary || !input.live.hasPendingInboxWake?.()) return;
        boundaryOpen = true;
        try {
          await input.live.onSafeBoundary(kind);
        } finally {
          boundaryOpen = false;
        }
      };
      yield this.lifecycle.event(
        this.lifecycle.transition('turn_accepted', { threadId, turnId: activeTurnId, turnAccepted: true }),
      );
      this.lifecycle.armInactivityTimeout(timeoutMs, timeoutHandler);
      if (input.activeRunDispatch) {
        const invocationId = input.activeRunDispatch.invocationId;
        const handle: AgentClientActiveRunHandle = {
          provider: 'openai_codex',
          carrier: 'codex_app_server',
          threadId,
          turnId: activeTurnId,
        };
        activeRunDispatchOpen = true;
        const release = input.activeRunDispatch.register({
          invocationId,
          capabilities: { append: true, steer: true, inputReadReceipt: true },
          ...(initialClientId ? { initialInputRead } : {}),
          handle,
          dispatch: async (dispatchInput, options) => {
            if (options.expectedInvocationId !== invocationId) {
              return { accepted: false, reason: 'active_run_mismatch', acceptance: 'not_accepted' };
            }
            if (!activeRunDispatchOpen || activeThreadId !== threadId || activeTurnId !== handle.turnId) {
              return { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' };
            }
            const text = dispatchInput.text.trim();
            const imagePaths = dispatchInput.imagePaths?.filter((path) => path.length > 0) ?? [];
            if (!text && imagePaths.length === 0)
              return { accepted: false, reason: 'invalid_input', acceptance: 'not_accepted' };
            const clientUserMessageId = dispatchInput.deliveryId ?? randomUUID();
            if (dispatchInput.onInputRead) {
              inputReadCallbacks.set(clientUserMessageId, {
                turnId: handle.turnId,
                notify: dispatchInput.onInputRead,
                observing: false,
              });
            }
            try {
              const result = asCodexAppServerRecord(
                await this.request('turn/steer', {
                  threadId,
                  expectedTurnId: handle.turnId,
                  clientUserMessageId,
                  input: [
                    ...(text ? [{ type: 'text', text: dispatchInput.text }] : []),
                    ...imagePaths.map((path) => ({ type: 'localImage', path })),
                  ],
                }),
              );
              if (result?.turnId === handle.turnId) return { accepted: true, handle };
              // The request crossed the provider boundary. Preserve exact consumption
              // observation even when its response cannot confirm this turn.
              return { accepted: false, reason: 'active_run_mismatch', acceptance: 'unknown' };
            } catch (error) {
              return {
                accepted: false,
                reason: error instanceof CodexAppServerRpcError ? 'provider_rejected' : 'exception',
                acceptance: 'unknown',
              };
            }
          },
          inspectInput: (deliveryId) =>
            inspectCodexInput((method, params) => this.request(method, params), threadId, handle.turnId, deliveryId),
        });
        if (typeof release === 'function') releaseActiveRunDispatch = release;
      }
      if (input.live) {
        await input.live.observe({ method: 'turn/started', params: { threadId, turn: { id: activeTurnId } } });
        await input.live.ready(threadId, {
          request: (method, params) => this.request(method, params),
          submitText: (text, sourceMessageId) => liveInputs.submitText(text, sourceMessageId),
          submitContextAtBoundary: async (text, sourceRefs, contextKind, signal, authorize, clientUserMessageId) => {
            if (!boundaryOpen) throw new Error('Live context outside native safe boundary');
            const accepted = await liveInputs.submitContextAtBoundary(
              text,
              sourceRefs,
              contextKind,
              signal,
              authorize,
              threadId,
              activeTurnId,
              clientUserMessageId,
            );
            await bindAcceptedLiveTurn(accepted);
            return accepted;
          },
          wakeBoundary: () => liveInputs.queueTick(),
        });
      }
      if (input.signal?.aborted) {
        void this.lifecycle.interrupt(threadId, activeTurnId, 'user_cancel', interruptGraceMs);
      }

      for (;;) {
        if (this.pumpFailure instanceof CodexAppServerTurnStartTimeoutError) throw this.pumpFailure;
        const next = await this.notifications.next();
        if (next.done) throw new Error('Codex app-server stream ended before turn completion');
        const envelope = next.value;
        let acceptedLiveTurn: string | null = null;
        const isText = liveInputs.isSubmission(envelope);
        const isIdleTick = liveInputs.consumeTick(envelope);
        if (isText || isIdleTick) {
          if (isText) acceptedLiveTurn = await liveInputs.sendText(envelope, threadId, activeTurnId);
          else if (
            (!activeTurnId && input.live?.hasPendingInboxWake?.()) ||
            input.live?.hasPendingPageResultWake?.() ||
            input.live?.hasPendingOwnerVoiceWake?.()
          )
            await deliverAtBoundary('idle');
          if (acceptedLiveTurn) await bindAcceptedLiveTurn(acceptedLiveTurn);
          continue;
        }
        if (envelope === liveFailure) throw liveError;
        if (envelope === liveEnd) {
          if (activeTurnId) {
            transportDisposition = 'evict';
            throw new Error('live_finished_with_active_native_turn');
          }
          this.lifecycle.markAuthoritativeTerminal();
          yield { type: 'turn.completed', status: 'completed' };
          yield this.lifecycle.event(this.lifecycle.transition('completed', { threadId }));
          break;
        }
        const record = asCodexAppServerRecord(envelope);
        const params = asCodexAppServerRecord(record?.params);
        if (input.live && params?.threadId === threadId) {
          const started = asCodexAppServerRecord(params.turn);
          if (record?.method === 'turn/started' && typeof started?.id === 'string' && started.id !== activeTurnId) {
            latestUsage = null;
            activeTurnId = started.id;
            subexecutionTracker.advanceRootTurn(activeTurnId);
          }
          if (record) await input.live.observe(record);
        }
        const subexecution = await subexecutionTracker.observe(envelope);
        if (input.live) liveHasPendingChildren = subexecutionTracker.hasPendingChildren();
        if (subexecution.scope === 'foreign') continue;
        this.lifecycle.touch(timeoutMs, timeoutHandler);
        if (subexecution.event) {
          await input.live?.observeSubexecution?.(subexecution.event);
          // Live already commits these facts through its Host-owned Message projection.
          // Ordinary invocations retain F306's streaming/collector path.
          if (!input.live?.observeSubexecution) yield subexecution.event;
        }
        if (subexecution.scope === 'child') continue;
        const itemObserved = record?.method === 'item/started' || record?.method === 'item/completed';
        const exactCompletedItem =
          record?.method === 'item/completed' && params?.threadId === threadId && params?.turnId === activeTurnId;
        if (exactCompletedItem) {
          const item = asCodexAppServerRecord(params?.item);
          const clientId =
            item?.type === 'userMessage' && typeof item.clientId === 'string' ? item.clientId : undefined;
          const receipt = clientId ? inputReadCallbacks.get(clientId) : undefined;
          if (clientId && receipt && receipt.turnId === params?.turnId && !receipt.observing) {
            // Native completion means this exact pending input entered prompt
            // history; turn/steer acknowledgement alone does not prove consumption.
            receipt.observing = true;
            void Promise.resolve()
              .then(receipt.notify)
              .then(() => inputReadCallbacks.delete(clientId))
              .catch(() => {
                // Persistence never blocks provider/Stop; a replay may retry it.
                receipt.observing = false;
              });
          }
        }
        if (record?.method === 'turn/started' || itemObserved) {
          yield this.lifecycle.event(
            this.lifecycle.transition('active', {
              threadId,
              ...(activeTurnId ? { turnId: activeTurnId } : {}),
              ...(itemObserved ? { itemObserved: true } : {}),
              ...(classifyCodexAppServerToolSurface(envelope) ? { toolSurfaceObserved: true } : {}),
            }),
          );
        } else {
          yield this.lifecycle.event();
        }
        const boundary = classifyCodexSafeBoundary(envelope);
        if (boundary && boundary.threadId === threadId && boundary.turnId === activeTurnId)
          await deliverAtBoundary('tool_complete');

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
        if (mapped && !(input.live && isLiveDraftEvent(mapped))) yield mapped;
        if (activeTurnId && isExactCodexRootTurnCompletion(envelope, { threadId, turnId: activeTurnId })) {
          if (input.live) {
            const completed = asCodexAppServerRecord(params?.turn);
            if (completed?.status === 'failed') {
              transportDisposition = 'evict';
              throw new Error(codexAppServerErrorMessage(completed.error));
            }
            // This is a child completion, not the end of the Host invocation.
            yield {
              type: 'app_server.live_turn_completed',
              turnId: activeTurnId,
              ...(latestUsage ? { usage: latestUsage } : {}),
            };
            activeTurnId = null;
            await deliverAtBoundary('turn_complete');
            if (liveFinished && !activeTurnId) this.notifications.push(liveEnd);
            continue;
          }
          activeRunDispatchOpen = false;
          runtimeInteraction?.close('provider_cancelled');
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
      if (
        error instanceof CodexActiveWriterRecoveryError &&
        input.activeWriterAttempt === 0 &&
        this.deps.wire.reusedSessionHost === true
      ) {
        transportDisposition = 'evict';
      }
      const failed = this.lifecycle.transitionToFailure(failure.message);
      if (failed) yield this.lifecycle.event(failed);
      throw failure;
    } finally {
      input.startupCheckSignal?.removeEventListener('abort', startupAbortHandler);
      activeRunDispatchOpen = false;
      inputReadCallbacks.clear();
      releaseActiveRunDispatch?.();
      runClosed = true;
      liveInputs.close();
      runtimeInteraction?.close('provider_cancelled');
      if (input.live && liveHasPendingChildren) transportDisposition = 'evict';
      const { closing, closed } = await closeCodexAppServerTransport(
        this.deps.wire,
        this.lifecycle,
        this.pumpPromise,
        input.signal,
        abortHandler,
        (error) => this.rejectPending(error),
        transportDisposition,
        accountCheckComplete ? undefined : input.startupCheckSignal,
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

  private request(method: string, params: JsonObject): Promise<unknown> {
    if (this.pumpFailure) return Promise.reject(this.pumpFailure);
    if (this.pumpEnded) return Promise.reject(new Error('Codex app-server stream is already closed'));
    const id = this.nextRequestId++;
    let pending!: PendingRequest;
    const retire = (): void => {
      if (pending.receiptTimer) clearTimeout(pending.receiptTimer);
      this.pending.delete(id);
    };
    const promise = new Promise<unknown>((resolve, reject) => {
      pending = {
        method,
        params,
        resolve: (value) => {
          retire();
          resolve(value);
        },
        reject: (error) => {
          retire();
          reject(error);
        },
      };
      this.pending.set(id, pending);
    });
    // The stream can close while the transport write is still in flight. Mark the
    // response promise handled now, even if the write is still in flight.
    void promise.catch(() => {});
    const writing = this.write({ id, method, params }, () => {
      if (this.pending.get(id) !== pending || this.pumpFailure || this.pumpEnded) {
        throw this.pumpFailure ?? new Error('Codex app-server request closed before send');
      }
      pending.sent = true;
      if (method === 'turn/start') {
        pending.receiptTimer = setTimeout(() => {
          this.failTransport(new CodexAppServerTurnStartTimeoutError(id, TURN_START_RECEIPT_TIMEOUT_MS));
        }, TURN_START_RECEIPT_TIMEOUT_MS);
      }
    });
    void writing.catch((error: unknown) => pending.reject(error instanceof Error ? error : new Error(String(error))));
    if (method === 'turn/start') return promise;
    // Other RPCs retain their existing write-completion semantics.
    return writing.then(() => {
      if (this.pumpFailure) throw this.pumpFailure;
      if (this.pumpEnded) throw new Error('Codex app-server stream is already closed');
      return promise;
    });
  }

  private rememberTurn(threadId: string, turnId: string): void {
    const observed = this.observedTurnIds.get(threadId) ?? new Set<string>();
    observed.add(turnId);
    this.observedTurnIds.set(threadId, observed);
  }

  private observeTurnStartReceipt(
    message: JsonObject,
    runtimeInteraction: CodexRuntimeInteractionRunState | null,
  ): void {
    if (message.method !== 'turn/started') return;
    const params = asCodexAppServerRecord(message.params);
    const turn = asCodexAppServerRecord(params?.turn);
    if (typeof params?.threadId !== 'string' || typeof turn?.id !== 'string' || !turn.id) return;
    const alreadyObserved = this.observedTurnIds.get(params.threadId)?.has(turn.id);
    this.rememberTurn(params.threadId, turn.id);
    if (alreadyObserved || turn.status !== 'inProgress' || !this.completeTurnBaselines.has(params.threadId)) return;
    const candidates = [...this.pending.values()].filter(
      (pending) => pending.method === 'turn/start' && pending.sent && pending.params.threadId === params.threadId,
    );
    // An id-less notification can qualify only the sole sent request for this
    // thread, and never a historical/resume turn or another thread's activity.
    if (candidates.length !== 1) return;
    runtimeInteraction?.bindProviderTurn({ threadId: params.threadId, turnId: turn.id });
    candidates[0]?.resolve({ turn });
  }

  private async pump(runtimeInteraction: CodexRuntimeInteractionRunState | null): Promise<void> {
    try {
      for await (const value of this.deps.wire.read()) {
        const message = asCodexAppServerRecord(value);
        if (!message) continue;
        await this.deps.onEnvelope?.('inbound', message);
        this.observeTurnStartReceipt(message, runtimeInteraction);
        runtimeInteraction?.observe(message);
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
                data: errorRecord?.data,
                ...(typeof code === 'number' ? { code } : {}),
              }),
            );
          } else {
            const result = asCodexAppServerRecord(message.result);
            const thread = asCodexAppServerRecord(result?.thread);
            if (typeof thread?.id === 'string' && Array.isArray(thread.turns)) {
              for (const value of thread.turns) {
                const previous = asCodexAppServerRecord(value);
                if (typeof previous?.id === 'string') this.rememberTurn(thread.id, previous.id);
              }
            }
            if (pending.method === 'turn/start') {
              const params = asCodexAppServerRecord(pending.params);
              const turn = asCodexAppServerRecord(result?.turn);
              if (typeof params?.threadId === 'string' && typeof turn?.id === 'string') {
                this.rememberTurn(params.threadId, turn.id);
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
              (failure) => this.failTransport(failure),
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

  private async write(message: JsonObject, onSending?: () => void): Promise<void> {
    // Rust rejects lone UTF-16 surrogates without a JSON-RPC response. Fail here
    // instead of waiting forever, and never rewrite bytes committed by F299.
    if (normalizeJsonUnicode(message) !== message) {
      throw new Error('Codex app-server request contains invalid Unicode (unpaired UTF-16 surrogate)');
    }
    await this.deps.onEnvelope?.('outbound', message);
    onSending?.();
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

  private failTransport(failure: Error): void {
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

import { validateCodexAccountConfiguration } from './codex-app-server-account-configuration.js';
