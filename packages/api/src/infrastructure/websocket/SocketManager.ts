/**
 * Socket.io Manager
 * 管理 WebSocket 连接和消息广播
 */

import { Server as HttpServer } from 'node:http';
import { createCatId, isExplicitStopGesture, isExplicitStopSourceControl, type RoomJoinAck } from '@cat-cafe/shared';
import { Server, Socket } from 'socket.io';
import { isOriginAllowed, resolveFrontendCorsOrigins } from '../../config/frontend-origin.js';
import {
  type AgentSessionMutexLike,
  agentSessionMutex,
} from '../../domains/cats/services/agents/invocation/AgentSessionMutex.js';
import type {
  CancelResult,
  InvocationTracker,
} from '../../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { AgentMessage } from '../../domains/cats/services/types.js';
import { createModuleLogger } from '../logger.js';
import { BroadcastRateMonitor, type BroadcastRateMonitorOptions } from './BroadcastRateMonitor.js';
import { ThreadSequencer } from './ThreadSequencer.js';

const log = createModuleLogger('ws');

interface QueueProcessorLike {
  canReleaseSlotForUser(threadId: string, catId: string, userId: string): boolean;
  clearPause(threadId: string, catId?: string): void;
  releaseSlot(threadId: string, catId: string): void;
  suppressAutoResume(threadId: string, catId: string, executionIds?: readonly string[]): void;
}

type RoomJoinAcknowledge = (result: RoomJoinAck) => void;

function validateRoomJoin(roomInput: unknown, userId: string): RoomJoinAck {
  const room = typeof roomInput === 'string' ? roomInput : '';
  if (!room || !/^(thread:|worktree:|preview:global$|workspace:global$|workspace:navigate:ack$|user:)/.test(room)) {
    return { ok: false, room, error: 'invalid_room' };
  }
  if (room.startsWith('user:') && room !== `user:${userId}`) {
    return { ok: false, room, error: 'forbidden_room' };
  }
  if ((room === 'workspace:global' || room === 'workspace:navigate:ack' || room === 'preview:global') && !userId) {
    return { ok: false, room, error: 'authentication_required' };
  }
  return { ok: true, room };
}

/**
 * Build the sequence of AgentMessages to broadcast after a successful cancel.
 * Pure function — extracted for testability (avoids duplicating logic in tests).
 */
export function buildCancelMessages(result: CancelResult): AgentMessage[] {
  if (!result.cancelled) return [];
  const catIds = result.catIds.length > 0 ? result.catIds : ['opus'];
  const primaryCatId = catIds[0] ?? 'opus';
  const now = Date.now();
  const messages: AgentMessage[] = [];

  // Single system_info to avoid "cancel chorus"
  messages.push({
    type: 'system_info',
    catId: createCatId(primaryCatId),
    content: '⏹ 已取消',
    timestamp: now,
  });

  // Per-cat done to ensure each cat's loading state is cleared
  for (const catId of catIds) {
    messages.push({
      type: 'done',
      catId: createCatId(catId),
      isFinal: true,
      timestamp: now,
    });
  }

  return messages;
}

export class SocketManager {
  private io: Server;
  private invocationTracker: InvocationTracker | null;
  private queueProcessor: QueueProcessorLike | null;
  private agentSessionMutex: AgentSessionMutexLike;
  private multiMentionOrchestrator: {
    abortByThread(threadId: string): number;
    abortBySlot?(threadId: string, catId: string): number;
  } | null;
  /**
   * F183 Phase C — thread-scoped monotonic sequence number (KD-9).
   * Each broadcastAgentMessage increments per-thread counter and injects seq
   * into the emitted payload. Client uses seq for gap detection + catchup.
   *
   * In-memory only — single-instance deploy assumption (KD-9 拒绝 multi-instance
   * 分布式 sequencer over-engineering). API restart resets seq; client sees
   * `seq=1` after restart, treats it as seed (no false gap).
   *
   * Extracted to ThreadSequencer for unit testability without HttpServer.
   */
  private sequencer: ThreadSequencer = new ThreadSequencer();
  /**
   * F183 Phase C2/C3 — per-thread emit rate monitor (observability for
   * backpressure root cause investigation). Logs structured warnings when
   * a thread sustains > 200 events/sec for 1s. Replaces unfindable historical
   * literal "in-process app-server event stream lagged; dropped N events"
   * (字面源 grep 不到 — 见 BroadcastRateMonitor.ts 注释 + AC-C3 spec)。
   * Public for test/admin introspection via getStats(threadId).
   */
  readonly rateMonitor: BroadcastRateMonitor;

