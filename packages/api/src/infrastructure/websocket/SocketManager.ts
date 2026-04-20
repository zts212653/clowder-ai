/**
 * Socket.io Manager
 * 管理 WebSocket 连接和消息广播
 */

import { Server as HttpServer } from 'node:http';
import { createCatId } from '@cat-cafe/shared';
import { Server, Socket } from 'socket.io';
import { isOriginAllowed, resolveFrontendCorsOrigins } from '../../config/frontend-origin.js';
import type {
  CancelResult,
  InvocationTracker,
} from '../../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { AgentMessage } from '../../domains/cats/services/types.js';
import { createModuleLogger } from '../logger.js';

const log = createModuleLogger('ws');

interface QueueProcessorLike {
  clearPause(threadId: string, catId?: string): void;
  releaseSlot(threadId: string, catId: string): void;
}

/**
 * Build the sequence of AgentMessages to broadcast after a successful cancel.
 * Pure function — extracted for testability (avoids duplicating logic in tests).
 */
export function buildCancelMessages(result: CancelResult): AgentMessage[] {
  if (!result.cancelled) return [];
  const catIds = result.catIds.length > 0 ? result.catIds : ['opus'];
  const now = Date.now();
  const messages: AgentMessage[] = [];

  // Single system_info to avoid "cancel chorus"
  messages.push({
    type: 'system_info',
    catId: createCatId(catIds[0]!),
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
  private multiMentionOrchestrator: {
    abortByThread(threadId: string): number;
    abortBySlot?(threadId: string, catId: string): number;
  } | null;

  constructor(httpServer: HttpServer, invocationTracker?: InvocationTracker) {
    this.invocationTracker = invocationTracker ?? null;
    this.queueProcessor = null;
    this.multiMentionOrchestrator = null;
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

      socket.on('join_room', (room: string) => {
        // Validate room name format — only allow known prefixes
        if (!/^(thread:|worktree:|preview:global$|workspace:global$|user:)/.test(room)) {
          log.warn({ socketId: socket.id, room }, 'Attempted to join invalid room');
          return;
        }
        // F156: Room ACL — user: rooms are identity-scoped
        if (room.startsWith('user:') && room !== `user:${userId}`) {
          log.warn({ socketId: socket.id, room, userId }, 'Room ACL denied: cannot join another user room');
          return;
        }
        // F156 B-3: Global rooms carry metadata (file paths, worktreeIds, preview ports).
        // Require authenticated userId. In single-user mode userId is always set;
        // F077 will add workspace membership check for multi-user.
        if ((room === 'workspace:global' || room === 'preview:global') && !userId) {
          log.warn({ socketId: socket.id, room }, 'Global room requires authentication');
          return;
        }
        socket.join(room);
        log.info({ socketId: socket.id, room }, 'Joined room');
      });

      socket.on('leave_room', (room: string) => {
        socket.leave(room);
        log.info({ socketId: socket.id, room }, 'Left room');
      });

      socket.on('cancel_invocation', (data: { threadId: string; catId?: string }) => {
        if (!this.invocationTracker || !data?.threadId) return;
        // Only allow cancel if the socket is in the target thread's room
        const room = `thread:${data.threadId}`;
        if (!socket.rooms.has(room)) {
          log.warn({ socketId: socket.id, threadId: data.threadId }, 'Cancel attempt without room membership');
          return;
        }
        if (data.catId) {
          // F108: Slot-specific cancel
          const result = this.invocationTracker.cancel(data.threadId, data.catId, userId);
          if (result.cancelled) {
            const catIds = result.catIds.length > 0 ? result.catIds : [data.catId];
            log.info({ threadId: data.threadId, catId: data.catId, cats: catIds }, 'Cancelled slot');
            for (const msg of buildCancelMessages(result)) {
              this.broadcastAgentMessage(msg, data.threadId);
            }
            for (const catId of catIds) {
              this.queueProcessor?.clearPause(data.threadId, catId);
              this.queueProcessor?.releaseSlot(data.threadId, catId);
            }
          }
          // F108 + F086: Also abort multi-mention dispatches for this specific cat
          this.multiMentionOrchestrator?.abortBySlot?.(data.threadId, data.catId);
        } else {
          // F156: Pass userId to cancelAll so it only cancels this user's invocations.
          // cancelAll returns the catIds that were actually cancelled, so we can
          // scope the orchestrator abort to just those cats — not the entire thread.
          const cancelledCatIds = this.invocationTracker.cancelAll(data.threadId, userId);
          if (cancelledCatIds.length > 0) {
            for (const msg of buildCancelMessages({ cancelled: true, catIds: cancelledCatIds })) {
              this.broadcastAgentMessage(msg, data.threadId);
            }
            for (const catId of cancelledCatIds) {
              this.queueProcessor?.clearPause(data.threadId, catId);
              this.queueProcessor?.releaseSlot(data.threadId, catId);
            }
          }
          // F156 P1-fix: Use per-cat abortBySlot instead of thread-wide abortByThread.
          // abortByThread would kill other users' multi-mention dispatches too.
          for (const catId of cancelledCatIds) {
            this.multiMentionOrchestrator?.abortBySlot?.(data.threadId, catId);
          }
          log.info(
            { threadId: data.threadId, socketId: socket.id, userId, cancelledCatIds },
            'Cancelled all invocations',
          );
        }
      });
    });
  }

  /** Wire MultiMentionOrchestrator for cancel propagation (set after construction to avoid circular imports). */
  setMultiMentionOrchestrator(orch: {
    abortByThread(threadId: string): number;
    abortBySlot?(threadId: string, catId: string): number;
  }): void {
    this.multiMentionOrchestrator = orch;
  }

  /** Wire QueueProcessor after bootstrap so WebSocket stop can mirror REST cancel cleanup. */
  setQueueProcessor(queueProcessor: QueueProcessorLike): void {
    this.queueProcessor = queueProcessor;
  }

  /**
   * Broadcast agent message to a thread room.
   * Always scoped to a room — defaults to 'thread:default' when threadId is omitted.
   * Never broadcasts globally to prevent cross-thread message leak.
   */
  broadcastAgentMessage(message: AgentMessage, threadId?: string): void {
    const tid = threadId ?? 'default';
    const room = `thread:${tid}`;
    this.io.to(room).emit('agent_message', { ...message, threadId: tid });
  }

  broadcastToRoom(room: string, event: string, data: unknown): void {
    this.io.to(room).emit(event, data);
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
