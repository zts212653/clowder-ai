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
import {
  type CatId,
  catRegistry,
  isCrossThreadProvenance,
  type MessageContent,
  type MessageWorkDisposition,
} from '@cat-cafe/shared';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { WaitContinuationRetryCommitter } from '../domains/ball-custody/WaitContinuationRetryCommitter.js';
import type { WaitContinuationRetryPreflight } from '../domains/ball-custody/WaitContinuationRetryPreflight.js';
import { getThreadLiveInvocations } from '../domains/cats/services/agents/invocation/getThreadLiveInvocations.js';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import { createInitialQueuedMessageCustody } from '../domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import { resetStreak } from '../domains/cats/services/agents/routing/WorklistRegistry.js';
import { parseIntent } from '../domains/cats/services/context/IntentParser.js';
import {
  type MessageSelectionAdmissionResult,
  MessageSelectionResolver,
} from '../domains/cats/services/context/MessageSelectionResolver.js';
import type { FreshnessClosureStore } from '../domains/cats/services/freshness/FreshnessClosureStore.js';
import {
  isLeakedSupplementDecline,
  projectFreshnessSupplementForHistory,
} from '../domains/cats/services/freshness/glass-box/freshness-supplement-history-projection.js';
import { createGameDriver } from '../domains/cats/services/game/createGameDriver.js';
import type { GameDriver } from '../domains/cats/services/game/GameDriver.js';
import { GameOrchestrator } from '../domains/cats/services/game/GameOrchestrator.js';
import { WerewolfLobby } from '../domains/cats/services/game/werewolf/WerewolfLobby.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import type { IDraftStore } from '../domains/cats/services/stores/ports/DraftStore.js';
import type { IGameStore } from '../domains/cats/services/stores/ports/GameStore.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { isTimelinePublished } from '../domains/cats/services/stores/ports/MessageStore.js';
import { projectQueueReceipt } from '../domains/cats/services/stores/ports/queued-message-receipt.js';
import { deriveAutoThreadTitle, type IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  type ITurnExecutionStore,
  projectTurnExecutionMessage,
} from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import {
  getTimelineOrderTime,
  isInternalNonQuotableParent,
  isSystemUserMessage,
  resolveVisibleReplyParent,
} from '../domains/cats/services/stores/visibility.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { normalizeJsonUnicode } from '../utils/json-unicode.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';
import { admitThreadParticipants } from './thread-participant-admission.js';

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
import {
  resolveFreshnessCarrierCapabilityOrUndeclared,
  resolveMessageDispositionForAdmission,
  resolveQueueAuthorIntentByCatId,
} from './message-disposition-admission.js';
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
  /** Shared owner-preference root. Optional test harnesses retain product-default behavior. */
  projectRoot?: string;
  registry: InvocationRegistry;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  router: AgentRouter;
  threadStore?: IThreadStore;
  uploadDir?: string;
  invocationTracker?: InvocationTracker;
  invocationRecordStore?: IInvocationRecordStore;
  /** Durable per-child lifecycle truth used to bridge tracker/draft handoff gaps. */
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get' | 'listByParent'>;

  /** #80: Streaming draft store for F5 recovery */
  draftStore?: IDraftStore;
  /** Canonical durable ingress for every normal user message. */
  invocationQueue?: InvocationQueue;
  /** Single event-driven admission and execution coordinator. */
  queueProcessor?: QueueProcessor;
  /** Gate 5: read-only canonical authority check before any retry mutation. */
  retryAuthorityPreflight?: Pick<WaitContinuationRetryPreflight, 'preflight'>;
  /** Gate 5: atomically bind current canonical authority to the custody attempt commit. */
  retryAuthorityCommitter?: Pick<WaitContinuationRetryCommitter, 'commit'>;
  /** ADR-042: canonical supplement truth used to hydrate original-bubble status on F5/history reads. */
  freshnessClosureStore?: Pick<FreshnessClosureStore, 'listSupplementsByThread'>;
  /** F101: Game store for /game command interception */
  gameStore?: IGameStore;
  /** F101: Injectable auto-player for lifecycle-safe teardown in tests/routes */
  autoPlayer?: Pick<GameDriver, 'startLoop' | 'stopLoop' | 'stopAllLoops'>;
  /** F167 Phase J: deps for auto-cancelling pending hold-ball tasks on user message */
  holdBallCancelDeps?: HoldBallCancelDeps;
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