  constructor(
    httpServer: HttpServer,
    invocationTracker?: InvocationTracker,
    rateMonitorOptions?: BroadcastRateMonitorOptions,
  ) {
    this.invocationTracker = invocationTracker ?? null;
    this.queueProcessor = null;
    this.agentSessionMutex = agentSessionMutex;
    this.multiMentionOrchestrator = null;
    // F183 Phase C2/C3 — backpressure observability. onWarn forwards to module
    // logger as structured `broadcast_rate_warn` event (replaces unfindable
    // historical literal "in-process app-server event stream lagged ...").
    this.rateMonitor = new BroadcastRateMonitor({
      ...(rateMonitorOptions ?? {}),
      onWarn:
        rateMonitorOptions?.onWarn ??
        ((event) => {
          log.warn(
            {
              event: 'broadcast_rate_warn',
              threadId: event.threadId,
              windowCount: event.windowCount,
              threshold: event.threshold,
              windowMs: event.windowMs,
              timestamp: event.timestamp,
            },
            'Broadcast rate exceeded threshold (per-thread sliding window)',
          );
        }),
    });
    const corsOrigins = resolveFrontendCorsOrigins(process.env, console);
    this.io = new Server(httpServer, {
      cors: {
        origin: corsOrigins,
        credentials: true,
      },
      // F156: Guard WebSocket upgrades. Socket.IO's `cors` only protects HTTP
      // long-polling; WebSocket upgrades bypass CORS entirely. This hook is
      // the real security boundary against cross-site WebSocket hijacking.
      // Ref: OpenClaw ClawJacked (2026-02), CVE-2026-25253.
      allowRequest: (req, callback) => {
        const origin = req.headers.origin;
        if (!origin) {
          // No Origin header = non-browser client (curl, MCP, etc.).
          // In single-user mode this is safe to allow.
          callback(null, true);
          return;
        }
        if (isOriginAllowed(origin, corsOrigins)) {
          callback(null, true);
          return;
        }
        log.warn({ origin }, 'WebSocket upgrade rejected: origin not in allowlist');
        callback('Origin not allowed', false);
      },
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      // F156: Server determines identity — never trust client-supplied userId.
      // In single-user mode, all connections are 'default-user'.
      // F077 will replace this with session/cookie-based identity.
      const userId = 'default-user';
      log.info({ socketId: socket.id, userId }, 'Client connected');
      log.debug(
        {
          socketId: socket.id,
          transport: socket.conn.transport.name,
          remoteAddress: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent'],
        },
        'Client handshake details',
      );

      // F39: Auto-join user-scoped room for emitToUser (multi-tab support)
      // F156: userId is always 'default-user' in single-user mode (F077 will
      // derive it from session). Auto-join is unconditional.
      socket.join(`user:${userId}`);

      socket.on('disconnect', () => {
        log.info({ socketId: socket.id }, 'Client disconnected');
      });

      socket.on('join_room', async (roomInput: unknown, acknowledgeInput?: unknown) => {
        const acknowledge =
          typeof acknowledgeInput === 'function' ? (acknowledgeInput as RoomJoinAcknowledge) : undefined;
        const validation = validateRoomJoin(roomInput, userId);
        if (!validation.ok) {
          log.warn({ socketId: socket.id, room: roomInput, userId, error: validation.error }, 'Room join rejected');
          acknowledge?.(validation);
          return;
        }
        const { room } = validation;
        try {
          await socket.join(room);
          acknowledge?.({ ok: true, room });
          log.info({ socketId: socket.id, room }, 'Joined room');
        } catch (error) {
          log.error({ socketId: socket.id, room, error }, 'Failed to join room');
          acknowledge?.({ ok: false, room, error: 'join_failed' });
        }
      });

      socket.on('leave_room', (room: string) => {
        socket.leave(room);
        log.info({ socketId: socket.id, room }, 'Left room');
      });

      const seenCancelActionIds = new Set<string>();
      socket.on(
        'cancel_invocation',
        (data: {
          threadId?: string;
          catId?: string;
          origin?: string;
          actionId?: string;
          clientInstanceId?: string;
          sourceControl?: string;
          gesture?: string;
          trustedGesture?: boolean;
        }) => {
          if (!this.invocationTracker || !data?.threadId) return;
          const hasExplicitProvenance =
            data.origin === 'explicit_stop' &&
            typeof data.actionId === 'string' &&
            data.actionId.length > 0 &&
            data.actionId.length <= 200 &&
            typeof data.clientInstanceId === 'string' &&
            data.clientInstanceId.length > 0 &&
            data.clientInstanceId.length <= 200 &&
            isExplicitStopSourceControl(data.sourceControl) &&
            isExplicitStopGesture(data.gesture) &&
            data.trustedGesture === true;
          if (!hasExplicitProvenance) {
            log.warn(
              {
                event: 'f254_unattributed_cancel_rejected',
                socketId: socket.id,
                threadId: data.threadId,
                catId: data.catId ?? null,
                sourceControl: data.sourceControl ?? null,
                gesture: data.gesture ?? null,
                trustedGesture: data.trustedGesture ?? null,
              },
              'Rejected cancel_invocation without explicit Stop provenance',
            );
            return;
          }
          if (seenCancelActionIds.has(data.actionId!)) {
            log.warn(
              { socketId: socket.id, actionId: data.actionId, clientInstanceId: data.clientInstanceId },
              'Rejected duplicate cancel_invocation action',
            );
            return;
          }
          seenCancelActionIds.add(data.actionId!);
          // Only allow cancel if the socket is in the target thread's room
          const room = `thread:${data.threadId}`;
          if (!socket.rooms.has(room)) {
            log.warn({ socketId: socket.id, threadId: data.threadId }, 'Cancel attempt without room membership');
            return;
          }
          // F211-REG6 instrument (observation-only): SocketManager hardcodes 'user_cancel' for every
          // WS cancel_invocation, but the operator reported spurious cancels he never triggered (Timeline
          // 2026-05-29: WS flapped 6× in 2min). msSinceConnect is the discriminator — a cancel arriving
          // milliseconds after a (re)connect is almost certainly reconnect/teardown noise, not a
          // deliberate Stop click. Pin the real trigger before changing any attribution behavior.
          log.info(
            {
              event: 'f211_reg6_ws_cancel_received',
              socketId: socket.id,
              threadId: data.threadId,
              catId: data.catId ?? null,
              scope: data.catId ? 'slot' : 'all',
              msSinceConnect: Date.now() - socket.handshake.issued,
              transport: socket.conn.transport.name,
              origin: data.origin,
              actionId: data.actionId,
              clientInstanceId: data.clientInstanceId,
              sourceControl: data.sourceControl,
              gesture: data.gesture,
              trustedGesture: data.trustedGesture,
            },
            'F211-REG6: cancel_invocation received — capturing real trigger provenance (genuine Stop vs reconnect-spurious)',
          );
          if (data.catId) {
            // F108: Slot-specific cancel
            const result = this.invocationTracker.cancel(data.threadId, data.catId, userId, 'user_cancel');
            const lockRelease = this.agentSessionMutex.forceReleaseByScope(
              {
                threadId: data.threadId,
                userId,
                catId: data.catId,
              },
              { preserveHolderExecutionIds: result.executionIds ?? [] },
            );
            if (lockRelease.releasedHolders > 0 || lockRelease.rejectedWaiters > 0) {
              log.warn(
                { event: 'agent_session_mutex_force_release', reason: 'ws_cancel', ...lockRelease },
                'Released stuck agent session locks after WebSocket cancel',
              );
            }
            const recoveredLockOnly =
              (lockRelease.releasedHolders > 0 || lockRelease.rejectedWaiters > 0) &&
              this.canReleaseSlotForUser(data.threadId, data.catId, userId);
            if (result.cancelled || recoveredLockOnly) {
              // F-parallel-cancel: scope the cancel broadcast + slot cleanup to the REQUESTED cat
              // only. result.catIds carries the whole startAll batch (per-slot stores all catIds),
              // so broadcasting it cleared sibling cats in the UI — this is the most direct cause of
              // "取消一只两只一起取消" from the real Stop button. Mirrors queue.ts:568-575 scoped fix.
              // A recovered mutex is itself a successful terminal action even when the tracker
              // entry has already vanished. Preserve that outcome for buildCancelMessages so the
              // client receives the same done signal as the REST lock-only recovery path.
              const scopedResult = { ...result, cancelled: true, catIds: [data.catId] };
              log.info({ threadId: data.threadId, catId: data.catId }, 'Cancelled slot (scoped)');
              for (const msg of buildCancelMessages(scopedResult)) {
                this.broadcastAgentMessage(msg, data.threadId);
              }
              this.queueProcessor?.clearPause(data.threadId, data.catId);
              this.queueProcessor?.releaseSlot(data.threadId, data.catId);
            }
            // F108 + F086: Also abort multi-mention dispatches for this specific cat
            this.multiMentionOrchestrator?.abortBySlot?.(data.threadId, data.catId);
          } else {
            // F156: Pass userId to cancelAll so it only cancels this user's invocations.
            // cancelAll returns the catIds that were actually cancelled, so we can
            // scope the orchestrator abort to just those cats — not the entire thread.
            // Use 'cancel_all' (not 'user_cancel') so QueueProcessor.executeEntry can
            // distinguish "stop everything" from single-cat cancel. Only 'cancel_all'
            // triggers suppressAutoResume; single-cat 'user_cancel' still auto-resumes.
            const cancelAllResult = this.invocationTracker.cancelAll(data.threadId, userId, 'cancel_all');
            const cancelledCatIds = cancelAllResult.catIds;
            const lockRelease = this.agentSessionMutex.forceReleaseByScope(
              { threadId: data.threadId, userId },
              { preserveHolderExecutionIds: cancelAllResult.executionIds },
            );
            if (lockRelease.releasedHolders > 0 || lockRelease.rejectedWaiters > 0) {
              log.warn(
                { event: 'agent_session_mutex_force_release', reason: 'ws_cancel_all', ...lockRelease },
                'Released stuck agent session locks after WebSocket cancel-all',
              );
            }
            const cancelThreadId = data.threadId;
            const activeTracker = this.invocationTracker;
            const recoveredCatIds = (lockRelease.catIds ?? []).filter((catId) =>
              this.canReleaseSlotForUser(cancelThreadId, catId, userId, activeTracker),
            );
            const terminalCatIds = [...new Set([...cancelledCatIds, ...recoveredCatIds])];
            if (terminalCatIds.length > 0) {
              for (const msg of buildCancelMessages({ cancelled: true, catIds: terminalCatIds })) {
                this.broadcastAgentMessage(msg, data.threadId);
              }
              for (const catId of terminalCatIds) {
                this.queueProcessor?.clearPause(data.threadId, catId);
                this.queueProcessor?.releaseSlot(data.threadId, catId);
                // Suppress auto-resume for BOTH paths:
                // - Queued invocations: executeEntry also sets suppress (belt-and-suspenders)
                // - Direct invocations (messages.ts): only this external call covers them
                //   because they don't go through executeEntry
                // Protected by: cancel_all reason, exact canceled execution IDs, 60s TTL
                const executionId = cancelAllResult.executionIdByCatId?.[catId];
                this.queueProcessor?.suppressAutoResume(data.threadId, catId, executionId ? [executionId] : []);
              }
            }
            // F156 P1-fix: Use per-cat abortBySlot instead of thread-wide abortByThread.
            // abortByThread would kill other users' multi-mention dispatches too.
            for (const catId of terminalCatIds) {
              this.multiMentionOrchestrator?.abortBySlot?.(data.threadId, catId);
            }
            log.info(
              { threadId: data.threadId, socketId: socket.id, userId, cancelledCatIds: terminalCatIds },
              'Cancelled all invocations',
            );
          }
        },
      );
    });
  }

