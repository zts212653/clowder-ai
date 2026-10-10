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

import { createHash, randomUUID } from 'node:crypto';
import {
  type CatId,
  catRegistry,
  isCloudBridgeRecoveryV1,
  isCrossThreadProvenance,
  type MessageContent,
  type MessageWorkDisposition,
  timelineMessageKind,
} from '@cat-cafe/shared';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  type InvocationQueue,
  queueEntryTargetCats,
} from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { OwnerAuthProvenance } from '../domains/cats/services/agents/invocation/owner-auth-provenance.js';
import { resetStreak } from '../domains/cats/services/agents/routing/WorklistRegistry.js';
import { parseIntent } from '../domains/cats/services/context/IntentParser.js';
import {
  type MessageSelectionAdmissionResult,
  MessageSelectionResolver,
} from '../domains/cats/services/context/MessageSelectionResolver.js';
import { createGameDriver } from '../domains/cats/services/game/createGameDriver.js';
import type { GameDriver } from '../domains/cats/services/game/GameDriver.js';
import { GameOrchestrator } from '../domains/cats/services/game/GameOrchestrator.js';
import { WerewolfLobby } from '../domains/cats/services/game/werewolf/WerewolfLobby.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import { messageFrom } from '../domains/cats/services/stores/message-from.js';
import type { IDraftStore } from '../domains/cats/services/stores/ports/DraftStore.js';
import type { IGameStore } from '../domains/cats/services/stores/ports/GameStore.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { isTimelinePublished } from '../domains/cats/services/stores/ports/MessageStore.js';
import { deriveAutoThreadTitle, type IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  getTimelineOrderTime,
  isInternalNonQuotableParent,
  resolveVisibleReplyParent,
} from '../domains/cats/services/stores/visibility.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { normalizeJsonUnicode } from '../utils/json-unicode.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';
import { admitThreadParticipants } from './thread-participant-admission.js';
import { readUserMessageReceipt } from './user-message-receipt.js';

type StoredRecovery = NonNullable<StoredMessage['extra']>['recovery'];

/** Keep transcript paths and content hashes in the durable audit record, never in the browser DTO. */
function projectRecoveryForHistory(recovery: StoredRecovery) {
  if (!recovery) return undefined;
  return {
    kind: recovery.kind,
    cvoDecisionRef: recovery.cvoDecisionRef,
    recoveredAt: recovery.recoveredAt,
  };
}

import { emitQueueUpdated, enrichQueueEntries } from '../utils/queue-enrichment.js';
import { resolveStrictUserId, resolveUserId } from '../utils/request-identity.js';
import { buildGameSeats, parseGameCommand, sanitizeCatIds } from './game-command-interceptor.js';
import type { HoldBallCancelDeps } from './hold-ball-cancel.js';
import { cancelPendingHoldsForThread } from './hold-ball-cancel.js';
import { formatHoldOwnerName, persistHoldTerminalVisibility } from './hold-ball-terminal-visibility.js';
import { buildMessageContentBlocks, type SendMessageInput, sendMessageSchema } from './messages.schema.js';
import { parseMultipart } from './parse-multipart.js';

type ResolvedBundleAdmission = Extract<MessageSelectionAdmissionResult, { status: 'resolved' }>;

function buildMessageBundleSummary(admission: ResolvedBundleAdmission): string {
  const sourceTitle = admission.sourceThread.title?.trim() || admission.sourceThread.id;
  if (admission.items.length === 1 && admission.items[0]?.kind === 'quote') {
    return `转发了 1 段引用 · 来自「${sourceTitle}」`;
  }
  const unit = admission.items.length === 1 ? '条消息' : '条聊天记录';
  return `转发了 ${admission.items.length} ${unit} · 来自「${sourceTitle}」`;
}

type MessageBundleAdmissionFailureReason = Exclude<MessageSelectionAdmissionResult, { status: 'resolved' }>['reason'];

function bundleAdmissionErrorStatus(reason: MessageBundleAdmissionFailureReason): number {
  if (reason === 'not_authorized') return 403;
  if (reason === 'source_unavailable') return 409;
  return 400;
}

/**
 * A rejected forward must tell the human which of their own actions to redo. A single
 * generic string turns every distinct cause into "it just failed".
 */
function bundleAdmissionErrorMessage(reason: MessageBundleAdmissionFailureReason): string {
  switch (reason) {
    case 'quote_mismatch':
      return '选中的内容和原消息对不上，可能原消息已被编辑。请重新划选后再转发。';
    case 'ambiguous_quote':
      return '选中的文字在这条消息里出现了多次，无法确定是哪一处。请多选一些上下文再转发。';
    case 'source_unavailable':
      return '来源消息已不可用（被删除、撤回或权限变更）。请重新选择要转发的内容。';
    case 'not_authorized':
      return '无权读取来源对话的内容。';
    case 'unsupported_source':
      return '这条消息包含脚注或公式，划线引用暂不支持；可以改为转发整条消息。';
    case 'invalid_selection':
      return '这次选择无法解析，请取消选择后重新选一次。';
  }
}

/**
 * Dependencies injected via Fastify plugin options.
 * socketManager is injected to avoid circular import from index.ts.
 */
export interface MessagesRoutesOptions {
  registry: InvocationRegistry;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  router: AgentRouter;
  threadStore?: IThreadStore;
  uploadDir?: string;
  invocationTracker?: InvocationTracker;

