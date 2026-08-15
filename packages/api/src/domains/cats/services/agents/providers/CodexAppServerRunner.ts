import { codexAppServerRecovery } from '../../../../../infrastructure/telemetry/instruments.js';
import {
  buildCodexActiveWriterDiagnostics,
  CodexActiveWriterRecoveryError,
  type CodexSessionReplacementProvenance,
} from '../../runtime-session/CodexSessionReplacementProvenance.js';
import type { AgentCarrierSessionFactory, AgentCarrierSessionOptions } from '../../types.js';
import {
  CodexAppServerClient,
  type CodexAppServerClientDeps,
  type CodexAppServerLifecycleSnapshot,
  type CodexAppServerRunInput,
} from './CodexAppServerClient.js';
import {
  type CodexCapacityRecoveryAnchor,
  type CodexCapacityRecoveryBlockReason,
  CodexCapacityRecoveryCheckpoint,
  type CodexCapacityRecoveryCheckpointSnapshot,
} from './CodexCapacityRecoveryCheckpoint.js';

export interface CodexAppServerRecoveryEvent {
  type: 'app_server.recovery';
  reason: 'pre_turn_transport' | 'active_writer_reborn' | 'model_capacity';
  attempt: number;
  retryBudget: number;
  delayMs?: number;
  threadId?: string;
  phase?: 'pre_tool' | 'post_tool';
  /** Present only for active_writer_reborn; causal evidence is not inferred from the seal reason later. */
  replacement?: CodexSessionReplacementProvenance;
}

export interface CodexAppServerRecoveryBlockedEvent {
  type: 'app_server.recovery_blocked';
  reason: CodexCapacityRecoveryBlockReason;
  retryBudget: number;
  attempt: number;
  checkpoint: CodexCapacityRecoveryCheckpointSnapshot;
}

export interface CodexAppServerRunnerOptions {
  sessionFactory: AgentCarrierSessionFactory;
  sessionOptions: AgentCarrierSessionOptions;
  runInput: CodexAppServerRunInput;
  clientDeps?: Omit<CodexAppServerClientDeps, 'wire' | 'onLifecycle'> & {
    onLifecycle?: CodexAppServerClientDeps['onLifecycle'];
  };
  retryBudget?: number;
  activeWriterRetryDelayMs?: number;
  modelCapacityRetryDelaysMs?: readonly number[];
  recoveryAnchor?: CodexCapacityRecoveryAnchor;
}

const MODEL_CAPACITY_ERROR = 'Selected model is at capacity. Please try a different model.';
const DEFAULT_MODEL_CAPACITY_RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000] as const;
const DEFAULT_ACTIVE_WRITER_RETRY_DELAY_MS = 250;
const MAX_ACTIVE_WRITER_RETRY_DELAY_MS = 5_000;
const MAX_RECOVERY_STEP_CHARS = 160;

function buildModelCapacityRecoveryInstruction(checkpoint: CodexCapacityRecoveryCheckpoint): string {
  const step = checkpoint.nextIncompleteStep()?.step.slice(0, MAX_RECOVERY_STEP_CHARS);
  return [
    'Continue only the interrupted turn.',
    ...(step ? [`Resume this recorded step: ${step}.`] : []),
    'Do not select other work.',
    'Verify current state before repeating any external side effect.',
    'Do not mention this recovery.',
  ].join(' ');
}

function canRetryBeforeTurn(
  lifecycle: CodexAppServerLifecycleSnapshot | null,
  signal: AbortSignal | undefined,
): boolean {
  if (signal?.aborted) return false;
  if (!lifecycle) return true;
  if (lifecycle.interruptReason) return false;
  return !lifecycle.turnStartSent && !lifecycle.turnAccepted && !lifecycle.itemObserved;
}

function canRetryModelCapacity(
  lifecycle: CodexAppServerLifecycleSnapshot | null,
  signal: AbortSignal | undefined,
  checkpoint: CodexCapacityRecoveryCheckpoint,
): boolean {
  if (signal?.aborted) return false;
  if (!lifecycle) return false;
  if (lifecycle.interruptReason) return false;
  if (!lifecycle.turnAccepted) return false;
  if (!checkpoint.hasExactAnchor()) return false;
  if (!lifecycle.toolSurfaceObserved) return true;
  return checkpoint.canResumeAfterTools();
}

function isModelCapacityMessage(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === MODEL_CAPACITY_ERROR;
}

function isModelCapacityError(error: unknown): boolean {
  return error instanceof Error && isModelCapacityMessage(error.message);
}