  /** Wire MultiMentionOrchestrator for cancel propagation (set after construction to avoid circular imports). */
  setMultiMentionOrchestrator(orch: {
    abortByThread(threadId: string): number;
    abortBySlot?(threadId: string, catId: string): number;
  }): void {
    this.multiMentionOrchestrator = orch;
  }

  private canReleaseSlotForUser(
    threadId: string,
    catId: string,
    userId: string,
    tracker: InvocationTracker | null = this.invocationTracker,
  ): boolean {
    if (this.queueProcessor) return this.queueProcessor.canReleaseSlotForUser(threadId, catId, userId);
    if (!tracker) return false;
    return !tracker.has(threadId, catId) || tracker.getUserId(threadId, catId) === userId;
  }

  /** Wire QueueProcessor after bootstrap so WebSocket stop can mirror REST cancel cleanup. */
  setQueueProcessor(queueProcessor: QueueProcessorLike): void {
    this.queueProcessor = queueProcessor;
  }

  /** Override the shared agent session lock controller (bootstrap/tests). */
  setAgentSessionMutex(sessionMutex: AgentSessionMutexLike): void {
    this.agentSessionMutex = sessionMutex;
  }

  /**
   * Broadcast agent message to a thread room.
   * Always scoped to a room — defaults to 'thread:default' when threadId is omitted.
   * Never broadcasts globally to prevent cross-thread message leak.
   *
   * F183 Phase C — injects thread-scoped monotonic seq + sequencer epoch into the
   * emitted payload for client gap detection (KD-9). Caller-supplied `seq>0` is
   * preserved as a transport hint (e.g. test fixtures injecting deterministic
   * seq); production callers should leave `seq` undefined and let sequencer
   * assign. Epoch is always overwritten with current sequencer epoch (caller
   * can't fake epoch — server-controlled identity).
   *
   * Cloud R3 P2 fix (2026-05-02): when override is used, bump sequencer to
   * `max(current, override)` so subsequent auto-assigned seqs stay monotonic.
   * Without this, `next()` would reuse lower numbers after override path,
   * causing clients to treat fresh events as 'late'/'gap'.
   */
  broadcastAgentMessage(message: AgentMessage, threadId?: string): void {
    const tid = threadId ?? 'default';
    const room = `thread:${tid}`;
    const seqOverride = message.seq;
    let seq: number;
    if (typeof seqOverride === 'number' && seqOverride > 0) {
      seq = seqOverride;
      // Preserve monotonicity for subsequent auto-assigned seqs (cloud R3 P2)
      this.sequencer.bumpTo(tid, seqOverride);
    } else {
      seq = this.sequencer.next(tid);
    }
    const seqEpoch = this.sequencer.epoch;
    // F183 Phase C2/C3 — record per-thread emit rate; warn callback fires when
    // sliding-window count exceeds threshold (debounced per thread).
    this.rateMonitor.record(tid);
    this.io.to(room).emit('agent_message', { ...message, threadId: tid, seq, seqEpoch });
  }

  broadcastToRoom(room: string | string[], event: string, data: unknown): void {
    this.io.to(room).emit(event, data);
  }

  broadcastToRoomWithAck(room: string, event: string, data: unknown, timeoutMs = 1500): Promise<unknown[]> {
    type AckBroadcastOperator = {
      emit(eventName: string, payload: unknown, callback: (error: Error | null, responses: unknown[]) => void): boolean;
    };
    const operator = this.io.to(room).timeout(timeoutMs) as unknown as AckBroadcastOperator;
    return new Promise((resolve) => {
      operator.emit(event, data, (error, responses) => {
        if (error) {
          log.debug({ room, event, responseCount: responses?.length ?? 0 }, 'Room acknowledgement timed out');
        }
        resolve(Array.isArray(responses) ? responses : []);
      });
    });
  }

  /** F39: Emit to all sockets belonging to a specific user (multi-tab safe). */
  emitToUser(userId: string, event: string, data: unknown): void {
    this.io.to(`user:${userId}`).emit(event, data);
  }

  getIO(): Server {
    return this.io;
  }

  /**
   * Close all WebSocket connections (graceful shutdown).
   */
  close(): void {
    this.io.close();
  }
}
