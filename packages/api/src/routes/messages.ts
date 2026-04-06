/**
 * Messages API Routes
 * POST /api/messages - 发送消息 (JSON or multipart with images)
 * GET /api/messages - 获取历史消息
 *
 * IMPORTANT: threadId 约束
 * 生产代码应显式包含 threadId（sendMessageSchema 字段 threadId）。
 * 兼容行为：未传 threadId 时会降级到 'default' thread（历史行为）。
 * 跨线程鉴权、InvocationTracker、消息存储都依赖正确的 threadId。
 * 前端应先确保 thread 存在（POST /api/threads）再发消息。
 *
 * ADR-008 S1: 消息写入与猫调用执行解耦。
 * POST 流程: 原子创建 InvocationRecord → 写入用户消息 → 回填 → reply 202 → background 执行
 */

import { randomUUID } from 'node:crypto';
import type { CatId, MessageContent } from '@cat-cafe/shared';
import type { SessionStore } from '@cat-cafe/shared/utils';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getAllCatIdsFromConfig, getDefaultCatId } from '../config/cat-config-loader.js';
import { resolveFrontendBaseUrl } from '../config/frontend-origin.js';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { PersistenceContext } from '../domains/cats/services/agents/routing/route-helpers.js';
import { createGameDriver } from '../domains/cats/services/game/createGameDriver.js';
import type { GameDriver } from '../domains/cats/services/game/GameDriver.js';
import { GameOrchestrator } from '../domains/cats/services/game/GameOrchestrator.js';
import { WerewolfLobby } from '../domains/cats/services/game/werewolf/WerewolfLobby.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import type { AutoSummarizer } from '../domains/cats/services/orchestration/AutoSummarizer.js';
import { getPushNotificationService } from '../domains/cats/services/push/PushNotificationService.js';
import type { DeliveryCursorStore } from '../domains/cats/services/stores/ports/DeliveryCursorStore.js';
import type { IDraftStore } from '../domains/cats/services/stores/ports/DraftStore.js';
import type { IGameStore } from '../domains/cats/services/stores/ports/GameStore.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ISummaryStore } from '../domains/cats/services/stores/ports/SummaryStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { mergeTokenUsage, type TokenUsage } from '../domains/cats/services/types.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import { buildCancelMessages, type SocketManager } from '../infrastructure/websocket/index.js';

/** F088 ISSUE-15: Minimal outbound delivery interface — avoids importing full OutboundDeliveryHook. */
interface OutboundDeliveryHookLike {
  deliver(
    threadId: string,
    content: string,
    catId?: string,
    richBlocks?: unknown[],
    threadMeta?: { threadShortId: string; threadTitle?: string; deepLinkUrl?: string },
    origin?: string,
    triggerMessageId?: string,
  ): Promise<void>;
}

/** F088 ISSUE-15: Minimal streaming hook interface. */
interface StreamingHookLike {
  onStreamStart(threadId: string, catId?: string, invocationId?: string): Promise<void>;
  onStreamChunk(threadId: string, accumulatedText: string, invocationId?: string): Promise<void>;
  onStreamEnd(threadId: string, finalText: string, invocationId?: string): Promise<void>;
  cleanupPlaceholders?(threadId: string, invocationId?: string): Promise<void>;
  /** F151: Signal adapters that an invocation's delivery batch is complete. */
  notifyDeliveryBatchDone?(threadId: string, chainDone: boolean): Promise<void>;
}

import { normalizeErrorMessage } from '../utils/normalize-error.js';
import { resolveUserId } from '../utils/request-identity.js';
import { buildGameSeats, parseGameCommand, sanitizeCatIds } from './game-command-interceptor.js';
import { sendMessageSchema } from './messages.schema.js';
import { parseMultipart } from './parse-multipart.js';

const STREAM_START_TIMEOUT_MS = 5_000;

/**
 * Dependencies injected via Fastify plugin options.
 * socketManager is injected to avoid circular import from index.ts.
 */
export interface MessagesRoutesOptions {
  registry: InvocationRegistry;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  router: AgentRouter;
  sessionStore?: SessionStore;
  deliveryCursorStore?: DeliveryCursorStore;
  threadStore?: IThreadStore;
  uploadDir?: string;
  invocationTracker?: InvocationTracker;
  invocationRecordStore?: IInvocationRecordStore;
  autoSummarizer?: AutoSummarizer;
  summaryStore?: ISummaryStore;
  /** #80: Streaming draft store for F5 recovery */
  draftStore?: IDraftStore;
  /** F39: Message queue for delivery-mode routing */
  invocationQueue?: InvocationQueue;
  /** F39: Queue processor for auto-dequeue on invocation complete */
  queueProcessor?: QueueProcessor;
  /** F101: Game store for /game command interception */
  gameStore?: IGameStore;
  /** F101: Injectable auto-player for lifecycle-safe teardown in tests/routes */
  autoPlayer?: Pick<GameDriver, 'startLoop' | 'stopAllLoops'>;
  /** F088 ISSUE-15: Outbound delivery hook for connector platforms (late-bound after gateway bootstrap) */
  outboundHook?: OutboundDeliveryHookLike;
  /** F088 ISSUE-15: Streaming hook for connector platforms (late-bound after gateway bootstrap) */
  streamingHook?: StreamingHookLike;
}

const log = createModuleLogger('routes/messages');

const getMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(10000).default(50),
  /** Cursor: "timestamp:id" or legacy plain timestamp */
  before: z.string().optional(),
  threadId: z.string().min(1).max(100).optional(),
});

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;

const DECISION_NOTIFICATION_RE = /\b(review|lgtm|merge|pr)\b/i;

export function shouldMarkDecisionNotification(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    DECISION_NOTIFICATION_RE.test(content) ||
    content.includes('合入') ||
    content.includes('审批') ||
    content.includes('批准') ||
    content.includes('决策') ||
    content.includes('请确认') ||
    content.includes('是否允许') ||
    lower.includes('can merge')
  );
}