  /** #80: Streaming draft store for F5 recovery */
  draftStore?: IDraftStore;
  /** Canonical durable ingress for every normal user message. */
  invocationQueue?: InvocationQueue;
  /** F101: Game store for /game command interception */
  gameStore?: IGameStore;
  /** F101: Injectable auto-player for lifecycle-safe teardown in tests/routes */
  autoPlayer?: Pick<GameDriver, 'startLoop' | 'stopLoop' | 'stopAllLoops'>;
  /** F167 Phase J: deps for auto-cancelling pending hold-ball tasks on user message */
  holdBallCancelDeps?: HoldBallCancelDeps & {
    messageStore?: IMessageStore;
    socketManager?: SocketManager;
  };
  /** F192 Phase G AC-G12 / F227 归一: callback when magic words detected in a user
   * message. messageId is the stored user-message id — the Event Memory teleport
   * coordinate. */
  onMagicWordDetected?: (
    hits: Array<{ word: string }>,
    threadId: string,
    catId: string | null,
    messageId: string,
    ownerUserId: string,
    messageExcerpt?: string,
  ) => void;
}

const log = createModuleLogger('routes/messages');

/**
 * F192 Phase G AC-G12: detect magic words in user message content.
 * Best-effort, fire-and-forget — failures are silently swallowed.
 * Called only after the durable Queue source record exists.
 */
async function tryDetectMagicWords(
  content: string | null | undefined,
  threadId: string,
  targetCats: string[],
  messageId: string | null | undefined,
  ownerUserId: string | null | undefined,
  onMagicWordDetected?: MessagesRoutesOptions['onMagicWordDetected'],
): Promise<void> {
  // F227 归一: messageId is the Event Memory teleport coordinate — never guess it
  // from thread/time. If it is unavailable, skip rather than store a
  // coordinate-less event.
  if (!onMagicWordDetected || !content || !messageId) return;
  // F227 (cloud-review P1 / 砚砚): the live write must carry the authenticated owner —
  // skip + report rather than store an unscoped event (no unknown/default fallback).
  if (!ownerUserId) {
    log.warn({ threadId, messageId }, 'magic-word event skipped: message has no owner userId');
    return;
  }
  try {
    const { detectMagicWords } = await import('../infrastructure/harness-eval/task-outcome/magic-word-detector.js');
    const hits = detectMagicWords(content);
    if (hits.length > 0) {
      // 砚砚 (non-blocking): pass a short excerpt of the triggering message so the
      // Event summary carries 原话 context, not just the magic word itself.
      const excerpt = content.length > 200 ? `${content.slice(0, 200)}…` : content;
      onMagicWordDetected(hits, threadId, targetCats[0] ?? null, messageId, ownerUserId, excerpt);
    }
  } catch {
    // Best-effort: the detection/dispatch wrapper must not fail message send. The
    // Event-write fail-loud policy lives inside onMagicWordDetected itself (it logs
    // + observes rather than throwing), so it is not swallowed here.
  }
}

export async function tryAutoCancelPendingHolds(
  threadId: string,
  deps:
    | (HoldBallCancelDeps & {
        messageStore?: IMessageStore;
        socketManager?: SocketManager;
      })
    | undefined,
): Promise<void> {
  if (!deps) return;
  try {
    const cancelled = cancelPendingHoldsForThread(threadId, deps);
    if (cancelled.length > 0 && deps.messageStore && deps.socketManager) {
      for (const task of cancelled) {
        const userId = typeof task.params.triggerUserId === 'string' ? task.params.triggerUserId : null;
        const catId = task.createdBy.startsWith('hold-ball:') ? task.createdBy.slice('hold-ball:'.length) : null;
        if (!userId || !catId) {
          log.error({ threadId, taskId: task.id }, 'auto-retired hold lacks canonical owner identity');
          continue;
        }
        await persistHoldTerminalVisibility(
          { messageStore: deps.messageStore, socketManager: deps.socketManager },
          {
            taskId: task.id,
            threadId,
            userId,
            catId,
            outcome: 'retired_by_user_message',
            content: `🏓 ${formatHoldOwnerName(catId)} 持球已因新的用户消息结束`,
          },
        );
      }
    }
    if (cancelled.length > 0) {
      log.info(
        { threadId, cancelledCount: cancelled.length, taskIds: cancelled.map((t) => t.id) },
        'F295: retired pending hold-ball wakes on user message without cancelling independent commands',
      );
    }
  } catch (err) {
    log.warn({ threadId, err }, 'F167 Phase J: failed to auto-cancel pending holds');
  }
}

const getMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(10000).default(50),
  /** Cursor: "timestamp:id" or legacy plain timestamp */
  before: z.string().optional(),
  threadId: z.string().min(1).max(100).optional(),
});

const cloudDeliveryRetrySchema = z.object({
  attemptId: z.string().min(1).max(512),
});

function cloudDeliveryRetryIdempotencyKey(sourceMessageId: string, targetCatId: string, attemptId: string): string {
  const digest = createHash('sha256').update(`${sourceMessageId}\0${targetCatId}\0${attemptId}`).digest('hex');
  return `cloud-delivery-retry:v1:${digest}`;
}