function isActiveWriterError(error: unknown): boolean {
  return error instanceof Error && /^thread \S+ already has an active writer$/.test(error.message.trim());
}

function isModelCapacityTurnFailure(value: unknown): boolean {
  if (!value) return false;
  if (typeof value !== 'object') return false;
  const record = value as { type?: unknown; error?: unknown };
  if (record.type !== 'turn.failed') return false;
  if (!record.error) return false;
  if (typeof record.error !== 'object') return false;
  return isModelCapacityMessage((record.error as { message?: unknown }).message);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Codex app-server recovery was aborted');
}

async function waitForRecoveryDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal ? abortError(signal) : new Error('Codex app-server recovery was aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Owns bounded recovery for Codex app-server.
 *
 * Transport recovery stays fenced before turn/start. The one accepted-turn
 * exception is the provider's exact model-capacity terminal: it may resume the
 * same thread only with exact Clowder AI task coordinates. After tool surface,
 * it additionally requires a latest plan and a fully terminal tool ledger.
 */
export async function* runCodexAppServerWithRecovery(options: CodexAppServerRunnerOptions): AsyncGenerator<unknown> {
  const retryBudget = Math.max(0, options.retryBudget ?? 1);
  const capacityRetryDelays = (options.modelCapacityRetryDelaysMs ?? DEFAULT_MODEL_CAPACITY_RETRY_DELAYS_MS).map(
    (delayMs) => Math.max(0, delayMs),
  );
  const activeWriterRetryDelayMs = Math.min(
    MAX_ACTIVE_WRITER_RETRY_DELAY_MS,
    Math.max(1, options.activeWriterRetryDelayMs ?? DEFAULT_ACTIVE_WRITER_RETRY_DELAY_MS),
  );
  let transportAttempt = 0;
  let capacityAttempt = 0;
  let recoveryAttempt = 0;
  let currentThread = options.runInput.thread;
  let resumeThreadId = currentThread.kind === 'resume' ? currentThread.threadId : undefined;
  let recoveryInstruction: string | undefined;
  let imagePaths = options.runInput.imagePaths;
  const checkpoint = new CodexCapacityRecoveryCheckpoint(options.recoveryAnchor);
  checkpoint.setNativeThreadId(resumeThreadId);

  for (;;) {
    let lifecycle: CodexAppServerLifecycleSnapshot | null = null;
    const terminalBuffer: unknown[] = [];
    let capacityTerminalObserved = false;
    try {
      // Protocol cancellation is owned by CodexAppServerClient. Passing the
      // caller signal into the raw carrier would race turn/interrupt with SIGINT.
      const { signal: _transportSignal, ...transportOptions } = options.sessionOptions;
      const wire = await options.sessionFactory({
        ...transportOptions,
        ...(currentThread.kind === 'resume' ? { sessionId: currentThread.threadId } : {}),
      });
      const client = new CodexAppServerClient({
        ...options.clientDeps,
        wire,
        onLifecycle: (snapshot) => {
          lifecycle = snapshot;
          options.clientDeps?.onLifecycle?.(snapshot);
        },
      });
      const runInput: CodexAppServerRunInput = {
        ...options.runInput,
        thread: currentThread,
        recoveryAttempt,
        ...(recoveryInstruction ? { recoveryInstruction } : { recoveryInstruction: undefined }),
        ...(imagePaths ? { imagePaths } : { imagePaths: undefined }),
      };
      for await (const event of client.run(runInput)) {
        checkpoint.observe(event);
        if (isModelCapacityTurnFailure(event)) {
          capacityTerminalObserved = true;
          terminalBuffer.push(event);
          continue;
        }
        if (capacityTerminalObserved) {
          terminalBuffer.push(event);
          continue;
        }
        if (isThreadStartedEvent(event)) {
          checkpoint.setNativeThreadId(event.thread_id);
          wire.rememberSession?.(event.thread_id);
        }
        yield event;
      }
      for (const event of terminalBuffer) yield event;
      if (capacityAttempt > 0) {
        codexAppServerRecovery.add(1, { status: 'recovered' });
      }
      return;
    } catch (error) {
      const failedAt = lifecycle as CodexAppServerLifecycleSnapshot | null;
      if (failedAt?.threadId) {
        resumeThreadId = failedAt.threadId;
        currentThread = { kind: 'resume', threadId: resumeThreadId };
        checkpoint.setNativeThreadId(resumeThreadId);
      }

      const activeWriterThreadId = currentThread.kind === 'resume' ? currentThread.threadId : undefined;
      if (
        activeWriterThreadId &&
        isActiveWriterError(error) &&
        !capacityTerminalObserved &&
        transportAttempt < retryBudget &&
        canRetryBeforeTurn(failedAt, options.runInput.signal)
      ) {
        transportAttempt++;
        recoveryAttempt++;
        const detectedAt = Date.now();
        const detection =
          error instanceof CodexActiveWriterRecoveryError
            ? error.detection
            : {
                previousNativeThreadId: activeWriterThreadId,
                detectedAt,
                diagnostics: buildCodexActiveWriterDiagnostics({
                  threadId: activeWriterThreadId,
                  observedAt: detectedAt,
                  localLiveLease: false,
                  threadRead: { outcome: 'failed' },
                }),
              };
        const replacement: CodexSessionReplacementProvenance = {
          cause: 'active_writer_reborn',
          previousNativeThreadId: detection.previousNativeThreadId,
          detectedAt: detection.detectedAt,
          attempt: transportAttempt,
          diagnostics: detection.diagnostics,
        };
        codexAppServerRecovery.add(1, { status: 'active_writer_reborn' });
        yield {
          type: 'app_server.recovery',
          reason: 'active_writer_reborn',
          attempt: transportAttempt,
          retryBudget,
          delayMs: activeWriterRetryDelayMs,
          threadId: activeWriterThreadId,
          replacement,
        } satisfies CodexAppServerRecoveryEvent;
        await waitForRecoveryDelay(activeWriterRetryDelayMs, options.runInput.signal);
        currentThread = { kind: 'start' };
        resumeThreadId = undefined;
        continue;
      }

      if (
        isModelCapacityError(error) &&
        capacityTerminalObserved &&
        capacityAttempt < capacityRetryDelays.length &&
        canRetryModelCapacity(failedAt, options.runInput.signal, checkpoint)
      ) {
        const delayMs = capacityRetryDelays[capacityAttempt];
        const phase = failedAt?.toolSurfaceObserved ? 'post_tool' : 'pre_tool';
        capacityAttempt++;
        recoveryAttempt++;
        recoveryInstruction = buildModelCapacityRecoveryInstruction(checkpoint);
        imagePaths = undefined;
        codexAppServerRecovery.add(1, { status: `model_capacity_${phase}` });
        yield {
          type: 'app_server.recovery',
          reason: 'model_capacity',
          attempt: capacityAttempt,
          retryBudget: capacityRetryDelays.length,
          delayMs,
          phase,
          ...(resumeThreadId ? { threadId: resumeThreadId } : {}),
        } satisfies CodexAppServerRecoveryEvent;
        await waitForRecoveryDelay(delayMs, options.runInput.signal);
        continue;
      }

      if (
        !capacityTerminalObserved &&
        !isActiveWriterError(error) &&
        transportAttempt < retryBudget &&
        canRetryBeforeTurn(failedAt, options.runInput.signal)
      ) {
        transportAttempt++;
        recoveryAttempt++;
        codexAppServerRecovery.add(1, { status: 'pre_turn' });
        yield {
          type: 'app_server.recovery',
          reason: 'pre_turn_transport',
          attempt: transportAttempt,
          retryBudget,
          ...(resumeThreadId ? { threadId: resumeThreadId } : {}),
        } satisfies CodexAppServerRecoveryEvent;
        continue;
      }

      if (isModelCapacityError(error) && capacityTerminalObserved) {
        const reason: CodexCapacityRecoveryBlockReason =
          failedAt?.toolSurfaceObserved && checkpoint.hasInFlightTool()
            ? 'blocked_inflight_tool'
            : !checkpoint.hasExactAnchor()
              ? 'checkpoint_incomplete'
              : failedAt?.toolSurfaceObserved
                ? checkpoint.canResumeAfterTools()
                  ? 'budget_exhausted'
                  : 'checkpoint_incomplete'
                : 'budget_exhausted';
        codexAppServerRecovery.add(1, { status: reason });
        yield {
          type: 'app_server.recovery_blocked',
          reason,
          retryBudget: capacityRetryDelays.length,
          attempt: capacityAttempt,
          checkpoint: checkpoint.snapshot(),
        } satisfies CodexAppServerRecoveryBlockedEvent;
      }

      for (const event of terminalBuffer) yield event;
      throw error;
    }
  }
}

function isThreadStartedEvent(value: unknown): value is { type: 'thread.started'; thread_id: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as { type?: unknown; thread_id?: unknown };
  return record.type === 'thread.started' && typeof record.thread_id === 'string';
}