export function tryAutoCancelPendingHolds(threadId: string, deps: HoldBallCancelDeps | undefined): void {
  if (!deps) return;
  try {
    const cancelled = cancelPendingHoldsForThread(threadId, deps);
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

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;

export const messagesRoutes: FastifyPluginAsync<MessagesRoutesOptions> = async (app, opts) => {
  const uploadDir = getDefaultUploadDir(opts.uploadDir ?? process.env.UPLOAD_DIR);
  const turnExecutionStore = opts.turnExecutionStore;

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

  /**
   * F1308: retry one visible failed target without cloning or re-sending the
   * authored message. `attemptId` is the optimistic-concurrency fence: once a
   * retry is accepted, a second click still naming the old failed attempt gets
   * a conflict instead of a second execution.
   */
  app.post<{ Params: { messageId: string; targetCatId: string }; Body: { attemptId?: unknown } }>(
    '/api/messages/:messageId/queue-targets/:targetCatId/retry',
    async (request, reply) => {
      const userId = resolveUserId(request, { defaultUserId: 'default-user' });
      if (!userId) {
        reply.status(401);
        return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
      }
      const attemptId = request.body?.attemptId;
      if (typeof attemptId !== 'string' || attemptId.length === 0) {
        reply.status(400);
        return { error: 'attemptId is required' };
      }
      const retryAuthorityPreflight = opts.retryAuthorityPreflight;
      const retryAuthorityCommitter = opts.retryAuthorityCommitter;
      if (!opts.invocationQueue || !opts.queueProcessor || !retryAuthorityPreflight || !retryAuthorityCommitter) {
        reply.status(503);
        return { error: 'Queue retry is temporarily unavailable', code: 'QUEUE_RETRY_UNAVAILABLE' };
      }
      const message = await opts.messageStore.getById(request.params.messageId);
      if (!message || message.userId !== userId || !message.queueCustody) {
        reply.status(404);
        return { error: 'Queued message was not found', code: 'QUEUE_MESSAGE_NOT_FOUND' };
      }
      const authority = await retryAuthorityPreflight.preflight({
        message,
        requestingUserId: userId,
        targetCatId: request.params.targetCatId,
      });
      if (!authority.ok) {
        reply.status(409);
        return {
          error: 'This target no longer has current retry authority',
          code: 'QUEUE_RETRY_AUTHORITY_STALE',
          reason: authority.reason,
        };
      }
      const targetCarrier = message.queueCustody.carrierByTargetCatId?.[request.params.targetCatId];
      const carrierEntryId = targetCarrier?.entryId ?? message.queueCustody.entryId;
      const carrier = targetCarrier
        ? opts.invocationQueue.getEntrySnapshotForUserById(userId, carrierEntryId)
        : undefined;
      if (targetCarrier && !carrier && (!targetCarrier.threadId || targetCarrier.userId !== userId)) {
        reply.status(409);
        return { error: 'This target no longer has a retryable delivery carrier', code: 'QUEUE_TARGET_NOT_RETRYABLE' };
      }
      const carrierThreadId = carrier?.threadId ?? targetCarrier?.threadId ?? message.threadId;
      const result = await opts.queueProcessor.retryFailedTarget(
        carrierThreadId,
        userId,
        carrierEntryId,
        message.id,
        request.params.targetCatId,
        attemptId,
        (transitions) =>
          retryAuthorityCommitter.commit({
            authorityMessageId: request.params.messageId,
            requestingUserId: userId,
            targetCatId: request.params.targetCatId,
            transitions,
          }),
      );
      if (result.outcome === 'unavailable') {
        reply.status(503);
        return { error: 'Queue retry is temporarily unavailable', code: 'QUEUE_RETRY_UNAVAILABLE' };
      }
      if (result.outcome === 'authority_stale') {
        reply.status(409);
        return {
          error: 'This target no longer has current retry authority',
          code: 'QUEUE_RETRY_AUTHORITY_STALE',
          reason: result.reason,
        };
      }
      if (result.outcome !== 'retried') {
        reply.status(409);
        return { error: 'This target is no longer retryable', code: 'QUEUE_TARGET_NOT_RETRYABLE' };
      }
      reply.status(202);
      return {
        status: 'retry_queued',
        entryId: result.entryId,
        targetCatId: request.params.targetCatId,
        attemptId: result.attemptId,
      };
    },
  );

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
    const ownerAuthProvenance = resolveStrictUserId(request) === userId ? 'strict' : 'compatibility_fallback';

    // Default to 'default' thread for lobby (prevents global broadcast)
    const resolvedThreadId = threadId ?? 'default';

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
    const routingResult: Awaited<ReturnType<AgentRouter['resolveTargetsAndIntent']>> = admittedMessageBundle
      ? {
          targetCats: bundleRoutingTargetCats,
          intent: parseIntent('', bundleRoutingTargetCats.length),
          hasMentions: true,
          routing_warnings: [],
          attemptBatch: {
            parserMode: 'user',
            spanBasis: 'lowercased_message',
            attempts: [],
            truncated: false,
            metricEligible: true,
          },
        }
      : await router.resolveTargetsAndIntent(content, resolvedThreadId, {
          persist: true,
          allowFallback: false,
        });
    const { targetCats: resolvedTargetCats, intent, routing_warnings } = routingResult;
    // F35: When sending a whisper, override routing targets to only whisperTo recipients.
    // This prevents non-recipient cats from being invoked and seeing whisper content.
    const targetCats =
      whisperVisibility === 'whisper' && whisperRecipients?.length
        ? [...new Set(whisperRecipients)]
        : [...resolvedTargetCats];
    const visibleRoutingWarnings =
      whisperVisibility !== 'whisper' && routing_warnings?.length ? [...routing_warnings] : [];

    // Sidebar participant presence is canonical ThreadStore truth, not a
    // side-effect of the first CLI event. Persist every resolved target (the
    // router already does this for explicit mentions, so the write is
    // intentionally idempotent) and publish the existing `thread_updated`
    // event through the user's always-joined room. This makes an unopened
    // thread update immediately without inventing another event or room.
    const publishSidebarParticipants = async () => {
      if (targetCats.length === 0) return;
      if (opts.threadStore?.addParticipants) {
        await admitThreadParticipants({
          userId,
          threadId: resolvedThreadId,
          targetCats,
          threadStore: opts.threadStore,
          socketManager: opts.socketManager,
          emitPolicy: 'always',
        });
        return;
      }
      opts.socketManager.emitToUser(userId, 'thread_updated', {
        threadId: resolvedThreadId,
        participants: [...targetCats],
      });
    };
    const publishAdmittedBundleParticipants = async () => {
      try {
        await publishSidebarParticipants();
      } catch (err) {
        log.warn({ err, threadId: resolvedThreadId }, 'Bundle persisted but participant projection failed');
        opts.socketManager.emitToUser(userId, 'thread_updated', {
          threadId: resolvedThreadId,
          participants: [...targetCats],
        });
      }
    };
    // Bundle admission defers this mutation until the canonical carrier write
    // succeeds, so validation/queue-capacity failures leave no false sidebar state.
    if (!admittedMessageBundle) await publishSidebarParticipants();

    // Server-generated idempotency key if client didn't provide one
    const resolvedIdempotencyKey = idempotencyKey ?? randomUUID();
    const sourcePayloadExtra: NonNullable<StoredMessage['extra']> = {
      ...(admittedMessageBundle ? { messageBundle: admittedMessageBundle.carrier } : {}),
      ...(visibleRoutingWarnings.length > 0 ? { routingWarnings: visibleRoutingWarnings } : {}),
    };
    const sourcePayloadWrite: { extra: NonNullable<StoredMessage['extra']> } | Record<string, never> =
      Object.keys(sourcePayloadExtra).length > 0 ? { extra: sourcePayloadExtra } : {};

    log.debug({ threadId: resolvedThreadId, targetCats, intent: intent.intent }, 'Queue ingress accepted');

    if (opts.invocationQueue) {
      // ① Enqueue first (sync, capacity gatekeeper) — messageId is null at this point
      const enqueueResult = opts.invocationQueue.enqueue({
        from: { kind: 'user', userId },
        threadId: resolvedThreadId,
        userId,
        kind: 'conversation_input',
        ownerAuthProvenance,
        idempotencyKey: resolvedIdempotencyKey,
        content,
        targetCats,
        ...(visibleRoutingWarnings.length > 0 ? { routingWarnings: visibleRoutingWarnings } : {}),
        authorIntentByCatId: resolveQueueAuthorIntentByCatId({
          targetCats,
          requested: resolveMessageDispositionForAdmission({
            explicit: messageDisposition,
            projectRoot: opts.projectRoot,
            threadId: resolvedThreadId,
          }),
          threadId: resolvedThreadId,
          userId,
          invocationTracker: opts.invocationTracker,
          resolveCarrierCapability: (catId) => resolveFreshnessCarrierCapabilityOrUndeclared(opts.router, catId),
        }),
        intent: intent.intent,
      });

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

      let storedUserMessageId: string | null = enqueueResult.entry?.messageId ?? null;

      // ② Persist queued user work. F264 publishes it to the owner's timeline;
      // deliveryStatus still keeps it out of cat context/mentions until dequeue.
      // If enqueue returned a deduped active entry, reuse existing messageId and skip append.
      if (!enqueueResult.deduped) {
        try {
          if (!enqueueResult.entry) throw new Error('successful queue admission is missing its entry');
          const userMessage = await opts.messageStore.append({
            from: { kind: 'user', userId },
            userId,
            content,
            mentions: targetCats,
            timestamp: Date.now(),
            threadId: resolvedThreadId,
            idempotencyKey: resolvedIdempotencyKey,
            deliveryStatus: 'queued', // Browser-visible, but not cat-context delivered.
            queueCustody: createInitialQueuedMessageCustody(enqueueResult.entry),
            ...(contentBlocks ? { contentBlocks } : {}),
            ...(whisperVisibility && whisperRecipients
              ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
              : {}),
            ...(replyTo ? { replyTo } : {}),
            ...sourcePayloadWrite,
          });
          storedUserMessageId = userMessage.id;

          // F192 Phase G AC-G12 / F227: detect magic words → Event Memory (queued path)
          void tryDetectMagicWords(
            content,
            resolvedThreadId,
            targetCats,
            storedUserMessageId,
            userId,
            opts.onMagicWordDetected,
          );

          const queueEntryId = enqueueResult.entry?.id;
          if (queueEntryId) {
            opts.invocationQueue.backfillMessageId(resolvedThreadId, userId, queueEntryId, userMessage.id);
          }
        } catch (err) {
          const queueEntryId = enqueueResult.entry?.id;
          if (queueEntryId) {
            opts.invocationQueue.rollbackEnqueue(resolvedThreadId, userId, queueEntryId);
          }
          throw err;
        }
      }

      if (admittedMessageBundle) await publishAdmittedBundleParticipants();

      // Emit queue update to this user only (privacy: scopeKey isolation)
      await emitQueueUpdated(
        opts.socketManager,
        userId,
        resolvedThreadId,
        opts.invocationQueue.list(resolvedThreadId, userId),
        opts.messageStore,
        enqueueResult.outcome,
      );

      tryAutoCancelPendingHolds(resolvedThreadId, opts.holdBallCancelDeps);
      void opts.queueProcessor?.requestDrain(resolvedThreadId);

      reply.status(202);
      return {
        status: 'queued',
        queuePosition: enqueueResult.queuePosition,
        entryId: enqueueResult.entry?.id,
        merged: false,
        ...(storedUserMessageId ? { userMessageId: storedUserMessageId } : {}),
        ...(admittedMessageBundle && storedUserMessageId ? { messageBundleId: storedUserMessageId } : {}),
      };
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
      const batchVisible = rawBatch.filter(
        (m) => m.source?.connector !== 'routing-guard-failure' && !isLeakedSupplementDecline(m),
      );

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

    const supplementProjectionByOriginal = new Map<
      string,
      Awaited<ReturnType<typeof projectFreshnessSupplementForHistory>>
    >();
    if (opts.freshnessClosureStore) {
      try {
        const supplements = await opts.freshnessClosureStore.listSupplementsByThread(resolvedThreadId);
        for (const supplement of supplements) {
          if (supplement.userId !== userId) continue;
          const projection = await projectFreshnessSupplementForHistory(supplement, opts.messageStore);
          const current = supplementProjectionByOriginal.get(supplement.originalMessageId);
          if (
            !current ||
            projection.seq > current.seq ||
            (projection.seq === current.seq && projection.updatedAt > current.updatedAt)
          ) {
            supplementProjectionByOriginal.set(supplement.originalMessageId, projection);
          }
        }
      } catch (err) {
        log.warn({ err, threadId: resolvedThreadId }, 'F254 supplement history hydration failed');
      }
    }

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
      type: (m.from?.kind === 'agent'
        ? 'assistant'
        : m.from?.kind === 'external' || m.from?.kind === 'plugin'
          ? 'connector'
          : m.from?.kind === 'system'
            ? m.source
              ? 'connector'
              : 'system'
            : m.from?.kind === 'user'
              ? 'user'
              : m.catId
                ? isSystemUserMessage(m)
                  ? 'system'
                  : 'assistant'
                : m.source
                  ? 'connector'
                  : isSystemUserMessage(m)
                    ? 'system'
                    : 'user') as TimelineItem['type'],
      ...(m.from ? { from: m.from } : {}),
      catId: m.catId,
      content: m.content,
      ...(m.lifecycle ? { lifecycle: m.lifecycle } : {}),
      ...(m.lifecycle?.kind === 'delivery_failure' ? { variant: 'error' } : {}),
      ...(m.contentBlocks ? { contentBlocks: m.contentBlocks } : {}),
      ...(m.toolEvents ? { toolEvents: m.toolEvents } : {}),
      ...(m.metadata ? { metadata: m.metadata } : {}),
      ...(m.origin ? { origin: m.origin } : {}),
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.extra?.rich ||
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
      m.extra?.supplement ||
      m.extra?.causal ||
      m.extra?.turnExecution ||
      m.extra?.auxiliaryTurnExecutions ||
      supplementProjectionByOriginal.has(m.id) ||
      m.queueCustody ||
      m.recall ||
      m.extra?.recovery
        ? {
            extra: {
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
              ...(m.extra?.supplement ? { supplement: m.extra.supplement } : {}),
              ...(m.extra?.causal ? { causal: m.extra.causal } : {}),
              ...(m.extra?.turnExecution ? { turnExecution: m.extra.turnExecution } : {}),
              ...(m.extra?.auxiliaryTurnExecutions ? { auxiliaryTurnExecutions: m.extra.auxiliaryTurnExecutions } : {}),
              ...(supplementProjectionByOriginal.has(m.id)
                ? { freshnessSupplement: supplementProjectionByOriginal.get(m.id) }
                : {}),
              ...(m.queueCustody ? { queueReceipt: projectQueueReceipt(m.queueCustody) } : {}),
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
    }));

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

    // #80: Merge active streaming drafts (first page only — no before cursor)
    if (!before && opts.draftStore) {
      const draftStore = opts.draftStore;
      const drafts = await draftStore.getByThread(userId, resolvedThreadId);
      let activeDrafts = drafts;
      // #80 fix-B diagnostic: trace draft merge for F5 recovery verification
      if (drafts.length > 0) {
        request.log.info(
          { threadId: resolvedThreadId, draftCount: drafts.length, draftIds: drafts.map((d) => d.invocationId) },
          '#80 draft merge: found active drafts',
        );
        // P1-2 dedup: filter out drafts whose invocationId matches a formal message.
        // F194 Phase Z3 P1-3 (砚砚 R): formal set MUST collect both `invocationId` (parent SoT) and
        // `turnInvocationId` (Z3 dual id, where draft.invocationId === turnInvocationId for new
        // formal messages). Without this, append-success-but-draft-not-yet-deleted window double-shows
        // formal + draft for the same turn.
        const formalInvocationIds = new Set<string>();
        for (const m of page) {
          const parentInv = m.extra?.stream?.invocationId;
          const turnInv = m.extra?.stream?.turnInvocationId;
          if (parentInv) formalInvocationIds.add(parentInv);
          if (turnInv) formalInvocationIds.add(turnInv);
        }
        activeDrafts = drafts.filter((d) => !formalInvocationIds.has(d.invocationId));
        // Cloud R4 P2: if drafts survive page-level dedup, widen the check to cover
        // formal messages pushed off the first page (race window: TTL > page depth).
        // Cloud R5 P2: wider window must always exceed page limit (limit max=200 → worst case 800).
        if (activeDrafts.length > 0 && page.length >= limit) {
          const widerLimit = Math.max(200, limit * 4);
          const wider = await opts.messageStore.getByThread(resolvedThreadId, widerLimit, userId, browserTimelineRead);
          for (const m of wider) {
            const parentInv = m.extra?.stream?.invocationId;
            const turnInv = m.extra?.stream?.turnInvocationId;
            if (parentInv) formalInvocationIds.add(parentInv);
            if (turnInv) formalInvocationIds.add(turnInv);
          }
          activeDrafts = activeDrafts.filter((d) => !formalInvocationIds.has(d.invocationId));
        }
      }

      // F194 Phase B step 2b: canonical getThreadLiveInvocations helper.
      // Cloud R17 P1: helper MUST run even when activeDrafts is empty — zombies
      // (record running + no fresh draft + age past grace) are exactly the empty-drafts
      // case. Skipping the helper here means /messages never reconciles them; only /queue
      // would, and a thread that's read but not queue-checked stays phantom forever.
      //
      // AC-B5 preservation (砚砚 R6 P1 fix): gate only requires `invocationRecordStore` —
      // tracker is OPTIONAL. Embedded modes / legacy tests that wire recordStore but not
      // tracker still get zombie detection + orphan filtering.
      if (opts.invocationRecordStore) {
        const recordStore = opts.invocationRecordStore;
        const tracker = opts.invocationTracker;
        const draftsForHelper = activeDrafts; // already deduped against formal messages (or empty)
        try {
          const liveness = await getThreadLiveInvocations(resolvedThreadId, userId, {
            listRunningRecords: (tid, uid) => recordStore.listRunningByThread(tid, uid),
            getActiveSlots: (tid) => tracker?.getActiveSlots(tid) ?? [],
            getTrackerUserId: (tid, cid) => tracker?.getUserId(tid, cid) ?? null,
            getDrafts: () => draftsForHelper,
            ...(turnExecutionStore
              ? { listTurnExecutionsByParent: (parentId: string) => turnExecutionStore.listByParent(parentId) }
              : {}),
            // F194 Phase Z (KD-22): namespace bridge — child registry id → parent recordStore id.
            // Wraps existing InvocationRegistry.getRecord (parentInvocationId field) + getLatestId.
            // Helper uses these to detect parent+child execution chain liveness and cat-slot reuse
            // zombies (砚砚 R1 P1-1: 结构化 dep, not boolean black-box).
            getTurnInvocation: async (id) => {
              const rec = await opts.registry.getRecord(id);
              if (!rec) return null;
              return {
                parentInvocationId: rec.parentInvocationId,
                threadId: rec.threadId,
                userId: rec.userId,
                catId: rec.catId,
                createdAt: rec.createdAt,
              };
            },
            getLatestTurnInvocationId: (tid, cat) => opts.registry.getLatestId(tid, cat),
            // F194 AC-B12: route diagnostic events into request log. NB: do NOT spread
            // `source: 'F194'` — that would clobber LivenessEvent.source (record+draft /
            // record-only / tracker+draft / null), losing the diagnostic. Use `feature`.
            onLog: (event) => request.log.info({ ...event, feature: 'F194' }, 'F194 liveness event'),
          });
          const liveInvocationIds = new Set(liveness.active.map((s) => s.invocationId));
          const orphanDrafts = activeDrafts.filter((d) => !liveInvocationIds.has(d.invocationId));
          activeDrafts = activeDrafts.filter((d) => liveInvocationIds.has(d.invocationId));
          // Zombie candidates remain diagnostic-only here. Explicit owner reconciliation
          // is serialized outside the GET path so reads cannot terminate provider work.
          if (orphanDrafts.length > 0) {
            request.log.info(
              {
                threadId: resolvedThreadId,
                orphanCount: orphanDrafts.length,
                draftIds: orphanDrafts.map((d) => d.invocationId),
                cleanup: 'helper-canonical',
              },
              '#80 draft merge: filtered orphan drafts (F194 helper-canonical)',
            );
          }
        } catch (err) {
          // F194 AC-B13: fail-open + fallback metric — record/tracker error must not 500
          // the read endpoint, but split-brain protection is bypassed during fallback.
          request.log.warn(
            {
              err,
              kind: 'liveness_fallback',
              threadId: resolvedThreadId,
              userId,
              feature: 'F194',
              endpoint: '/messages',
              draftCount: activeDrafts.length,
            },
            '#80 draft merge: F194 helper threw, fall-open keep all drafts',
          );
        }
      }

      // P2: stable sort by updatedAt for parallel multi-cat drafts
      activeDrafts.sort((a, b) => a.updatedAt - b.updatedAt);
      if (activeDrafts.length > 0) {
        request.log.info(
          { threadId: resolvedThreadId, mergedCount: activeDrafts.length, cats: activeDrafts.map((d) => d.catId) },
          '#80 draft merge: merging drafts into response',
        );
      }
      const draftTurnExecutions = new Map<string, Awaited<ReturnType<ITurnExecutionStore['get']>>>();
      if (turnExecutionStore) {
        await Promise.all(
          activeDrafts.map(async (draft) => {
            try {
              const execution = await turnExecutionStore.get(draft.invocationId);
              if (
                execution &&
                execution.threadId === resolvedThreadId &&
                execution.userId === userId &&
                execution.catId === draft.catId
              ) {
                draftTurnExecutions.set(draft.invocationId, execution);
              }
            } catch (err) {
              request.log.warn(
                {
                  err,
                  threadId: resolvedThreadId,
                  invocationId: draft.invocationId,
                  feature: 'F194',
                },
                '#80 draft merge: turn execution identity lookup failed',
              );
            }
          }),
        );
      }

      for (const d of activeDrafts) {
        const turnExecution = draftTurnExecutions.get(d.invocationId);
        chatItems.push({
          id: `draft-${d.invocationId}`,
          type: 'assistant',
          catId: d.catId as string | null,
          content: d.content,
          timestamp: d.updatedAt,
          isDraft: true,
          origin: 'stream',
          // DraftStore is keyed by the child turn id. Preserve the real dual identity
          // whenever TurnExecutionStore can resolve it: the active slot uses the parent
          // invocation while the visible bubble uses the child turn. Collapsing both
          // fields to the child makes the pending-member projection see two unrelated
          // Kimi invocations and render a duplicate placeholder beside live tool output.
          extra: {
            stream: {
              invocationId: turnExecution?.parentInvocationId ?? d.invocationId,
              turnInvocationId: d.invocationId,
            },
            ...(turnExecution ? { turnExecution: projectTurnExecutionMessage(turnExecution) } : {}),
          },
          ...(d.toolEvents ? { toolEvents: d.toolEvents } : {}),
          ...(d.thinking ? { thinking: d.thinking } : {}),
        });
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
