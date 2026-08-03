import type { ProviderNativeFreshnessMissReason } from '../../freshness/FreshnessAttentionEventLog.js';
import type {
  ActiveInvocationFreshnessController,
  PreparedFreshnessNotice,
} from '../../freshness/FreshnessNoticeBroker.js';
import type { AgentCarrierSession } from '../../types.js';
import {
  asCodexAppServerRecord,
  type CodexAppServerJsonObject,
  codexAppServerErrorMessage,
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
import { classifyCodexAppServerToolSurface, classifyCodexSafeBoundary } from './codex-app-server-boundary.js';
import { buildCodexAppServerThreadParams, closeCodexAppServerTransport } from './codex-app-server-client-helpers.js';

export type {
  CodexAppServerLifecycleEvent,
  CodexAppServerLifecycleSnapshot,
  CodexAppServerLifecycleStage,
} from './CodexAppServerLifecycle.js';

type JsonObject = CodexAppServerJsonObject;
type RequestId = number;

export interface CodexAppServerRunInput {
  prompt: string;
  thread: { kind: 'start' } | { kind: 'resume'; threadId: string };
  model?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  developerInstructions?: string;
  config?: JsonObject;
  imagePaths?: readonly string[];
  signal?: AbortSignal;
  /** Inactivity timeout. Zero keeps the F118 manual-cancel-only default. */
  timeoutMs?: number;
  /** Grace after turn/interrupt before the transport process is terminated. */
  interruptGraceMs?: number;
  /** Zero-based transport recovery attempt, projected with lifecycle events. */
  recoveryAttempt?: number;
  /**
   * Provider-internal continuation instruction. App-server receives this as
   * application context with no user input item, so recovery cannot append a
   * synthetic user message to the native thread.
   */
  recoveryInstruction?: string;
}

export interface CodexAppServerClientDeps {
  wire: AgentCarrierSession;
  freshnessController?: ActiveInvocationFreshnessController;
  onEnvelope?: (direction: 'inbound' | 'outbound', envelope: JsonObject) => void | Promise<void>;
  onLifecycle?: (snapshot: CodexAppServerLifecycleSnapshot) => void;
  now?: () => number;
}

const DEFAULT_INTERRUPT_GRACE_MS = 1_500;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class CodexAppServerClient {
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly notifications = new CodexAppServerNotificationQueue();
  private nextRequestId = 1;
  private pumpPromise: Promise<void> | null = null;
  private pumpFailure: Error | null = null;
  private pumpEnded = false;
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
    this.pumpPromise = this.pump();
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
        capabilities: recoveryInstruction ? { experimentalApi: true } : {},
      });
      await this.write({ method: 'initialized' });
      yield this.lifecycle.event(this.lifecycle.transition('initialized'));
      this.lifecycle.armInactivityTimeout(timeoutMs, timeoutHandler);

      const threadResult = asCodexAppServerRecord(
        input.thread.kind === 'resume'
          ? await this.request(
              'thread/resume',
              buildCodexAppServerThreadParams(input, { threadId: input.thread.threadId }),
            )
          : await this.request('thread/start', buildCodexAppServerThreadParams(input)),
      );
      const thread = asCodexAppServerRecord(threadResult?.thread);
      const threadId = thread?.id;
      if (typeof threadId !== 'string') throw new Error('Codex app-server did not return a thread id');
      activeThreadId = threadId;
      yield this.lifecycle.event(this.lifecycle.transition('thread_ready', { threadId }));
      this.lifecycle.armInactivityTimeout(timeoutMs, timeoutHandler);
      yield { type: 'thread.started', thread_id: threadId };

      this.lifecycle.patch({ turnStartSent: true });
      const turnResult = asCodexAppServerRecord(
        await this.request('turn/start', {
          threadId,
          input: recoveryInstruction
            ? []
            : [
                { type: 'text', text: input.prompt },
                ...(input.imagePaths ?? []).map((path) => ({ type: 'localImage', path })),
              ],
          ...(recoveryInstruction
            ? {
                additionalContext: {
                  'cat-cafe.capacity-recovery': {
                    kind: 'application',
                    value: recoveryInstruction,
                  },
                },
              }
            : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
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

        if (record?.method === 'thread/tokenUsage/updated') {
          latestUsage = mapCodexAppServerTokenUsage(asCodexAppServerRecord(record.params)?.tokenUsage) ?? latestUsage;
        }

        const mapped = mapCodexAppServerNotification(envelope);
        if (mapped?.type === 'turn.completed' && latestUsage) mapped.usage = latestUsage;
        if (mapped) yield mapped;
        if (record?.method === 'turn/completed') {
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
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
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

  private async pump(): Promise<void> {
    try {
      for await (const value of this.deps.wire.read()) {
        const message = asCodexAppServerRecord(value);
        if (!message) continue;
        await this.deps.onEnvelope?.('inbound', message);
        if (typeof message.id === 'number' && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          if (Object.hasOwn(message, 'error')) pending.reject(new Error(codexAppServerErrorMessage(message.error)));
          else pending.resolve(message.result);
          continue;
        }
        if (typeof message.id === 'number' && typeof message.method === 'string') {
          const response = respondToCodexAppServerRequest(message);
          if (response) await this.write(response);
          continue;
        }
        if (typeof message.method === 'string') this.notifications.push(message);
      }
      this.pumpEnded = true;
      this.notifications.end();
      this.rejectPending(new Error('Codex app-server stream closed'));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.pumpFailure = failure;
      this.pumpEnded = true;
      this.notifications.end(failure);
      this.rejectPending(failure);
      throw failure;
    }
  }

  private async write(message: JsonObject): Promise<void> {
    await this.deps.onEnvelope?.('outbound', message);
    await this.deps.wire.write(message);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
