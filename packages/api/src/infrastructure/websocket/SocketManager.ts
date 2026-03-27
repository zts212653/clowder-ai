/**
 * Socket.io Manager
 * 管理 WebSocket 连接和消息广播
 */

import { Server as HttpServer } from 'node:http';
import { createCatId } from '@cat-cafe/shared';
import { Server, Socket } from 'socket.io';
import { resolveFrontendCorsOrigins } from '../../config/frontend-origin.js';
import type {
  CancelResult,
  InvocationTracker,
} from '../../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { AgentMessage } from '../../domains/cats/services/types.js';
import { createModuleLogger } from '../logger.js';

const log = createModuleLogger('ws');

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
  private multiMentionOrchestrator: {
    abortByThread(threadId: string): number;
    abortBySlot?(threadId: string, catId: string): number;
  } | null;

  constructor(httpServer: HttpServer, invocationTracker?: InvocationTracker) {
    this.invocationTracker = invocationTracker ?? null;
    this.multiMentionOrchestrator = null;
    const corsOrigins = resolveFrontendCorsOrigins(process.env, console);
    this.io = new Server(httpServer, {
      cors: {
        origin: corsOrigins,
        credentials: true,
      },
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      const authUserId = typeof socket.handshake.auth?.userId === 'string' ? socket.handshake.auth.userId.trim() : '';
      const queryUserId = typeof socket.handshake.query.userId === 'string' ? socket.handshake.query.userId.trim() : '';
      const userId = authUserId || queryUserId || 'anonymous';
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
      if (userId !== 'anonymous') {
        socket.join(`user:${userId}`);
      }

      socket.on('disconnect', () => {
        log.info({ socketId: socket.id }, 'Client disconnected');
      });

      socket.on('join_room', (room: string) => {
        // Validate room name format — only allow known prefixes
        if (!/^(thread:|worktree:|preview:global$|workspace:global$|user:)/.test(room)) {
          log.warn({ socketId: socket.id, room }, 'Attempted to join invalid room');
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
          }
          // F108 + F086: Also abort multi-mention dispatches for this specific cat
          this.multiMentionOrchestrator?.abortBySlot?.(data.threadId, data.catId);
        } else {
          // Backward compat: cancel all slots in thread
          this.invocationTracker.cancelAll(data.threadId);
          this.multiMentionOrchestrator?.abortByThread(data.threadId);
          log.info({ threadId: data.threadId, socketId: socket.id, userId }, 'Cancelled all invocations');
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