export const messagesRoutes: FastifyPluginAsync<MessagesRoutesOptions> = async (app, opts) => {
  const uploadDir = opts.uploadDir ?? process.env.UPLOAD_DIR ?? './uploads';

  // Register multipart parser for image uploads
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  });

  // Shared AgentRouter injected via opts (created in index.ts)
  const router = opts.router;
  const gameOrchestrator = opts.gameStore
    ? new GameOrchestrator({
        gameStore: opts.gameStore,
        socketManager: opts.socketManager,
        messageStore: opts.messageStore,
      })
    : null;
  const gameAutoPlayer = gameOrchestrator
    ? (opts.autoPlayer ??
      createGameDriver({
        gameNarratorEnabled: false,
        legacyDeps: {
          gameStore: opts.gameStore!,
          orchestrator: gameOrchestrator,
          messageStore: opts.messageStore,
        },
      }))
    : null;

  if (gameAutoPlayer) {
    app.addHook('onClose', async () => {
      gameAutoPlayer.stopAllLoops();
    });
  }

  // POST /api/messages - 发送消息（WebSocket 广播）
  app.post('/api/messages', async (request, reply) => {
    let content: string;
    let legacyUserId: string | undefined;
    let threadId: string | undefined;
    let contentBlocks: MessageContent[] | undefined;
    let idempotencyKey: string | undefined;
    // F35: Whisper fields
    let whisperVisibility: 'whisper' | undefined;
    let whisperRecipients: readonly CatId[] | undefined;

    // F39: Delivery mode
    let deliveryMode: 'immediate' | 'queue' | 'force' | undefined;

    if (request.isMultipart()) {
      // Parse multipart: text fields + image files
      const parsed = await parseMultipart(request, uploadDir);
      if ('error' in parsed) {
        reply.status(400);
        return { error: parsed.error };
      }
      ({ content, userId: legacyUserId, threadId, contentBlocks } = parsed);
      if ('idempotencyKey' in parsed && parsed.idempotencyKey) {
        idempotencyKey = parsed.idempotencyKey;
      }
      // F35: Extract whisper fields from multipart
      if (parsed.visibility === 'whisper' && parsed.whisperTo) {
        whisperVisibility = 'whisper';
        whisperRecipients = parsed.whisperTo as CatId[];
      }
      // F39: Extract deliveryMode from multipart
      if (parsed.deliveryMode) {
        deliveryMode = parsed.deliveryMode;
      }
    } else {
      // JSON mode (backwards compatible)
      const parseResult = sendMessageSchema.safeParse(request.body);
      if (!parseResult.success) {
        reply.status(400);
        return { error: 'Invalid request body', details: parseResult.error.issues };
      }
      ({ content, userId: legacyUserId, threadId, idempotencyKey } = parseResult.data);
      deliveryMode = parseResult.data.deliveryMode;
      // F35: Extract whisper fields from parsed body
      if (parseResult.data.visibility === 'whisper') {
        whisperVisibility = 'whisper';
        whisperRecipients = parseResult.data.whisperTo as CatId[] | undefined;
      }
    }

    const userId = resolveUserId(request, {
      fallbackUserId: legacyUserId,
      defaultUserId: 'default-user',
    });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    // Default to 'default' thread for lobby (prevents global broadcast)
    const resolvedThreadId = threadId ?? 'default';

    // Ensure thread exists and auto-title on first message
    if (resolvedThreadId !== 'default' && opts.threadStore) {
      const thread = await opts.threadStore.get(resolvedThreadId);

      if (!thread || thread.deletedAt) {
        // Thread doesn't exist or soft-deleted — reject to prevent orphaned messages (#21 + Phase D)
        reply.status(400);
        return {
          error: '对话不存在',
          detail: '请先创建对话后再发送消息。如果对话已被删除，请新建一个。',
          code: 'THREAD_NOT_FOUND',
        };
      } else if (thread.title === null) {
        // Auto-title existing untitled thread
        const autoTitle = content.length > 30 ? `${content.slice(0, 30)}...` : content;
        await opts.threadStore.updateTitle(resolvedThreadId, autoTitle);
        opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'thread_updated', {
          threadId: resolvedThreadId,
          title: autoTitle,
        });
      }
    }

    // Delete guard check (read-only, no side effects — safe before idempotency check)
    if (opts.invocationTracker?.isDeleting(resolvedThreadId)) {
      reply.status(409);
      return {
        error: '对话正在删除中',
        detail: '请稍后重试，或新建一个对话继续',
        code: 'THREAD_DELETING',
      };
    }

    // F101: /game command interception — start game directly, skip AI routing
    const parsedGame = parseGameCommand(content);
    if (parsedGame && opts.gameStore && opts.threadStore) {
      if (!gameOrchestrator || !gameAutoPlayer) {
        throw new Error('game auto-player is unavailable');
      }

      const DEFAULT_PLAYER_COUNT = 7;
      const allCatIds = getAllCatIdsFromConfig();
      const sanitized = parsedGame.catIds ? sanitizeCatIds(parsedGame.catIds, allCatIds) : [];
      // Fallback to all cats if sanitize filtered everything out (or no catIds provided)
      const catIds = sanitized.length > 0 ? sanitized : [...allCatIds];
      const playerCount = parsedGame.playerCount ?? DEFAULT_PLAYER_COUNT;
      const seats = buildGameSeats({
        humanRole: parsedGame.humanRole,
        userId,
        catIds,
        playerCount,
      });

      // Phase D: Create independent game thread with project categorization
      const gameTitle = `狼人杀 — ${playerCount}人局`;
      const gameThread = await opts.threadStore.create(userId, gameTitle, `games/${parsedGame.gameType}`);
      const gameThreadId = gameThread.id;

      // Notify source thread about the new game thread (include initiator for frontend guard)
      opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'game:thread_created', {
        gameThreadId,
        gameTitle,
        initiatorUserId: userId,
        timestamp: Date.now(),
      });

      // Store user message in the game thread
      const userMessage = await opts.messageStore.append({
        userId,
        catId: null,
        content,
        mentions: [],
        timestamp: Date.now(),
        threadId: gameThreadId,
      });

      // Use WerewolfLobby for role assignment, then orchestrator for persistence + broadcast
      const lobby = new WerewolfLobby();
      const lobbyRuntime = lobby.createLobby({
        threadId: gameThreadId,
        playerCount,
        players: seats.map((s) => ({ actorType: s.actorType, actorId: s.actorId })),
      });
      lobby.startGame(lobbyRuntime);

      let gameRuntime;
      try {
        gameRuntime = await gameOrchestrator.startGame({
          threadId: gameThreadId,
          definition: lobbyRuntime.definition,
          seats: lobbyRuntime.seats,
          config: {
            timeoutMs: 30000,
            voiceMode: parsedGame.voiceMode,
            humanRole: parsedGame.humanRole,
            ...(parsedGame.humanRole === 'player' ? { humanSeat: 'P1' } : {}),
            observerUserId: userId, // H2 fix: messageStore dual-write needs userId for thread visibility
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('already has an active game')) {
          reply.status(409);
          return { error: message };
        }
        throw err;
      }

      // Broadcast scoped views so frontend receives game:state_update
      await gameOrchestrator.broadcastGameState(gameRuntime.gameId);

      // AC-C3: Start AI auto-play loop — cats submit actions asynchronously
      gameAutoPlayer.startLoop(gameRuntime.gameId);

      return {
        status: 'game_started',
        gameId: gameRuntime.gameId,
        gameThreadId,
        userMessageId: userMessage.id,
      };
    }

    // ADR-008 S1: Pre-resolve targets + intent, persisting @mentions as participants
    log.debug({ threadId: resolvedThreadId, contentLen: content.length }, 'Resolving targets and intent');
    const {
      targetCats: resolvedTargetCats,
      intent,
      hasMentions,
    } = await router.resolveTargetsAndIntent(content, resolvedThreadId, {
      persist: true,
    });
    // F35: When sending a whisper, override routing targets to only whisperTo recipients.
    // This prevents non-recipient cats from being invoked and seeing whisper content.
    const targetCats =
      whisperVisibility === 'whisper' && whisperRecipients?.length
        ? [...new Set(whisperRecipients)]
        : [...resolvedTargetCats];
    const primaryCat = targetCats[0] ?? 'unknown';

    // Server-generated idempotency key if client didn't provide one
    const resolvedIdempotencyKey = idempotencyKey ?? randomUUID();

    // F39+F108B: Slot-aware delivery mode routing
    // Whisper → check target cat's slot (side-dispatch to idle cat)
    // Broadcast with explicit @mention → any target busy = queue (P1 review fix)
    // Broadcast without @mention → thread-level check (any active → queue)
    const hasActive = (() => {
      if (!opts.invocationTracker) return false;
      if (whisperVisibility === 'whisper' && primaryCat !== 'unknown') {
        return opts.invocationTracker.has(resolvedThreadId, primaryCat);
      }
      if (hasMentions) {
        return targetCats.some((cat) => cat !== 'unknown' && opts.invocationTracker!.has(resolvedThreadId, cat));
      }
      return opts.invocationTracker.has(resolvedThreadId);
    })();
    const mode = deliveryMode ?? (hasActive ? 'queue' : 'immediate');
    log.debug({ threadId: resolvedThreadId, targetCats, intent: intent.intent, mode, hasActive }, 'Dispatch decision');

    if (mode === 'queue' && hasActive && opts.invocationQueue) {
      // ① Enqueue first (sync, capacity gatekeeper) — messageId is null at this point
      const enqueueResult = opts.invocationQueue.enqueue({
        threadId: resolvedThreadId,
        userId,
        content,
        source: 'user',
        targetCats,
        intent: intent.intent,
      });

      // Queue full → 429, no message written (no ghost message)
      if (enqueueResult.outcome === 'full') {
        opts.socketManager.emitToUser(userId, 'queue_full_warning', {
          threadId: resolvedThreadId,
          source: 'user',
          queueSize: opts.invocationQueue.size(resolvedThreadId, userId),
          queue: opts.invocationQueue.list(resolvedThreadId, userId),
        });
        reply.status(429);
        return {
          error: '消息队列已满',
          code: 'QUEUE_FULL',
          queueSize: opts.invocationQueue.size(resolvedThreadId, userId),
        };
      }

      let storedUserMessageId: string | null = null;

      // ② Write user message (F117: mark as queued — invisible until dequeue)
      try {
        const userMessage = await opts.messageStore.append({
          userId,
          catId: null,
          content,
          mentions: targetCats,
          timestamp: Date.now(),
          threadId: resolvedThreadId,
          deliveryStatus: 'queued', // F117: not visible in history/context/mentions until delivered
          ...(contentBlocks ? { contentBlocks } : {}),
          ...(whisperVisibility && whisperRecipients
            ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
            : {}),
        });
        storedUserMessageId = userMessage.id;

        // ③ Backfill / append messageId — distinguish enqueued vs merged
        const queueEntryId = enqueueResult.entry?.id;
        if (queueEntryId) {
          if (enqueueResult.outcome === 'enqueued') {
            opts.invocationQueue.backfillMessageId(resolvedThreadId, userId, queueEntryId, userMessage.id);
          } else {
            opts.invocationQueue.appendMergedMessageId(resolvedThreadId, userId, queueEntryId, userMessage.id);
          }
        }
      } catch (err) {
        // Write failed → rollback queue entry (no ghost data)
        const queueEntryId = enqueueResult.entry?.id;
        if (queueEntryId && enqueueResult.outcome === 'enqueued') {
          // rollbackEnqueue: preserves merged content from concurrent requests
          opts.invocationQueue.rollbackEnqueue(resolvedThreadId, userId, queueEntryId);
        } else if (queueEntryId) {
          opts.invocationQueue.rollbackMerge(resolvedThreadId, userId, queueEntryId);
        }
        throw err;
      }

      // Emit queue update to this user only (privacy: scopeKey isolation)
      opts.socketManager.emitToUser(userId, 'queue_updated', {
        threadId: resolvedThreadId,
        queue: opts.invocationQueue.list(resolvedThreadId, userId),
        action: enqueueResult.outcome,
      });

      reply.status(202);
      return {
        status: 'queued',
        queuePosition: enqueueResult.queuePosition,
        entryId: enqueueResult.entry?.id,
        merged: enqueueResult.outcome === 'merged',
        ...(storedUserMessageId ? { userMessageId: storedUserMessageId } : {}),
      };
    }

    if (mode === 'force' && hasActive) {
      // Cancel current invocation (same logic as WS cancel)
      const cancelResult = opts.invocationTracker?.cancel(resolvedThreadId, primaryCat, userId);
      if (cancelResult?.cancelled) {
        for (const m of buildCancelMessages(cancelResult)) {
          opts.socketManager.broadcastAgentMessage(m, resolvedThreadId);
        }
      }
      // F39 bugfix: Prevent QueueProcessor state poisoning — the old invocation's
      // async cleanup will call onInvocationComplete('failed'/'canceled') which pauses
      // the thread. Clear that preemptively since we're about to start a new invocation.
      opts.queueProcessor?.clearPause(resolvedThreadId, primaryCat);

      // F39 bugfix: Notify frontend that force-cancel happened (clear stale queue UI)
      if (opts.invocationQueue) {
        opts.socketManager.emitToUser(userId, 'queue_updated', {
          threadId: resolvedThreadId,
          queue: opts.invocationQueue.list(resolvedThreadId, userId),
          action: 'force_cleared',
        });
      }
      // Fall through to immediate execution below
    }

    // ① F122 A.1: Occupy tracker slot BEFORE creating InvocationRecord to close TOCTOU window.
    // Non-force paths use tryStartThread (non-preemptive); force uses start() (preemptive, already cancelled above).
    if (opts.invocationRecordStore) {
      let controller: AbortController | undefined;

      if (mode !== 'force' && opts.invocationTracker) {
        // F122 AC-A8: Atomic thread-level busy gate + slot registration.
        // If thread became busy since initial has() check at line 306, degrade to queue.
        const tryResult = opts.invocationTracker.tryStartThread(resolvedThreadId, primaryCat, userId, targetCats);
        if (tryResult === null) {
          // TOCTOU: thread became busy between has() and here — degrade to queue
          if (opts.invocationQueue) {
            const enqueueResult = opts.invocationQueue.enqueue({
              threadId: resolvedThreadId,
              userId,
              content,
              source: 'user',
              targetCats,
              intent: intent.intent,
            });
            if (enqueueResult.outcome === 'full') {
              opts.socketManager.emitToUser(userId, 'queue_full_warning', {
                threadId: resolvedThreadId,
                source: 'user',
                queueSize: opts.invocationQueue.size(resolvedThreadId, userId),
                queue: opts.invocationQueue.list(resolvedThreadId, userId),
              });
              reply.status(429);
              return { error: '消息队列已满', code: 'QUEUE_FULL' };
            }
            // F122 R1-gpt52 P1-1: Wrap append+backfill in try/catch with rollback,
            // matching original queue path (lines 340-374) to prevent ghost queue entries.
            let toctouUserMessage: { id: string };
            try {
              toctouUserMessage = await opts.messageStore.append({
                userId,
                catId: null,
                content,
                mentions: targetCats,
                timestamp: Date.now(),
                threadId: resolvedThreadId,
                deliveryStatus: 'queued',
                ...(contentBlocks ? { contentBlocks } : {}),
                ...(whisperVisibility && whisperRecipients
                  ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
                  : {}),
              });
              const queueEntryId = enqueueResult.entry?.id;
              if (queueEntryId) {
                if (enqueueResult.outcome === 'enqueued') {
                  opts.invocationQueue.backfillMessageId(resolvedThreadId, userId, queueEntryId, toctouUserMessage.id);
                } else {
                  opts.invocationQueue.appendMergedMessageId(
                    resolvedThreadId,
                    userId,
                    queueEntryId,
                    toctouUserMessage.id,
                  );
                }
              }
            } catch (err) {
              // Write failed → rollback queue entry (no ghost data)
              const queueEntryId = enqueueResult.entry?.id;
              if (queueEntryId && enqueueResult.outcome === 'enqueued') {
                opts.invocationQueue.rollbackEnqueue(resolvedThreadId, userId, queueEntryId);
              } else if (queueEntryId) {
                opts.invocationQueue.rollbackMerge(resolvedThreadId, userId, queueEntryId);
              }
              throw err;
            }
            opts.socketManager.emitToUser(userId, 'queue_updated', {
              threadId: resolvedThreadId,
              queue: opts.invocationQueue.list(resolvedThreadId, userId),
              action: enqueueResult.outcome,
            });
            reply.status(202);
            return {
              status: 'queued',
              queuePosition: enqueueResult.queuePosition,
              entryId: enqueueResult.entry?.id,
              merged: enqueueResult.outcome === 'merged',
              userMessageId: toctouUserMessage.id,
            };
          }
          // No queue available — thread is busy but we can't queue. Reject.
          reply.status(409);
          return { error: '猫猫正在忙', code: 'THREAD_BUSY' };
        }
        controller = tryResult;
      }

      // F122 R1 P1: Wrap create/update/append in try/catch to release slot on error.
      // The background coroutine has its own finally for normal completion, but if we
      // throw before entering it, the slot would leak (thread stuck as "busy").
      let createResult: { outcome: string; invocationId: string };
      try {
        createResult = await opts.invocationRecordStore.create({
          threadId: resolvedThreadId,
          userId,
          targetCats,
          intent: intent.intent,
          idempotencyKey: resolvedIdempotencyKey,
        });
      } catch (createErr) {
        // Release slot occupied by tryStartThread — prevent "假忙" leak
        if (controller) {
          opts.invocationTracker?.complete(resolvedThreadId, primaryCat, controller);
        }
        throw createErr;
      }

      if (createResult.outcome === 'duplicate') {
        // AC-A11: tryStartThread succeeded but create returned duplicate — release slot
        if (controller) {
          opts.invocationTracker?.complete(resolvedThreadId, primaryCat, controller);
        }
        reply.status(200);
        return { status: 'duplicate', invocationId: createResult.invocationId };
      }

      // Force path: still uses start() (preemptive — cancel already happened above)
      if (!controller) {
        controller = opts.invocationTracker?.start(resolvedThreadId, primaryCat, userId, targetCats);
      }

      // Race: thread entered deleting between isDeleting() and start()
      if (controller?.signal.aborted) {
        await opts.invocationRecordStore.update(createResult.invocationId, {
          status: 'canceled',
        });
        reply.status(409);
        return {
          error: '对话正在删除中',
          detail: '请稍后重试，或新建一个对话继续',
          code: 'THREAD_DELETING',
        };
      }

      // F122 R1 P1 cont: wrap message write + update before background coroutine.
      // If any of these throw, release the slot to prevent "假忙" leak.
      let storedUserMessage: { id: string };
      try {
        // ② Write user message (decoupled from cat execution)
        storedUserMessage = await opts.messageStore.append({
          userId,
          catId: null,
          content,
          mentions: targetCats,
          timestamp: Date.now(),
          threadId: resolvedThreadId,
          ...(contentBlocks ? { contentBlocks } : {}),
          ...(whisperVisibility && whisperRecipients
            ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
            : {}),
        });

        // ③ Backfill InvocationRecord.userMessageId
        await opts.invocationRecordStore.update(createResult.invocationId, {
          userMessageId: storedUserMessage.id,
        });
      } catch (preExecErr) {
        // Release slot — we haven't entered background coroutine yet
        opts.invocationTracker?.complete(resolvedThreadId, primaryCat, controller);
        // Mark record as failed if it was created
        try {
          await opts.invocationRecordStore?.update(createResult.invocationId, { status: 'failed' });
        } catch {
          /* best-effort cleanup */
        }
        throw preExecErr;
      }

      // ④ Reply with invocationId
      reply.send({
        status: 'processing',
        invocationId: createResult.invocationId,
        userMessageId: storedUserMessage.id,
        timestamp: Date.now(),
      });

      // ⑤ Background: execute cat invocation via routeExecution
      void (async () => {
        const HEARTBEAT_INTERVAL_MS = 30_000;
        const heartbeatInterval = setInterval(() => {
          opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'heartbeat', {
            threadId: resolvedThreadId,
            timestamp: Date.now(),
          });
        }, HEARTBEAT_INTERVAL_MS);

        // F39: Track final status for queue auto-dequeue
        let finalStatus: 'succeeded' | 'failed' | 'canceled' = 'failed';

        // F088 ISSUE-15: Hoisted so catch/abort branches can clean up streaming sessions
        let streamStartPromise: Promise<void> | undefined;

        try {
          await opts.invocationRecordStore?.update(createResult.invocationId, {
            status: 'running',
          });

          // #768: intent_mode deferred to first CLI event (avoid "replying" when CLI never starts)
          let intentModeBroadcast = false;

          // ADR-008 S3: collect cursor boundaries; ack only after succeeded
          const cursorBoundaries = new Map<string, string>();
          // P1-2: track persistence failures across generator boundary
          const persistenceContext: PersistenceContext = { failed: false, errors: [] };
          // F8: collect per-cat token usage from done events
          const collectedUsage = new Map<string, TokenUsage>();
          // F070: track governance block errorCode for recoverable failure marking
          let governanceErrorCode: string | undefined;
          // Aggregate streamed assistant text for push summary/decision classification.
          let assistantReplyContent = '';

          // F088 ISSUE-15: Collect per-turn content for outbound delivery to connector platforms
          const outboundTurns: Array<{
            catId: string;
            textParts: string[];
            richBlocks?: unknown[];
          }> = [];
          let currentTurnCatId: string | undefined;
          const collectedTextParts: string[] = [];

          // F088 ISSUE-15: Start streaming placeholder on external platforms
          if (opts.streamingHook) {
            streamStartPromise = opts.streamingHook
              .onStreamStart(resolvedThreadId, primaryCat, createResult.invocationId)
              .catch((err) => {
                log.warn({ err, threadId: resolvedThreadId }, '[messages] StreamingHook.onStreamStart failed');
              });
          }

          for await (const msg of router.routeExecution(
            userId,
            content,
            resolvedThreadId,
            storedUserMessage.id,
            targetCats,
            intent,
            {
              ...(contentBlocks ? { contentBlocks } : {}),
              uploadDir,
              ...(controller?.signal ? { signal: controller.signal } : {}),
              ...(opts.invocationQueue
                ? {
                    queueHasQueuedMessages: (tid: string) =>
                      opts.invocationQueue?.hasQueuedUserMessagesForThread(tid) ?? false,
                    hasQueuedOrActiveAgentForCat: (tid: string, catId: string) =>
                      opts.invocationQueue?.hasActiveOrQueuedAgentForCat(tid, catId) ?? false,
                  }
                : {}),
              cursorBoundaries,
              persistenceContext,
              parentInvocationId: createResult.invocationId,
            },
          )) {
            // #768: Broadcast intent_mode on first CLI event — proves CLI is alive.
            if (!intentModeBroadcast) {
              opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'intent_mode', {
                threadId: resolvedThreadId,
                mode: intent.intent,
                targetCats,
                invocationId: createResult.invocationId,
              });
              intentModeBroadcast = true;
              // Push participants to sidebar. resolveTargets only calls addParticipants
              // for @mention flows; non-mention routing (preferredCats/default) skips it.
              // Merge stored participants with targetCats so sidebar always gets the
              // responding cats, regardless of how they were resolved.
              const existingParticipants = (await opts.threadStore?.get(resolvedThreadId))?.participants ?? [];
              const mergedParticipants = [...new Set([...existingParticipants, ...targetCats])];
              opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'thread_updated', {
                threadId: resolvedThreadId,
                participants: mergedParticipants,
              });
            }
            // F39 bugfix: stop broadcasting after cancel (drain pipe buffer silently)
            if (controller?.signal.aborted) break;
            if (msg.type === 'text' && msg.content) {
              assistantReplyContent += msg.content;
            }
            if (msg.type === 'done' && msg.catId && msg.metadata?.usage) {
              collectedUsage.set(msg.catId, mergeTokenUsage(collectedUsage.get(msg.catId), msg.metadata.usage));
            }
            if (msg.type === 'done' && msg.errorCode) {
              governanceErrorCode = msg.errorCode;
            }

            // F088 ISSUE-15: Collect outbound turns (same pattern as QueueProcessor)
            if (msg.type === 'done' && msg.catId) {
              if (persistenceContext.richBlocks) {
                const turn = outboundTurns[outboundTurns.length - 1];
                if (turn && turn.catId === msg.catId && currentTurnCatId === msg.catId) {
                  turn.richBlocks = [...persistenceContext.richBlocks];
                } else {
                  outboundTurns.push({
                    catId: msg.catId,
                    textParts: [],
                    richBlocks: [...persistenceContext.richBlocks],
                  });
                }
                persistenceContext.richBlocks = undefined;
              }
              currentTurnCatId = undefined;
            }
            if (msg.type === 'text' && typeof (msg as unknown as Record<string, unknown>).content === 'string') {
              const textContent = (msg as unknown as Record<string, unknown>).content as string;
              collectedTextParts.push(textContent);
              if (msg.catId) {
                if (msg.catId !== currentTurnCatId) {
                  outboundTurns.push({ catId: msg.catId, textParts: [] });
                  currentTurnCatId = msg.catId;
                }
                outboundTurns[outboundTurns.length - 1].textParts.push(textContent);
              }
              // F088 ISSUE-15: Forward streaming chunks to external platforms
              if (opts.streamingHook) {
                const accumulated = collectedTextParts.join('');
                opts.streamingHook
                  .onStreamChunk(resolvedThreadId, accumulated, createResult.invocationId)
                  .catch((streamErr) => {
                    log.warn(
                      { err: streamErr, threadId: resolvedThreadId },
                      '[messages] StreamingHook.onStreamChunk failed',
                    );
                  });
              }
            }

            opts.socketManager.broadcastAgentMessage(
              { ...msg, invocationId: createResult.invocationId },
              resolvedThreadId,
            );
          }

          // F39 P1 fix (砚砚 R1): abort guard after loop — when signal is aborted
          // and the generator ends normally (no throw), the break exits the loop but
          // post-loop code would still run ack+succeeded. Guard explicitly.
          if (controller?.signal.aborted) {
            finalStatus = 'canceled';
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'canceled',
            });
            // Bugfix: silent-exit P2 — only broadcast diagnostic when preempted by
            // a newer invocation (reason='preempted'). User-initiated cancel already
            // broadcasts its own messages via buildCancelMessages; adding another here
            // would cause a duplicate with misleading text.
            if (controller.signal.reason === 'preempted') {
              opts.socketManager.broadcastAgentMessage(
                {
                  type: 'system_info',
                  catId: targetCats[0] ?? getDefaultCatId(),
                  content: JSON.stringify({
                    type: 'invocation_preempted',
                    detail: 'This response was superseded by a newer request.',
                    invocationId: createResult.invocationId,
                  }),
                  timestamp: Date.now(),
                },
                resolvedThreadId,
              );
            }
            // P1 fix: finalize streaming session on abort so external placeholders are cleaned up
            await cleanupStreamingOnFailure(resolvedThreadId, createResult.invocationId, streamStartPromise, opts, log);
            // Skip ack/succeeded/push-notify — let finally handle cleanup
          } else if (persistenceContext.failed) {
            const errorDetail = persistenceContext.errors.map((e) => `${e.catId}: ${e.error}`).join('; ');
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'failed',
              error: `Message delivered but persistence failed: ${errorDetail}`,
            });
            opts.socketManager.broadcastAgentMessage(
              {
                type: 'error',
                catId: getDefaultCatId(),
                error: '消息已发送但未能保存，刷新后可能丢失。可点击重试。',
                timestamp: Date.now(),
              },
              resolvedThreadId,
            );

            const pushSvcErr = getPushNotificationService();
            if (pushSvcErr) {
              pushSvcErr
                .notifyUser(userId, {
                  title: '猫猫消息保存失败',
                  body: '消息已发送但未能保存，请检查',
                  tag: `cat-error-${resolvedThreadId}`,
                  data: { threadId: resolvedThreadId, url: `/?thread=${resolvedThreadId}` },
                })
                .catch(() => {});
            }
            await cleanupStreamingOnFailure(resolvedThreadId, createResult.invocationId, streamStartPromise, opts, log);
          } else if (governanceErrorCode) {
            // F070: Governance gate blocked — mark as failed with errorCode for retry
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'failed',
              error: governanceErrorCode,
            });
            await cleanupStreamingOnFailure(resolvedThreadId, createResult.invocationId, streamStartPromise, opts, log);
          } else {
            // ADR-008 S3: ack cursors before marking succeeded so that if ack
            // throws, the catch block sees running→failed (valid transition).
            await router.ackCollectedCursors(userId, resolvedThreadId, cursorBoundaries);

            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'succeeded',
              ...(collectedUsage.size > 0
                ? {
                    usageByCat: Object.fromEntries(collectedUsage),
                  }
                : {}),
            });
            finalStatus = 'succeeded';

            // Push notification: cat(s) finished responding
            const pushSvc = getPushNotificationService();
            if (pushSvc) {
              const catNames = targetCats.join(', ');
              const assistantText = assistantReplyContent.trim();
              const needsDecision = assistantText.length > 0 ? shouldMarkDecisionNotification(assistantText) : false;
              const pushBodySource = assistantText || '猫猫已处理，请打开会话查看详情';
              pushSvc
                .notifyUser(userId, {
                  title: needsDecision ? `${catNames} 需要你决策` : `${catNames} 回复了`,
                  body: pushBodySource.slice(0, 80),
                  icon: targetCats.length === 1 ? `/avatars/${targetCats[0]}.png` : '/icons/icon-192x192.png',
                  tag: `${needsDecision ? 'cat-decision' : 'cat-reply'}-${resolvedThreadId}`,
                  data: {
                    threadId: resolvedThreadId,
                    url: `/?thread=${resolvedThreadId}`,
                    ...(needsDecision ? { requiresDecision: true } : {}),
                  },
                })
                .catch(() => {
                  /* best-effort */
                });
            }

            // Fire-and-forget: auto-summarize if threshold met (only on success)
            if (opts.autoSummarizer) {
              opts.autoSummarizer
                .maybeSummarize(resolvedThreadId)
                .then((summary) => {
                  if (summary) {
                    opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'thread_summary', summary);
                  }
                })
                .catch(() => {
                  /* ignore */
                });
            }

            // F088 ISSUE-15: Outbound delivery to connector platforms (Feishu/Telegram)
            // P2 fix: fire-and-forget so delivery latency doesn't block invocationTracker.complete()
            deliverOutboundFromWeb(
              resolvedThreadId,
              primaryCat,
              createResult.invocationId,
              collectedTextParts,
              outboundTurns,
              persistenceContext,
              streamStartPromise,
              opts,
              log,
            ).catch((deliverErr) => {
              log.error({ err: deliverErr, threadId: resolvedThreadId }, '[messages] deliverOutboundFromWeb failed');
            });
          }
        } catch (err) {
          // F39 bugfix: detect abort (cancel/force) vs real failure
          if (controller?.signal.aborted) {
            finalStatus = 'canceled';
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'canceled',
            });
            // Don't broadcast error for intentional cancel
            // P1-A fix: clean up streaming placeholder even on abort/cancel
            await cleanupStreamingOnFailure(resolvedThreadId, createResult.invocationId, streamStartPromise, opts, log);
          } else {
            log.error({ err, invocationId: createResult.invocationId }, 'Background processing error');
            const errorMsg = normalizeErrorMessage(err);
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'failed',
              error: errorMsg,
            });
            opts.socketManager.broadcastAgentMessage(
              {
                type: 'error',
                catId: getDefaultCatId(),
                error: errorMsg,
                isFinal: true,
                timestamp: Date.now(),
              },
              resolvedThreadId,
            );

            const pushSvcCatch = getPushNotificationService();
            if (pushSvcCatch) {
              pushSvcCatch
                .notifyUser(userId, {
                  title: '猫猫出错了',
                  body: errorMsg.slice(0, 100),
                  tag: `cat-error-${resolvedThreadId}`,
                  data: { threadId: resolvedThreadId, url: `/?thread=${resolvedThreadId}` },
                })
                .catch(() => {});
            }
            await cleanupStreamingOnFailure(resolvedThreadId, createResult.invocationId, streamStartPromise, opts, log);
          } // end else (non-abort error)
        } finally {
          clearInterval(heartbeatInterval);
          opts.invocationTracker?.complete(resolvedThreadId, primaryCat, controller);
          // F39: Notify queue processor for auto-dequeue chain
          opts.queueProcessor?.onInvocationComplete(resolvedThreadId, primaryCat, finalStatus).catch(() => {
            /* best-effort, don't crash background task */
          });
        }
      })();
    } else {
      // Fallback: no invocationRecordStore (legacy path, uses route())
      // F122 A.1: Try non-preemptive first. Legacy path has no InvocationQueue so it
      // cannot degrade to queue — fall back to preemptive start() as temporary compat.
      // TODO(F122 Phase B): Legacy path should be removed or given queue support.
      let controller: AbortController | undefined;
      if (mode !== 'force' && opts.invocationTracker) {
        controller =
          opts.invocationTracker.tryStartThread(resolvedThreadId, primaryCat, userId, targetCats) ??
          opts.invocationTracker.start(resolvedThreadId, primaryCat, userId, targetCats);
      } else {
        controller = opts.invocationTracker?.start(resolvedThreadId, primaryCat, userId, targetCats);
      }
      if (controller?.signal.aborted) {
        reply.status(409);
        return {
          error: '对话正在删除中',
          detail: '请稍后重试，或新建一个对话继续',
          code: 'THREAD_DELETING',
        };
      }

      reply.send({ status: 'processing', timestamp: Date.now() });

      void (async () => {
        const HEARTBEAT_INTERVAL_MS = 30_000;
        const heartbeatInterval = setInterval(() => {
          opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'heartbeat', {
            threadId: resolvedThreadId,
            timestamp: Date.now(),
          });
        }, HEARTBEAT_INTERVAL_MS);

        try {
          // #768: intent_mode deferred to first CLI event (legacy path)
          let intentModeBroadcast = false;

          for await (const msg of router.route(
            userId,
            content,
            resolvedThreadId,
            contentBlocks,
            uploadDir,
            controller?.signal,
          )) {
            // #768: Broadcast intent_mode on first CLI event (legacy path)
            if (!intentModeBroadcast) {
              opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'intent_mode', {
                threadId: resolvedThreadId,
                mode: intent.intent,
                targetCats,
                // Legacy path: no invocationId (no InvocationRecord). Frontend falls back gracefully.
              });
              intentModeBroadcast = true;
            }
            opts.socketManager.broadcastAgentMessage(msg, resolvedThreadId);
          }
        } catch (err) {
          log.error({ err }, 'Background processing error');
          opts.socketManager.broadcastAgentMessage(
            {
              type: 'error',
              catId: getDefaultCatId(),
              error: normalizeErrorMessage(err),
              isFinal: true,
              timestamp: Date.now(),
            },
            resolvedThreadId,
          );
        } finally {
          clearInterval(heartbeatInterval);
          opts.invocationTracker?.complete(resolvedThreadId, primaryCat, controller);
        }
      })();
    }
  });

  // GET /api/messages - 获取历史消息
  app.get('/api/messages', async (request) => {
    const parseResult = getMessagesSchema.safeParse(request.query);
    if (!parseResult.success) {
      return { messages: [], hasMore: false };
    }
    const { limit, before, threadId } = parseResult.data;
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      return { messages: [], hasMore: false };
    }

    // Parse composite cursor "timestamp:id" or legacy plain timestamp
    let beforeTs: number | undefined;
    let beforeId: string | undefined;
    if (before) {
      const colonIdx = before.indexOf(':');
      if (colonIdx > 0) {
        beforeTs = parseInt(before.slice(0, colonIdx), 10);
        beforeId = before.slice(colonIdx + 1);
      } else {
        beforeTs = parseInt(before, 10);
      }
      if (!Number.isFinite(beforeTs!)) {
        return { messages: [], hasMore: false };
      }
    }

    // Always thread-scoped — default to 'default' thread for lobby
    const resolvedThreadId = threadId ?? 'default';
    const messages =
      beforeTs != null
        ? await opts.messageStore.getByThreadBefore(resolvedThreadId, beforeTs, limit + 1, beforeId, userId)
        : await opts.messageStore.getByThread(resolvedThreadId, limit + 1, userId);

    // Fetch limit+1 to determine hasMore; drop oldest (first) probe item
    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(1) : messages;

    // Map chat messages (union type allows summary items to be pushed later)
    type TimelineItem = {
      id: string;
      type: 'user' | 'assistant' | 'connector' | 'summary' | 'system';
      catId: string | null;
      content: string;
      timestamp: number;
      summary?: { id: string; topic: string; conclusions: string[]; openQuestions: string[]; createdBy: string };
      [key: string]: unknown;
    };
    const chatItems: TimelineItem[] = page.map((m) => ({
      id: m.id,
      type: (m.catId
        ? 'assistant'
        : m.source
          ? 'connector'
          : m.userId === 'system'
            ? 'system'
            : 'user') as TimelineItem['type'],
      catId: m.catId,
      content: m.content,
      ...(m.contentBlocks ? { contentBlocks: m.contentBlocks } : {}),
      ...(m.toolEvents ? { toolEvents: m.toolEvents } : {}),
      ...(m.metadata ? { metadata: m.metadata } : {}),
      ...(m.origin ? { origin: m.origin } : {}),
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.extra?.rich || m.extra?.crossPost || m.extra?.stream || m.extra?.targetCats
        ? {
            extra: {
              ...(m.extra.rich ? { rich: m.extra.rich } : {}),
              ...(m.extra.crossPost ? { crossPost: m.extra.crossPost } : {}),
              ...(m.extra.stream ? { stream: m.extra.stream } : {}),
              ...(m.extra.targetCats ? { targetCats: m.extra.targetCats } : {}),
            },
          }
        : {}),
      ...(m.visibility ? { visibility: m.visibility } : {}),
      ...(m.whisperTo ? { whisperTo: m.whisperTo } : {}),
      ...(m.revealedAt ? { revealedAt: m.revealedAt } : {}),
      ...(m.deliveredAt ? { deliveredAt: m.deliveredAt } : {}),
      ...(m.source
        ? {
            source: {
              connector: m.source.connector,
              label: m.source.label,
              icon: m.source.icon,
              ...(m.source.url ? { url: m.source.url } : {}),
              ...(m.source.meta ? { meta: m.source.meta } : {}),
            },
          }
        : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      timestamp: m.timestamp,
    }));

    // F121: Hydrate reply previews for messages with replyTo
    const replyItems = chatItems.filter((item) => item.replyTo);
    if (replyItems.length > 0) {
      const { hydrateReplyPreview } = await import('../domains/cats/services/stores/ports/MessageStore.js');
      await Promise.all(
        replyItems.map(async (item) => {
          const preview = await hydrateReplyPreview(opts.messageStore, item.replyTo as string);
          if (preview) {
            item.replyPreview = preview;
          }
        }),
      );
    }

    // #80: Merge active streaming drafts (first page only — no before cursor)
    if (!before && opts.draftStore) {
      const drafts = await opts.draftStore.getByThread(userId, resolvedThreadId);
      // #80 fix-B diagnostic: trace draft merge for F5 recovery verification
      if (drafts.length > 0) {
        request.log.info(
          { threadId: resolvedThreadId, draftCount: drafts.length, draftIds: drafts.map((d) => d.invocationId) },
          '#80 draft merge: found active drafts',
        );
        // P1-2 dedup: filter out drafts whose invocationId matches a formal message.
        // Build invocationId set from current page first (fast path).
        const formalInvocationIds = new Set(
          page.map((m) => m.extra?.stream?.invocationId).filter((id): id is string => !!id),
        );
        let activeDrafts = drafts.filter((d) => !formalInvocationIds.has(d.invocationId));
        // Cloud R4 P2: if drafts survive page-level dedup, widen the check to cover
        // formal messages pushed off the first page (race window: TTL > page depth).
        // Cloud R5 P2: wider window must always exceed page limit (limit max=200 → worst case 800).
        if (activeDrafts.length > 0 && page.length >= limit) {
          const widerLimit = Math.max(200, limit * 4);
          const wider = await opts.messageStore.getByThread(resolvedThreadId, widerLimit, userId);
          for (const m of wider) {
            const invId = m.extra?.stream?.invocationId;
            if (invId) formalInvocationIds.add(invId);
          }
          activeDrafts = activeDrafts.filter((d) => !formalInvocationIds.has(d.invocationId));
        }
        // P2: stable sort by updatedAt for parallel multi-cat drafts
        activeDrafts.sort((a, b) => a.updatedAt - b.updatedAt);
        if (activeDrafts.length > 0) {
          request.log.info(
            { threadId: resolvedThreadId, mergedCount: activeDrafts.length, cats: activeDrafts.map((d) => d.catId) },
            '#80 draft merge: merging drafts into response',
          );
        }
        for (const d of activeDrafts) {
          chatItems.push({
            id: `draft-${d.invocationId}`,
            type: 'assistant',
            catId: d.catId as string | null,
            content: d.content,
            timestamp: d.updatedAt,
            isDraft: true,
            origin: 'stream',
            extra: { stream: { invocationId: d.invocationId } },
            ...(d.toolEvents ? { toolEvents: d.toolEvents } : {}),
            ...(d.thinking ? { thinking: d.thinking } : {}),
          });
        }
      }
    }

    // P1-B fix: merge summaries into history timeline
    // First page (no cursor): include summaries >= oldest message (no max cap,
    //   so summaries created *after* the newest message are still included).
    // Pagination (before cursor): include summaries >= oldest message AND < beforeTs.
    if (opts.summaryStore) {
      const summaries = await opts.summaryStore.listByThread(resolvedThreadId);
      const minTs = page.length > 0 ? (page[0]?.timestamp ?? null) : null;
      for (const s of summaries) {
        if (minTs !== null && s.createdAt < minTs) continue;
        if (beforeTs != null && s.createdAt >= beforeTs) continue;
        chatItems.push({
          id: `summary-${s.id}`,
          type: 'summary',
          catId: null,
          content: s.topic,
          timestamp: s.createdAt,
          summary: {
            id: s.id,
            topic: s.topic,
            conclusions: [...s.conclusions],
            openQuestions: [...s.openQuestions],
            createdBy: s.createdBy,
          },
        });
      }
      chatItems.sort((a, b) => {
        const ta = typeof a.deliveredAt === 'number' ? a.deliveredAt : a.timestamp;
        const tb = typeof b.deliveredAt === 'number' ? b.deliveredAt : b.timestamp;
        return ta - tb;
      });
    }

    return {
      messages: chatItems,
      hasMore,
    };
  });
};