function hasExactCloudDeliveryRecoveryNotice(
  messages: readonly StoredMessage[],
  sourceMessageId: string,
  targetCatId: string,
  attemptId: string,
): boolean {
  return messages.some((message) => {
    if (message.replyTo !== sourceMessageId || message.source?.connector !== 'cloud-bridge-status') return false;
    const recovery = message.source.meta?.cloudBridgeRecovery;
    return (
      isCloudBridgeRecoveryV1(recovery) &&
      recovery.sourceMessageId === sourceMessageId &&
      recovery.targetCatId === targetCatId &&
      recovery.dispatchInvocationId === attemptId
    );
  });
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;

export const messagesRoutes: FastifyPluginAsync<MessagesRoutesOptions> = async (app, opts) => {
  const uploadDir = getDefaultUploadDir(opts.uploadDir ?? process.env.UPLOAD_DIR);

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

    let messageDisposition: MessageWorkDisposition | undefined;
    let explicitMentionTargetCats: readonly CatId[] | undefined;

    // #699: Reply-to (quote) reference
    let replyTo: string | undefined;
    let messageBundleRequest: SendMessageInput['messageBundle'];

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
      messageDisposition = parsed.messageDisposition;
      explicitMentionTargetCats = parsed.mentions?.length ? (parsed.mentions as CatId[]) : undefined;
      // #699: Extract replyTo from multipart
      if (parsed.replyTo) {
        replyTo = parsed.replyTo;
      }
    } else {
      // JSON mode (backwards compatible)
      const parseResult = sendMessageSchema.safeParse(request.body);
      if (!parseResult.success) {
        reply.status(400);
        return { error: 'Invalid request body', details: parseResult.error.issues };
      }
      ({ content, userId: legacyUserId, threadId, idempotencyKey } = parseResult.data);
      if (parseResult.data.contextAttachments?.length) {
        contentBlocks = buildMessageContentBlocks(content, parseResult.data.contextAttachments);
      }
      messageDisposition = parseResult.data.messageDisposition;
      explicitMentionTargetCats = parseResult.data.mentions?.length
        ? (parseResult.data.mentions as CatId[])
        : undefined;
      // F35: Extract whisper fields from parsed body
      if (parseResult.data.visibility === 'whisper') {
        whisperVisibility = 'whisper';
        whisperRecipients = parseResult.data.whisperTo as CatId[] | undefined;
      }
      // #699: Extract replyTo from JSON body
      replyTo = parseResult.data.replyTo;
      messageBundleRequest = parseResult.data.messageBundle;
    }

    const userId = resolveUserId(request, {
      fallbackUserId: legacyUserId,
      defaultUserId: 'default-user',
    });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const ownerAuthProvenance: OwnerAuthProvenance =
      resolveStrictUserId(request) === userId ? 'strict' : 'compatibility_fallback';
    const liveSessionHeader = request.headers['x-cat-cafe-live-session'];
    if (
      liveSessionHeader !== undefined &&
      (typeof liveSessionHeader !== 'string' ||
        !liveSessionHeader ||
        ownerAuthProvenance !== 'strict' ||
        messageBundleRequest ||
        whisperVisibility ||
        messageDisposition === 'continue_current')
    )
      return reply.code(400).send({ error: 'Invalid Live admission', code: 'INVALID_LIVE_ADMISSION' });
    const liveSessionId = typeof liveSessionHeader === 'string' ? liveSessionHeader : undefined;

    // Default to 'default' thread for lobby (prevents global broadcast)
    const resolvedThreadId = threadId ?? 'default';
    if (!opts.invocationQueue) {
      return reply.code(503).send({ error: 'Message delivery is unavailable', code: 'MESSAGE_DELIVERY_UNAVAILABLE' });
    }
    // Live owns an exact session receipt; ordinary retries are handled by shared send.
    const receiptOwner = { userId, threadId: resolvedThreadId };
    const replayedSource =
      idempotencyKey && opts.invocationQueue
        ? await opts.messageStore.getByIdempotencyKey(userId, resolvedThreadId, idempotencyKey)
        : null;

    let admittedMessageBundle: ResolvedBundleAdmission | undefined;
    let explicitBundleTargetCats: CatId[] | undefined;
    if (messageBundleRequest) {
      if (!opts.threadStore) {
        reply.status(503);
        return { error: 'Message Bundle routing is unavailable', code: 'MESSAGE_BUNDLE_UNAVAILABLE' };
      }

      const targetThread = await opts.threadStore.get(resolvedThreadId);
      if (!targetThread || targetThread.deletedAt) {
        reply.status(400);
        return { error: '目标对话不存在', code: 'MESSAGE_BUNDLE_TARGET_NOT_FOUND' };
      }
      if (targetThread.createdBy !== userId && targetThread.createdBy !== 'system') {
        reply.status(403);
        return { error: '无权向目标对话转发', code: 'MESSAGE_BUNDLE_TARGET_UNAUTHORIZED' };
      }

      const selectionResolver = new MessageSelectionResolver({
        messageStore: opts.messageStore,
        threadStore: opts.threadStore,
      });
      const admission = await selectionResolver.resolveForAdmission(
        {
          sourceThreadId: messageBundleRequest.sourceThreadId,
          ...(messageBundleRequest.note ? { note: messageBundleRequest.note } : {}),
          items: messageBundleRequest.items,
        },
        { userId },
      );
      if (admission.status !== 'resolved') {
        reply.status(bundleAdmissionErrorStatus(admission.reason));
        return {
          error: bundleAdmissionErrorMessage(admission.reason),
          code: `MESSAGE_BUNDLE_${admission.reason.toUpperCase()}`,
          ...(admission.messageId ? { messageId: admission.messageId } : {}),
        };
      }

      const resolvedTargets = await router.resolveExplicitTargets(messageBundleRequest.targetCats, resolvedThreadId, {
        persist: false,
      });
      if (resolvedTargets.length !== messageBundleRequest.targetCats.length) {
        reply.status(400);
        return { error: 'Message Bundle contains an unavailable target cat', code: 'MESSAGE_BUNDLE_INVALID_TARGETS' };
      }

      admittedMessageBundle = admission;
      explicitBundleTargetCats = resolvedTargets;
      content = buildMessageBundleSummary(admission);
      contentBlocks = undefined;
    }

    // F167 L1 AC-A3: user message is a fresh turn — clear any in-flight ping-pong
    // streak on this thread's active worklist (no-op if none).
    resetStreak(resolvedThreadId);

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
        const autoTitle = deriveAutoThreadTitle(content || '上下文附件') ?? '上下文附件';
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

    // #699 P1-2: Validate replyTo — must exist in same thread, not deleted, and already published
    if (replyTo) {
      const replyTarget = await opts.messageStore.getById(replyTo);
      if (
        !replyTarget ||
        replyTarget.deletedAt ||
        replyTarget.threadId !== resolvedThreadId ||
        !isTimelinePublished(replyTarget) ||
        // #699 P1 (gpt52 intake review): align user-direct path with isEligibleReplyParent —
        // system/briefing are internal, non-routable, must not be quotable (else hydrateReplyPreview leaks raw content)
        isInternalNonQuotableParent(replyTarget)
      ) {
        replyTo = undefined;
      } else if (replyTarget.visibility === 'whisper') {
        // #699: Prevent public replies from quoting hidden whispers.
        // hydrateReplyPreview fetches raw content without visibility checks,
        // so a public reply's preview would leak whisper content to non-recipients.
        if (whisperVisibility !== 'whisper') {
          // Public message replying to a whisper → drop replyTo
          replyTo = undefined;
        } else {
          // Whisper replying to a whisper → ensure all new recipients can see the parent
          const parentRecipients = new Set(replyTarget.whisperTo ?? []);
          const newRecipients = whisperRecipients ?? [];
          if (newRecipients.some((catId) => !parentRecipients.has(catId))) {
            replyTo = undefined;
          }
        }
      }
    }

    // F101: /game command interception — start game directly, skip AI routing
    const parsedGame = parseGameCommand(content);
    if (parsedGame && opts.gameStore && opts.threadStore) {
      if (!gameOrchestrator || !gameAutoPlayer) {
        throw new Error('game auto-player is unavailable');
      }

      const DEFAULT_PLAYER_COUNT = 7;
      const allCatIds = catRegistry.getAllIds();
      const sanitized = parsedGame.catIds ? sanitizeCatIds(parsedGame.catIds, allCatIds) : [];
      // Fallback to all cats if sanitize filtered everything out (or no catIds provided)
      const catIds = sanitized.length > 0 ? sanitized : [...allCatIds];
      if (catIds.length === 0) {
        reply.status(400);
        return { error: '没有可用的猫猫成员，请先在设置中添加一只猫猫', code: 'NO_TARGETS' };
      }
      const playerCount = parsedGame.playerCount ?? DEFAULT_PLAYER_COUNT;
      const seats = buildGameSeats({
        humanRole: parsedGame.humanRole,
        userId,
        catIds,
        playerCount,
      });

      // Phase D: Create independent game thread with project categorization
      const ts = new Date()
        .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
        .replace(' ', '-')
        .replaceAll(':', '');
      const gameTitle = `狼人杀 — ${playerCount}人局 (${ts})`;
      const gameThread = await opts.threadStore.create(userId, gameTitle, `games/${parsedGame.gameType}`);
      const gameThreadId = gameThread.id;
      await opts.threadStore.updatePin(gameThreadId, true);

      // Notify source thread about the new game thread (include initiator for frontend guard)
      opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'game:thread_created', {
        gameThreadId,
        gameTitle,
        initiatorUserId: userId,
        timestamp: Date.now(),
      });

      // Store user message in the game thread
      const userMessage = await opts.messageStore.append({
        from: { kind: 'user', userId },
        userId,
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
    const bundleRoutingTargetCats = explicitBundleTargetCats ?? [];
    const explicitRoutingTargetCats = explicitMentionTargetCats
      ? await router.resolveExplicitTargets(explicitMentionTargetCats, resolvedThreadId, { persist: false })
      : undefined;
    if (explicitMentionTargetCats && explicitRoutingTargetCats?.length !== explicitMentionTargetCats.length) {
      reply.status(400);
      return { error: 'One or more selected member identities are invalid', code: 'INVALID_EXPLICIT_TARGETS' };
    }
    const structuredTargetCats = admittedMessageBundle ? bundleRoutingTargetCats : explicitRoutingTargetCats;
    const routingResult: Awaited<ReturnType<AgentRouter['resolveTargetsAndIntent']>> = structuredTargetCats
      ? {
          targetCats: structuredTargetCats,
          intent: parseIntent(admittedMessageBundle ? '' : content, structuredTargetCats.length),
          hasMentions: true,
          routing_warnings: [],
        }
      : await router.resolveTargetsAndIntent(content, resolvedThreadId, {
          persist: true,
          allowFallback: false,
        });
    const { targetCats: resolvedTargetCats, intent } = routingResult;
    // F35: When sending a whisper, override routing targets to only whisperTo recipients.
    // This prevents non-recipient cats from being invoked and seeing whisper content.
    const sourceTargetCats =
      whisperVisibility === 'whisper' && whisperRecipients?.length
        ? [...new Set(whisperRecipients)]
        : [...resolvedTargetCats];
    const targetCats: CatId[] =
      liveSessionId && sourceTargetCats.length === 0
        ? (((await opts.invocationQueue.resolveSendTargets([], resolvedThreadId, content)) ?? []) as CatId[])
        : [...sourceTargetCats];
    if (liveSessionId && targetCats.length !== 1)
      return reply.code(400).send({ error: 'Live requires one exact member', code: 'INVALID_LIVE_ADMISSION' });
    if (replayedSource && (liveSessionId || replayedSource.extra?.liveAdmission)) {
      const receipt = replayedSource.extra?.liveAdmission;
      if (
        !receipt ||
        receipt.sessionId !== liveSessionId ||
        receipt.targetId !== targetCats[0] ||
        replayedSource.content !== content ||
        replayedSource.threadId !== resolvedThreadId ||
        replayedSource.userId !== userId
      )
        return reply.code(409).send({ error: 'Live admission identity conflict', code: 'LIVE_ADMISSION_CONFLICT' });
      // Already accepted: return the same durable receipt before touching an ephemeral handle.
      return reply.code(202).send({
        status: 'queued',
        merged: false,
        userMessageId: replayedSource.id,
        ...(await readUserMessageReceipt(opts.messageStore, replayedSource.id, receiptOwner, replayedSource)),
      });
    }

    // Sidebar participant presence is canonical ThreadStore truth, not a
    // side-effect of the first CLI event. Persist every resolved target (the
    // router already does this for explicit mentions, so the write is
    // intentionally idempotent) and publish the existing `thread_updated`
    // event through the user's always-joined room. This makes an unopened
    // thread update immediately without inventing another event or room.
    const publishSidebarParticipants = async (participantCats: readonly CatId[] = targetCats) => {
      if (participantCats.length === 0) return;
      if (opts.threadStore?.addParticipants) {
        await admitThreadParticipants({
          userId,
          threadId: resolvedThreadId,
          targetCats: participantCats,
          threadStore: opts.threadStore,
          socketManager: opts.socketManager,
          emitPolicy: 'always',
        });
        return;
      }
      opts.socketManager.emitToUser(userId, 'thread_updated', {
        threadId: resolvedThreadId,
        participants: [...participantCats],
      });
    };
    const publishAdmittedParticipants = async () => {
      try {
        await publishSidebarParticipants();
      } catch (err) {
        log.warn({ err, threadId: resolvedThreadId }, 'Message persisted but participant projection failed');
        opts.socketManager.emitToUser(userId, 'thread_updated', {
          threadId: resolvedThreadId,
          participants: [...targetCats],
        });
      }
    };
    // Bundle admission defers this mutation until the canonical carrier write
    // succeeds, so validation/queue-capacity failures leave no false sidebar state.
    // Participants follow the winning committed targets, including a conversation fallback.

    // Server-generated idempotency key if client didn't provide one
    const resolvedIdempotencyKey = idempotencyKey ?? randomUUID();
    const sourcePayloadExtra: NonNullable<StoredMessage['extra']> = {
      ...(liveSessionId ? { liveAdmission: { sessionId: liveSessionId, targetId: targetCats[0]! } } : {}),
      ...(admittedMessageBundle ? { messageBundle: admittedMessageBundle.carrier } : {}),
    };
    const sourcePayloadWrite: { extra: NonNullable<StoredMessage['extra']> } | Record<string, never> =
      Object.keys(sourcePayloadExtra).length > 0 ? { extra: sourcePayloadExtra } : {};

    log.debug({ threadId: resolvedThreadId, targetCats, intent: intent.intent }, 'Queue ingress accepted');

    if (opts.invocationQueue) {
      const queueInput = {
        ...(liveSessionId ? { liveSessionId } : {}),
        from: { kind: 'user' as const, userId },
        threadId: resolvedThreadId,
        userId,
        kind: 'conversation_input' as const,
        ownerAuthProvenance,
        idempotencyKey: resolvedIdempotencyKey,
        content,
        targetCats,
        ...(messageDisposition ? { messageDisposition } : {}),
        onQueueEntriesAdmitted: async (
          entries: readonly import('../domains/cats/services/agents/invocation/InvocationQueue.js').QueueEntry[],
        ) => {
          targetCats.splice(0, targetCats.length, ...(entries.flatMap((entry) => entry.targets) as CatId[]));
          await publishAdmittedParticipants();
        },
        intent: intent.intent,
      };
      const enqueueResult = await opts.invocationQueue
        .send(
          opts.messageStore,
          {
            from: queueInput.from,
            userId,
            content,
            // Routing fallback is server-owned metadata, not an @mention the user wrote.
            mentions: sourceTargetCats,
            timestamp: Date.now(),
            threadId: resolvedThreadId,
            idempotencyKey: resolvedIdempotencyKey,
            deliveryStatus: 'queued',
            ...(contentBlocks ? { contentBlocks } : {}),
            ...(whisperVisibility && whisperRecipients
              ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
              : {}),
            ...(replyTo ? { replyTo } : {}),
            ...sourcePayloadWrite,
          },
          queueInput,
        )
        .catch(async (error: unknown) => {
          if (!liveSessionId) throw error;
          // The preflight replay lookup may precede another request's atomic
          // admission. Only the immutable committed source can prove a conflict;
          // an unknown write/read outcome must retain its original error.
          const committed = await opts.messageStore.getByIdempotencyKey(
            userId,
            resolvedThreadId,
            resolvedIdempotencyKey,
          );
          if (!committed) throw error;
          const receipt = committed.extra?.liveAdmission;
          if (
            !receipt ||
            receipt.sessionId !== liveSessionId ||
            receipt.targetId !== targetCats[0] ||
            committed.content !== content ||
            committed.threadId !== resolvedThreadId ||
            committed.userId !== userId
          ) {
            reply.code(409).send({ error: 'Live admission identity conflict', code: 'LIVE_ADMISSION_CONFLICT' });
            return null;
          }
          throw error;
        });
      if (!enqueueResult) return;

      // Queue full → 429, no message written (no ghost message)
      if (enqueueResult.outcome === 'full') {
        const fullQueue = await enrichQueueEntries(
          opts.invocationQueue.list(resolvedThreadId, userId),
          opts.messageStore,
        );
        opts.socketManager.emitToUser(userId, 'queue_full_warning', {
          threadId: resolvedThreadId,
          source: 'user',
          queueSize: opts.invocationQueue.size(resolvedThreadId, userId),
          queue: fullQueue,
        });
        reply.status(429);
        return {
          error: '消息队列已满',
          code: 'QUEUE_FULL',
          queueSize: opts.invocationQueue.size(resolvedThreadId, userId),
        };
      }

      const storedUserMessageId = enqueueResult.message?.id ?? null;
      if (!enqueueResult.deduped && storedUserMessageId) {
        // F192 Phase G AC-G12 / F227: detect magic words after the atomic admission commits.
        void tryDetectMagicWords(
          content,
          resolvedThreadId,
          targetCats,
          storedUserMessageId,
          userId,
          opts.onMagicWordDetected,
        );
      }

      const admittedEntries = enqueueResult.entries ?? (enqueueResult.entry ? [enqueueResult.entry] : []);
      // Common send signals Queue progress; HTTP acknowledges durable admission only.
      const admittedInvocationQueue = opts.invocationQueue;
      const admittedEntryStillQueued =
        admittedEntries.length === 0 ||
        admittedEntries.some(
          (admittedEntry) =>
            admittedInvocationQueue.getEntrySnapshot(resolvedThreadId, userId, admittedEntry.id) !== null,
        );

      // Emit queue update to this user only (privacy: scopeKey isolation)
      // appendExactEntry owns its own committed projection. Keep the generic
      // enqueue event only when custody remains in Queue.
      if (admittedEntryStillQueued) {
        await emitQueueUpdated(
          opts.socketManager,
          userId,
          resolvedThreadId,
          opts.invocationQueue.list(resolvedThreadId, userId),
          enqueueResult.outcome,
        );
      }

      await tryAutoCancelPendingHolds(resolvedThreadId, opts.holdBallCancelDeps);

      reply.status(202);
      return {
        status: 'queued',
        queuePosition: enqueueResult.queuePosition,
        entryId: enqueueResult.entry?.id,
        entries: admittedEntries.flatMap((entry) =>
          queueEntryTargetCats(entry).map((targetCatId) => ({ entryId: entry.id, targetCatId })),
        ),
        merged: false,
        ...(storedUserMessageId ? { userMessageId: storedUserMessageId } : {}),
        ...(await readUserMessageReceipt(opts.messageStore, storedUserMessageId, receiptOwner, enqueueResult.message)),
        ...(admittedMessageBundle && storedUserMessageId ? { messageBundleId: storedUserMessageId } : {}),
      };
    }
  });

  // Retry is a fresh source/attempt. The failed History delivery remains immutable;
  // Queue receives only the new pending work and never reopens a terminal row.
  app.post<{ Params: { sourceMessageId: string; targetCatId: string } }>(
    '/api/messages/:sourceMessageId/delivery-targets/:targetCatId/retry',
    async (request, reply) => {
      const parsed = cloudDeliveryRetrySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Retry 请求格式无效', code: 'INVALID_DELIVERY_RETRY_REQUEST' };
      }
      if (!opts.invocationQueue) {
        reply.status(503);
        return { error: '消息投递暂不可用', code: 'DELIVERY_RETRY_UNAVAILABLE' };
      }

      const userId = resolveUserId(request, { defaultUserId: 'default-user' });
      if (!userId) {
        reply.status(401);
        return { error: 'Identity required', code: 'IDENTITY_REQUIRED' };
      }

      const { sourceMessageId, targetCatId } = request.params;
      const source = await opts.messageStore.getById(sourceMessageId);
      const sender = source ? messageFrom(source) : undefined;
      if (
        !source ||
        source.deletedAt ||
        sender?.kind !== 'user' ||
        sender.userId !== userId ||
        !isTimelinePublished(source)
      ) {
        reply.status(404);
        return { error: '原消息不存在或不可重试', code: 'DELIVERY_RETRY_SOURCE_NOT_FOUND' };
      }

      const resolvedTargets = await router.resolveExplicitTargets([targetCatId], source.threadId, { persist: false });
      if (resolvedTargets.length !== 1 || resolvedTargets[0] !== targetCatId) {
        reply.status(409);
        return { error: '目标成员当前不可用', code: 'DELIVERY_RETRY_AUTHORITY_STALE' };
      }

      const threadMessages = await opts.messageStore.getByThread(source.threadId, 10_000, userId);
      if (!hasExactCloudDeliveryRecoveryNotice(threadMessages, sourceMessageId, targetCatId, parsed.data.attemptId)) {
        reply.status(409);
        return { error: '原发送记录已经变化', code: 'DELIVERY_RETRY_AUTHORITY_STALE' };
      }

      const idempotencyKey = cloudDeliveryRetryIdempotencyKey(sourceMessageId, targetCatId, parsed.data.attemptId);
      const existingRetry = await opts.messageStore.getByIdempotencyKey(userId, source.threadId, idempotencyKey);
      if (existingRetry) {
        reply.status(409);
        return {
          error: '这次发送已经重试过',
          code: 'DELIVERY_RETRY_AUTHORITY_STALE',
          retryMessageId: existingRetry.id,
        };
      }

      const target = resolvedTargets[0]!;
      const queueInput = {
        from: { kind: 'user' as const, userId },
        threadId: source.threadId,
        userId,
        kind: 'conversation_input' as const,
        ownerAuthProvenance: 'strict' as const,
        idempotencyKey,
        content: source.content,
        targetCats: [target],
        messageDisposition: 'next_work' as const,
        intent: 'cloud_delivery_retry',
      };
      const admitted = await opts.invocationQueue.send(
        opts.messageStore,
        {
          from: queueInput.from,
          userId,
          content: source.content,
          mentions: [target],
          timestamp: Date.now(),
          threadId: source.threadId,
          idempotencyKey,
          deliveryStatus: 'queued',
          ...(source.contentBlocks ? { contentBlocks: source.contentBlocks } : {}),
          ...(source.visibility ? { visibility: source.visibility } : {}),
          ...(source.whisperTo ? { whisperTo: source.whisperTo } : {}),
          ...(source.replyTo ? { replyTo: source.replyTo } : {}),
          extra: {
            cloudBridgeRetry: {
              v: 1,
              sourceMessageId,
              targetCatId,
              priorDispatchInvocationId: parsed.data.attemptId,
            },
          },
        },
        queueInput,
      );
      if (admitted.outcome === 'full') {
        reply.status(429);
        return { error: '消息队列已满', code: 'QUEUE_FULL' };
      }

      await emitQueueUpdated(
        opts.socketManager,
        userId,
        source.threadId,
        opts.invocationQueue.list(source.threadId, userId),
        admitted.outcome,
      );

      reply.status(202);
      return {
        status: 'queued',
        retryMessageId: admitted.message.id,
        entryId: admitted.entry?.id,
      };
    },
  );

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

    // Loop-scan: iteratively fetch batches from the store, filtering out
    // internal system messages, until we have `limit + 1` visible items
    // (the +1 probes hasMore) or the store is exhausted. This guarantees
    // reachability regardless of how many consecutive internal messages
    // cluster together — the old fixed-overscan approach would return
    // {messages:[], hasMore:true} when internal clusters exceeded the cap.
    //
    // Termination guarantee: both in-memory and Redis store implementations
    // use strict cursor advancement (exclusive `< cursor`), so each batch
    // is strictly older than the previous. The store has finite data, so
    // storeExhausted (rawBatch.length < BATCH_SIZE) is guaranteed to fire.
    // The prevCursorId check is a defensive backstop against store bugs
    // where the cursor fails to advance — it breaks the loop rather than
    // spinning forever, and does NOT impose any functional scan limit.
    const BATCH_SIZE = limit + 1 + 20; // generous first batch for common case
    const needed = limit + 1;
    const browserTimelineRead = {
      includeQueuedCatMessages: true,
      includeRecalledUserMessages: true,
    } as const;

    type StoredMsg = Awaited<ReturnType<typeof opts.messageStore.getByThread>>[number];
    const allVisible: StoredMsg[] = [];
    let cursorTs = beforeTs;
    let cursorId = beforeId;
    let storeExhausted = false;

    while (allVisible.length < needed && !storeExhausted) {
      const rawBatch =
        cursorTs != null
          ? await opts.messageStore.getByThreadBefore(
              resolvedThreadId,
              cursorTs,
              BATCH_SIZE,
              cursorId,
              userId,
              browserTimelineRead,
            )
          : await opts.messageStore.getByThread(resolvedThreadId, BATCH_SIZE, userId, browserTimelineRead);

      if (rawBatch.length < BATCH_SIZE) {
        storeExhausted = true;
      }

      // Filter only internal route-guard diagnostics. F148 ContextBriefing is a
      // contracted user-visible transparency card; its non-routing guarantee is
      // enforced by incremental-context assembly, not timeline hydration.
      // `routing-guard-failure` is a retired producer. Keep this read-boundary
      // exclusion only so rows written by older releases never reappear after
      // upgrade; current runtime code must not append or broadcast new rows.
      const batchVisible = rawBatch.filter((m) => m.source?.connector !== 'routing-guard-failure');

      // Prepend: each subsequent batch is chronologically older
      allVisible.unshift(...batchVisible);

      // Advance cursor to the oldest message in this batch for next iteration.
      // Store returns oldest-first (after internal .reverse()), so [0] is oldest.
      // Defensive: if cursor didn't advance, break to prevent infinite loop.
      if (rawBatch.length > 0) {
        const oldest = rawBatch[0]!;
        const nextTs = getTimelineOrderTime(oldest);
        const nextId = oldest.id;
        if (nextTs === cursorTs && nextId === cursorId) break; // cursor stuck — store bug
        cursorTs = nextTs;
        cursorId = nextId;
      }
    }

    // hasMore: true if we collected more visible items than the page size,
    // or if we haven't exhausted the store (more may exist deeper).
    const hasMore = allVisible.length > limit || !storeExhausted;
    const page = allVisible.length > limit ? allVisible.slice(allVisible.length - limit) : allVisible;

    // Map chat messages (union type allows summary items to be pushed later)
    type TimelineItem = {
      id: string;
      type: 'user' | 'assistant' | 'connector' | 'summary' | 'system';
      catId: string | null;
      content: string;
      timestamp: number;
      lifecycle?: StoredMessage['lifecycle'];
      summary?: { id: string; topic: string; conclusions: string[]; openQuestions: string[]; createdBy: string };
      [key: string]: unknown;
    };
    const chatItems: TimelineItem[] = page.map((m) => {
      const from = messageFrom(m);
      // Same shared rule the client hydration paths use; `messageFrom` always names a sender here.
      const type: TimelineItem['type'] = timelineMessageKind(from, Boolean(m.source)) ?? 'user';
      return {
        id: m.id,
        type,
        from,
        catId: m.catId,
        content: m.content,
        ...(m.lifecycle ? { lifecycle: m.lifecycle } : {}),
        ...(m.lifecycle?.kind === 'delivery_failure' ? { variant: 'error' } : {}),
        ...(m.contentBlocks ? { contentBlocks: m.contentBlocks } : {}),
        ...(m.toolEvents ? { toolEvents: m.toolEvents } : {}),
        ...(m.metadata ? { metadata: m.metadata } : {}),
        ...(m.origin ? { origin: m.origin } : {}),
        ...(m.thinking ? { thinking: m.thinking } : {}),
        ...(m.extra?.semanticEvent ||
        m.extra?.liveCompanion ||
        m.extra?.contentModificationRequestV1 ||
        m.extra?.systemInfo ||
        m.extra?.rich ||
        m.extra?.routingWarnings ||
        isCrossThreadProvenance(m.extra?.crossPost?.sourceThreadId, m.threadId) ||
        m.extra?.coordination ||
        m.extra?.isExplicitPost ||
        m.extra?.stream ||
        m.extra?.targetCats ||
        m.extra?.messageBundle ||
        m.extra?.scheduler ||
        m.extra?.systemKind ||
        m.extra?.a2aRouting ||
        m.extra?.freshness ||
        m.extra?.causal ||
        m.extra?.turnExecution ||
        m.extra?.auxiliaryTurnExecutions ||
        m.recall ||
        m.extra?.recovery
          ? {
              extra: {
                ...(m.extra?.semanticEvent ? { semanticEvent: m.extra.semanticEvent } : {}),
                ...(m.extra?.liveCompanion?.identity
                  ? { liveCompanion: { identity: m.extra.liveCompanion.identity } }
                  : {}),
                ...(m.extra?.contentModificationRequestV1
                  ? { contentModificationRequestV1: m.extra.contentModificationRequestV1 }
                  : {}),
                ...(m.extra?.systemInfo ? { systemInfo: m.extra.systemInfo } : {}),
                ...(m.extra?.rich ? { rich: m.extra.rich } : {}),
                ...(m.extra?.routingWarnings ? { routingWarnings: m.extra.routingWarnings } : {}),
                ...(isCrossThreadProvenance(m.extra?.crossPost?.sourceThreadId, m.threadId)
                  ? { crossPost: m.extra!.crossPost! }
                  : {}),
                ...(m.extra?.coordination ? { coordination: m.extra.coordination } : {}),
                ...(m.extra?.isExplicitPost ? { isExplicitPost: true } : {}),
                ...(m.extra?.stream ? { stream: m.extra.stream } : {}),
                ...(m.extra?.targetCats ? { targetCats: m.extra.targetCats } : {}),
                ...(m.extra?.messageBundle ? { messageBundle: m.extra.messageBundle } : {}),
                ...(m.extra?.scheduler ? { scheduler: m.extra.scheduler } : {}),
                ...(m.extra?.systemKind ? { systemKind: m.extra.systemKind } : {}),
                ...(m.extra?.a2aRouting ? { a2aRouting: m.extra.a2aRouting } : {}),
                ...(m.extra?.freshness ? { freshness: m.extra.freshness } : {}),
                ...(m.extra?.causal ? { causal: m.extra.causal } : {}),
                ...(m.extra?.turnExecution ? { turnExecution: m.extra.turnExecution } : {}),
                ...(m.extra?.auxiliaryTurnExecutions
                  ? { auxiliaryTurnExecutions: m.extra.auxiliaryTurnExecutions }
                  : {}),
                ...(m.recall ? { recall: m.recall } : {}),
                ...(m.extra?.recovery ? { recovery: projectRecoveryForHistory(m.extra.recovery) } : {}),
              },
            }
          : {}),
        ...(m.visibility ? { visibility: m.visibility } : {}),
        ...(m.whisperTo ? { whisperTo: m.whisperTo } : {}),
        ...(m.revealedAt ? { revealedAt: m.revealedAt } : {}),
        ...(m.deliveredAt ? { deliveredAt: m.deliveredAt } : {}),
        ...(m.timelineOrderAt !== undefined ? { timelineOrderAt: m.timelineOrderAt } : {}),
        ...(m.source
          ? {
              source: {
                connector: m.source.connector,
                label: m.source.label,
                icon: m.source.icon,
                ...(m.source.url ? { url: m.source.url } : {}),
                ...(m.source.meta ? { meta: m.source.meta } : {}),
                ...(m.source.sender ? { sender: m.source.sender } : {}),
              },
            }
          : {}),
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        timestamp: m.timestamp,
      };
    });

    // F121: Hydrate reply previews for messages with replyTo
    const replyItems = chatItems.filter((item) => item.replyTo);
    if (replyItems.length > 0) {
      const { hydrateReplyPreview } = await import('../domains/cats/services/stores/ports/MessageStore.js');
      await Promise.all(
        replyItems.map(async (item) => {
          const source = item.source as { connector?: string } | undefined;
          if (source?.connector === 'cloud-bridge-status') {
            const parent = await resolveVisibleReplyParent(opts.messageStore, item.replyTo as string, {
              threadId: resolvedThreadId,
              viewer: { type: 'user' },
              publicReply: true,
            });
            if (!parent) return;
          }
          const preview = await hydrateReplyPreview(opts.messageStore, item.replyTo as string);
          if (preview) {
            item.replyPreview = preview;
          }
        }),
      );
    }

    // #80 / F117: a streaming draft is only the in-flight body of its durable response R.
    // R is admitted empty as a processing lifecycle response whose lifecycle.invocationId is
    // the child turn id that keys DraftStore, so a draft folds into R by that exact id on
    // whichever page holds R — a long turn pushed to an older page by newer messages still
    // reads its body. A draft without a processing R on this page is ignored here: it never
    // becomes a standalone record and this read never deletes it.
    if (opts.draftStore) {
      const processingResponseIndexByInvocationId = new Map<string, number>();
      for (const [index, item] of chatItems.entries()) {
        if (item.lifecycle?.kind === 'response' && item.lifecycle.status === 'processing') {
          processingResponseIndexByInvocationId.set(item.lifecycle.invocationId, index);
        }
      }
      if (processingResponseIndexByInvocationId.size > 0) {
        const drafts = await opts.draftStore.getByThread(userId, resolvedThreadId);
        for (const d of drafts) {
          const index = processingResponseIndexByInvocationId.get(d.invocationId);
          if (index === undefined) continue;
          chatItems[index] = {
            ...chatItems[index],
            content: d.content,
            isDraft: true,
            ...(d.toolEvents ? { toolEvents: d.toolEvents } : {}),
            ...(d.thinking ? { thinking: d.thinking } : {}),
          };
        }
      }
    }

    // Auto-summary disabled (clowder-ai#343): regex-based summaries removed from chat flow.
    // Scheduled compaction (SummaryCompactionTask) continues for memory infrastructure.

    return normalizeJsonUnicode({
      messages: chatItems,
      hasMore,
    });
  });
};