/** @internal exported for testing — do not use outside of test. */
export async function cleanupStreamingOnFailure(
  threadId: string,
  invocationId: string,
  streamStartPromise: Promise<void> | undefined,
  opts: MessagesRoutesOptions,
  logger: typeof log,
): Promise<void> {
  if (!opts.streamingHook) return;
  try {
    if (streamStartPromise) {
      await Promise.race([streamStartPromise, new Promise<void>((r) => setTimeout(r, STREAM_START_TIMEOUT_MS))]);
    }
    await opts.streamingHook.onStreamEnd(threadId, '', invocationId);
    await opts.streamingHook.cleanupPlaceholders?.(threadId, invocationId);
  } catch (err) {
    logger.warn({ err, threadId }, '[messages] cleanupStreamingOnFailure failed');
  }
}

/** @internal exported for testing — do not use outside of test. */
export async function deliverOutboundFromWeb(
  threadId: string,
  primaryCat: string,
  invocationId: string,
  collectedTextParts: string[],
  outboundTurns: Array<{ catId: string; textParts: string[]; richBlocks?: unknown[] }>,
  persistenceContext: PersistenceContext,
  streamStartPromise: Promise<void> | undefined,
  opts: MessagesRoutesOptions,
  logger: typeof log,
): Promise<void> {
  const finalContent = collectedTextParts.join('');

  if (opts.streamingHook) {
    if (streamStartPromise) {
      await Promise.race([
        streamStartPromise,
        new Promise<void>((resolve) => setTimeout(resolve, STREAM_START_TIMEOUT_MS)),
      ]);
    }
    await opts.streamingHook.onStreamEnd(threadId, finalContent, invocationId).catch((err) => {
      logger.warn({ err, threadId }, '[messages] StreamingHook.onStreamEnd failed');
    });
  }

  const hasContent = collectedTextParts.length > 0 || outboundTurns.length > 0;
  if (!opts.outboundHook || !hasContent) {
    if (opts.streamingHook?.cleanupPlaceholders) {
      await opts.streamingHook.cleanupPlaceholders(threadId, invocationId).catch((err) => {
        logger.warn({ err, threadId }, '[messages] StreamingHook.cleanupPlaceholders failed (silent)');
      });
    }
    return;
  }

  let threadMeta: { threadShortId: string; threadTitle?: string; deepLinkUrl?: string } | undefined;
  try {
    const LOOKUP_TIMEOUT_MS = 2000;
    const thread = opts.threadStore?.get(threadId);
    if (thread) {
      const lookupPromise = Promise.resolve(thread).catch(() => undefined);
      const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS));
      const resolved = await Promise.race([lookupPromise, timeout]);
      if (resolved) {
        const frontendBase = resolveFrontendBaseUrl(process.env);
        threadMeta = {
          threadShortId: threadId.slice(0, 15),
          threadTitle: resolved.title ?? undefined,
          deepLinkUrl: `${frontendBase}/threads/${threadId}`,
        };
      }
    }
  } catch {
    logger.warn({ threadId }, '[messages] threadMeta lookup failed');
  }

  const DELIVER_TIMEOUT_MS = 10_000;
  const nonEmptyTurns = outboundTurns.filter(
    (t) => t.textParts.length > 0 || (t.richBlocks && t.richBlocks.length > 0),
  );

  let deliveryFailed = false;
  const inflightDeliverPromises: Promise<void>[] = [];

  if (nonEmptyTurns.length > 1) {
    for (const turn of nonEmptyTurns) {
      const turnContent = turn.textParts.join('');
      const deliverPromise = opts.outboundHook.deliver(threadId, turnContent, turn.catId, turn.richBlocks, threadMeta);
      inflightDeliverPromises.push(deliverPromise);
      try {
        await Promise.race([
          deliverPromise,
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS)),
        ]);
      } catch (err) {
        deliveryFailed = true;
        logger.error({ err, threadId, catId: turn.catId }, '[messages] Outbound delivery error');
      }
    }
  } else if (nonEmptyTurns.length === 1) {
    const turn = nonEmptyTurns[0];
    const richBlocks = persistenceContext.richBlocks ?? turn.richBlocks;
    const deliverPromise = opts.outboundHook.deliver(threadId, finalContent, turn.catId, richBlocks, threadMeta);
    inflightDeliverPromises.push(deliverPromise);
    try {
      await Promise.race([
        deliverPromise,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS)),
      ]);
    } catch (err) {
      deliveryFailed = true;
      logger.error({ err, threadId }, '[messages] Outbound delivery error');
    }
  } else {
    const richBlocks = persistenceContext.richBlocks;
    if (richBlocks) {
      const deliverPromise = opts.outboundHook.deliver(threadId, finalContent, primaryCat, richBlocks, threadMeta);
      inflightDeliverPromises.push(deliverPromise);
      try {
        await Promise.race([
          deliverPromise,
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS)),
        ]);
      } catch (err) {
        deliveryFailed = true;
        logger.error({ err, threadId }, '[messages] Outbound delivery error');
      }
    }
  }

  if (!deliveryFailed && opts.streamingHook?.cleanupPlaceholders) {
    await opts.streamingHook.cleanupPlaceholders(threadId, invocationId).catch((err) => {
      logger.warn({ err, threadId }, '[messages] StreamingHook.cleanupPlaceholders failed');
    });
  } else if (deliveryFailed && opts.streamingHook?.cleanupPlaceholders) {
    const cleanupFn = opts.streamingHook.cleanupPlaceholders.bind(opts.streamingHook);
    Promise.allSettled(inflightDeliverPromises).then((results) => {
      if (results.every((r) => r.status === 'fulfilled')) {
        cleanupFn(threadId, invocationId).catch((err) => {
          logger.warn({ err, threadId }, '[messages] Late-success placeholder cleanup failed');
        });
      }
    });
  }

  // F151: Signal adapters that this invocation's delivery batch is complete.
  // chainDone = no more active or queued invocations for this thread.
  if (opts.streamingHook?.notifyDeliveryBatchDone) {
    const threadStillBusy =
      (opts.invocationTracker?.has(threadId) ?? false) || (opts.queueProcessor?.isThreadBusy(threadId) ?? false);
    await opts.streamingHook.notifyDeliveryBatchDone(threadId, !threadStillBusy).catch((err) => {
      logger.warn({ err, threadId }, '[messages] notifyDeliveryBatchDone failed');
    });
  }
}
