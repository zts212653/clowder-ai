/**
 * Callback API Routes — MCP 回传端点
 * 安全: 每个请求都需要 invocationId + callbackToken 验证。
 */

import type { CatId, RichBlock } from '@cat-cafe/shared';
import { catRegistry, createCatId, normalizeRichBlock } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { resolveFrontendBaseUrl } from '../config/frontend-origin.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import { getRichBlockBuffer } from '../domains/cats/services/agents/invocation/RichBlockBuffer.js';
import { parseA2AMentions } from '../domains/cats/services/agents/routing/a2a-mentions.js';
import { extractRichFromText } from '../domains/cats/services/agents/routing/rich-block-extract.js';
import { buildVoteNotification } from '../domains/cats/services/agents/routing/vote-intercept.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { DeliveryCursorStore } from '../domains/cats/services/stores/ports/DeliveryCursorStore.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import { hydrateReplyPreview, type IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { type ITaskStore, isSubjectOwnershipConflictError } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore, VotingStateV1 } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canViewMessage } from '../domains/cats/services/stores/visibility.js';
import { getVoiceBlockSynthesizer } from '../domains/cats/services/tts/VoiceBlockSynthesizer.js';
import type { IEvidenceStore, IMarkerQueue, IReflectionService } from '../domains/memory/interfaces.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { scoreKeywordRelevance, tokenizeKeyword } from '../utils/keyword-relevance.js';
import { getFeatureTagId } from './backlog-doc-import.js';
import { enqueueA2ATargets, triggerA2AInvocation } from './callback-a2a-trigger.js';
import { callbackAuthSchema } from './callback-auth-schema.js';
import { registerCallbackBootcampRoutes } from './callback-bootcamp-routes.js';
import { registerCallbackDocumentRoutes } from './callback-document-routes.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';
import { registerCallbackGameRoutes } from './callback-game-routes.js';
import { registerCallbackGuideRoutes } from './callback-guide-routes.js';
import { registerCallbackLimbRoutes } from './callback-limb-routes.js';
import { registerCallbackMemoryRoutes } from './callback-memory-routes.js';
import { getMultiMentionOrchestrator, registerMultiMentionRoutes } from './callback-multi-mention-routes.js';
import { registerCallbackTaskRoutes } from './callback-task-routes.js';
import { registerCallbackThreadCatsRoutes } from './callback-thread-cats-routes.js';
import { registerCallbackWorkflowSopRoutes } from './callback-workflow-sop-routes.js';
import { type FeatIndexEntry, readFeatIndexEntries } from './feat-index-doc-import.js';
import { detectUserMention } from './user-mention.js';
import { clearVoteTimer, closeVoteInternal, voteTimers } from './votes.js';

const log = createModuleLogger('routes/callbacks');

export interface CallbackRoutesOptions {
  registry: InvocationRegistry;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  /** F155 review fix: allow tests to inject a failing guide flow loader. */
  loadGuideFlow?: (guideId: string) => unknown;
  taskStore?: ITaskStore;
  backlogStore?: IBacklogStore;
  /** For thinking mode filtering in thread-context + thread-cats discovery */
  threadStore?: IThreadStore;
  /** F155 B-4: Independent guide session store */
  guideSessionStore?: import('../domains/guides/GuideSessionRepository.js').IGuideSessionStore;
  /** AgentRegistry for thread-cats MCP callback */
  agentRegistry?: { getAllEntries(): Map<string, unknown> };
  /** For post_message @mention → invocation triggering */
  router?: AgentRouter;
  invocationRecordStore?: IInvocationRecordStore;
  invocationTracker?: InvocationTracker;
  /** For mention ack cursor tracking (#77) */
  deliveryCursorStore?: DeliveryCursorStore;
  /** Phase D: validates GitHub repo exists before PR tracking registration */
  validateRepo?: (repoFullName: string) => Promise<boolean>;
  /** F043 P1: feat_index provider override for tests */
  featIndexProvider?: () => Promise<FeatIndexEntry[]>;
  /** F073 P1: workflow SOP store for bulletin board */
  workflowSopStore?: import('../domains/cats/services/stores/ports/WorkflowSopStore.js').IWorkflowSopStore;
  /** F102: DI memory services — SQLite-backed evidence store */
  evidenceStore: IEvidenceStore;
  markerQueue: IMarkerQueue;
  reflectionService: IReflectionService;
  /** Queue auto-dequeue on A2A invocation completion */
  queueProcessor?: {
    onInvocationComplete(threadId: string, catId: string, status: 'succeeded' | 'failed' | 'canceled'): Promise<void>;
    tryAutoExecute(threadId: string): Promise<void>;
    registerEntryCompleteHook(
      entryId: string,
      hook: (entryId: string, status: 'succeeded' | 'failed' | 'canceled', responseText: string) => void,
    ): void;
    unregisterEntryCompleteHook(entryId: string): void;
  };
  /** F122B: InvocationQueue for agent-sourced A2A entries */
  invocationQueue?: import('../domains/cats/services/agents/invocation/InvocationQueue.js').InvocationQueue;
  /** F126: Limb node registry for device/hardware capability management */
  limbRegistry?: import('../domains/limb/LimbRegistry.js').LimbRegistry;
  /** F126 Phase C: Limb pairing store for remote device approval */
  limbPairingStore?: import('../domains/limb/LimbPairingStore.js').LimbPairingStore;
  /** F088: Outbound delivery hook for connector-bound threads (late-bound after gateway bootstrap). */
  outboundHook?: {
    deliver(
      threadId: string,
      content: string,
      catId?: string,
      richBlocks?: RichBlock[],
      threadMeta?: { threadShortId: string; threadTitle?: string; deepLinkUrl?: string },
      origin?: 'callback' | 'agent' | 'system',
      triggerMessageId?: string,
    ): Promise<void>;
  };
}

const postMessageSchema = callbackAuthSchema.extend({
  content: z.string().min(1).max(50000),
  threadId: z.string().min(1).optional(),
  replyTo: z.string().optional(),
  clientMessageId: z.string().min(1).max(200).optional(),
  targetCats: z.array(z.string().min(1)).optional(),
});

const threadContextQuerySchema = callbackAuthSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  threadId: z.string().min(1).optional(), // F-Swarm-6: optional cross-thread read
  catId: z.string().min(1).optional(),
  keyword: z.string().min(1).optional(),
});

const listThreadsQuerySchema = callbackAuthSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  activeSince: z.coerce.number().int().min(0).optional(),
  keyword: z.string().trim().min(1).max(200).optional(),
});

const featIndexQuerySchema = callbackAuthSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  featId: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
});

const pendingMentionsQuerySchema = callbackAuthSchema.extend({
  // Accept both scalar and repeated query params (Fastify may surface string[]).
  includeAcked: z.union([z.string(), z.array(z.string())]).optional(),
});

const ackMentionsSchema = callbackAuthSchema.extend({
  upToMessageId: z.string().min(1),
});

/** F22: Rich block creation schema — validates shape + kind-specific fields (cloud Codex P1) */
const richChecklistItemSchema = z.object({ id: z.string(), text: z.string(), checked: z.boolean().optional() });
const richMediaItemSchema = z.object({ url: z.string(), alt: z.string().optional(), caption: z.string().optional() });
const richBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1),
    kind: z.literal('card'),
    v: z.literal(1),
    title: z.string(),
    bodyMarkdown: z.string().optional(),
    tone: z.enum(['info', 'success', 'warning', 'danger']).optional(),
    fields: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('diff'),
    v: z.literal(1),
    filePath: z.string(),
    diff: z.string(),
    languageHint: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('checklist'),
    v: z.literal(1),
    title: z.string().optional(),
    items: z.array(richChecklistItemSchema).min(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('media_gallery'),
    v: z.literal(1),
    title: z.string().optional(),
    items: z.array(richMediaItemSchema).min(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('audio'),
    v: z.literal(1),
    url: z.string().optional().default(''),
    text: z.string().optional(),
    title: z.string().optional(),
    durationSec: z.number().optional(),
    mimeType: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('interactive'),
    v: z.literal(1),
    interactiveType: z.enum(['select', 'multi-select', 'card-grid', 'confirm']),
    title: z.string().optional(),
    description: z.string().optional(),
    options: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          emoji: z.string().optional(),
          icon: z.string().optional(),
          description: z.string().optional(),
          level: z.number().optional(),
          group: z.string().optional(),
          customInput: z.boolean().optional(),
          customInputPlaceholder: z.string().optional(),
          action: z
            .object({
              type: z.literal('callback'),
              endpoint: z.string().min(1),
              payload: z.record(z.unknown()).optional(),
            })
            .optional(),
        }),
      )
      .min(1),
    maxSelect: z.number().int().min(1).optional(),
    allowRandom: z.boolean().optional(),
    messageTemplate: z.string().optional(),
    disabled: z.boolean().optional(),
    selectedIds: z.array(z.string()).optional(),
    groupId: z.string().min(1).optional(),
  }),
  // F088 Phase J: file attachment block
  z.object({
    id: z.string().min(1),
    kind: z.literal('file'),
    v: z.literal(1),
    url: z
      .string()
      .min(1)
      .refine(
        (u) => !u.includes('..') && (/^\/uploads\//.test(u) || /^\/api\//.test(u) || /^https:\/\//.test(u)),
        'file url must start with /uploads/, /api/, or https://',
      ),
    fileName: z.string().min(1),
    mimeType: z.string().optional(),
    fileSize: z.number().int().min(0).optional(),
  }),
  // F120 Phase C: html_widget — inline sandboxed HTML/JS visualization
  z.object({
    id: z.string().min(1),
    kind: z.literal('html_widget'),
    v: z.literal(1),
    html: z.string().min(1).max(500_000),
    title: z.string().optional(),
    height: z.number().int().min(50).max(2000).optional(),
  }),
]);
const createRichBlockSchema = callbackAuthSchema.extend({
  block: richBlockSchema,
});

function normalizeFeatId(value: string): string {
  return value.trim().toUpperCase();
}

async function buildThreadIdsByFeatId(
  threadStore: IThreadStore | undefined,
  backlogStore: IBacklogStore | undefined,
  userId: string,
  logger: { warn: (obj: unknown, msg?: string) => void },
): Promise<Map<string, string[]>> {
  const mapped = new Map<string, string[]>();
  if (!threadStore || !backlogStore) return mapped;

  try {
    const threads = await threadStore.list(userId);
    for (const thread of threads) {
      if (!thread.backlogItemId) continue;
      const backlogItem = await backlogStore.get(thread.backlogItemId, userId);
      if (!backlogItem) continue;
      const featureTagId = getFeatureTagId(backlogItem.tags);
      if (!featureTagId) continue;
      const featId = normalizeFeatId(featureTagId);
      if (featId.length === 0) continue;
      const existing = mapped.get(featId);
      if (!existing) {
        mapped.set(featId, [thread.id]);
        continue;
      }
      if (!existing.includes(thread.id)) existing.push(thread.id);
    }
  } catch (err) {
    logger.warn({ err, userId }, '[callbacks/feat-index] threadIds enrichment degraded');
  }

  return mapped;
}

export const callbacksRoutes: FastifyPluginAsync<CallbackRoutesOptions> = async (app, opts) => {
  const {
    registry,
    messageStore,
    socketManager,
    taskStore,
    backlogStore,
    threadStore,
    router,
    invocationRecordStore,
    invocationTracker,
    deliveryCursorStore,
    validateRepo,
    featIndexProvider,
    queueProcessor,
  } = opts;

  app.post('/api/callbacks/post-message', async (request, reply) => {
    const parsed = postMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const {
      invocationId,
      callbackToken,
      content,
      threadId,
      replyTo,
      clientMessageId,
      targetCats: explicitTargetCats,
    } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    // Stale callback guard (cloud Codex P1 + 缅因猫 R3): reject callbacks from
    // preempted invocations. A newer invocation for the same thread+cat supersedes.
    // Return 200 + stale_ignored to avoid retry storms from the dying CLI process.
    if (!registry.isLatest(invocationId)) {
      return { status: 'stale_ignored', replyTo, ...(clientMessageId ? { clientMessageId } : {}) };
    }

    let effectiveThreadId = record.threadId;
    if (threadId && threadId !== record.threadId) {
      // DIAG: Cross-thread routing debug (ghost-thread bug — opus session responding in wrong thread)
      app.log.info(
        {
          invocationId,
          catId: record.catId,
          recordThreadId: record.threadId,
          requestedThreadId: threadId,
        },
        '[DIAG/ghost-thread] post-message: cross-thread detected',
      );
      if (!threadStore) {
        reply.status(503);
        return { error: 'Thread store not configured for cross-thread posting' };
      }
      const targetThread = await threadStore.get(threadId);
      if (!targetThread || targetThread.createdBy !== record.userId) {
        reply.status(403);
        return { error: 'Thread access denied' };
      }
      effectiveThreadId = threadId;
    }

    // At-least-once de-duplication: retries with same clientMessageId are treated as duplicate.
    if (clientMessageId) {
      const isFirstSeen = registry.claimClientMessageId(invocationId, clientMessageId);
      if (!isFirstSeen) {
        return { status: 'duplicate', replyTo, clientMessageId };
      }
    }

    // #83: Extract cc_rich blocks from post_message content (Route B for callback path)
    const { cleanText: storedContent, blocks: extractedBlocks } = extractRichFromText(content);

    // F088-J hotfix: Consume any buffered rich blocks (e.g. file blocks from generate_document).
    // CLI agents don't go through route-serial, so the buffer must be consumed here.
    // For route-serial agents, the buffer is already consumed before post_message — this is a no-op.
    const bufferedBlocks = getRichBlockBuffer().consume(effectiveThreadId, record.catId as string, invocationId);

    // F34-b: Resolve voice blocks (audio with text, no url) before storing
    const synthesizer = getVoiceBlockSynthesizer();
    let richBlocks = [...extractedBlocks, ...bufferedBlocks];
    if (synthesizer && richBlocks.some((b) => b.kind === 'audio' && 'text' in b)) {
      try {
        richBlocks = await synthesizer.resolveVoiceBlocks(richBlocks, record.catId as string);
      } catch (err) {
        app.log.error({ err }, '[callbacks/post-message] Voice block synthesis failed');
      }
    }

    // F52: Detect cross-thread post (used for both A2A exemption and crossPost metadata)
    const isCrossThread = effectiveThreadId !== record.threadId;

    // Parse line-start @mentions (A2A rule: only line-start, strip code blocks, single target)
    // Uses parseA2AMentions instead of resolveTargetsAndIntent to avoid
    // participants/default-opus fallback triggering on non-@ messages (P1-1)
    // and inline @mentions triggering invocations (P1-2).
    // F52: Cross-thread posts skip self-reference filter so @codex can trigger target thread's codex
    const senderCatId = createCatId(record.catId);
    const contentTargets = parseA2AMentions(storedContent, isCrossThread ? undefined : senderCatId);
    // F098-C1: Merge explicit targetCats with content-parsed mentions (deduped)
    // Filter out invalid catIds (e.g. "default-user") — graceful degradation, not 400
    const validExplicitTargets: CatId[] = [];
    for (const id of explicitTargetCats ?? []) {
      if (catRegistry.has(id)) {
        validExplicitTargets.push(createCatId(id));
      } else {
        app.log.warn(
          { droppedId: id, catId: record.catId, invocationId },
          '[callbacks/post-message] Dropped invalid catId from targetCats',
        );
      }
    }
    const mergedTargets = new Set<CatId>([...contentTargets, ...validExplicitTargets]);
    if (contentTargets.length === 1 && mergedTargets.size > 1) {
      const [primaryTarget] = contentTargets;
      if (!primaryTarget) {
        app.log.warn(
          { invocationId, threadId: effectiveThreadId, senderCatId, contentTargets, validExplicitTargets },
          '[A2A/fail-closed] Unexpected empty primary target; skip fail-closed pruning',
        );
      } else {
        const droppedTargets = [...mergedTargets].filter((catId) => catId !== primaryTarget);
        mergedTargets.clear();
        mergedTargets.add(primaryTarget);
        app.log.warn(
          {
            invocationId,
            threadId: effectiveThreadId,
            senderCatId,
            contentTargets,
            validExplicitTargets,
            droppedTargets,
            retainedTarget: primaryTarget,
          },
          '[A2A/fail-closed] Single line-start mention detected; dropped extra merged targets',
        );
      }
    }
    const mentions: CatId[] = [...mergedTargets];
    if (contentTargets.length > 0 || validExplicitTargets.length > 0) {
      app.log.info(
        {
          invocationId,
          threadId: effectiveThreadId,
          senderCatId,
          contentTargets,
          validExplicitTargets,
          mergedTargets: mentions,
        },
        '[DIAG/a2a] post-message target merge',
      );
    }
    const mentionsUser = detectUserMention(storedContent);
    const crossPostExtra = isCrossThread
      ? { crossPost: { sourceThreadId: record.threadId, sourceInvocationId: invocationId } }
      : {};
    const richExtra = richBlocks.length > 0 ? { rich: { v: 1 as const, blocks: richBlocks } } : {};
    const targetCatsExtra = validExplicitTargets.length ? { targetCats: validExplicitTargets } : {};
    const extraParts = { ...richExtra, ...crossPostExtra, ...targetCatsExtra };
    const extra = Object.keys(extraParts).length > 0 ? extraParts : undefined;

    // F121: Validate replyTo — must exist in the same thread
    let validatedReplyTo: string | undefined;
    // F121 enhancement: Auto-fill replyTo for A2A-triggered invocations.
    // Priority: 1) explicit replyTo  2) a2aTriggerMessageId (worklist path)  3) InvocationRecordStore fallback
    let autoFilledReplyTo: string | undefined;
    if (!replyTo) {
      // Worklist path: a2aTriggerMessageId is set by route-serial from WorklistEntry
      if (record.a2aTriggerMessageId) {
        autoFilledReplyTo = record.a2aTriggerMessageId;
      } else if (record.parentInvocationId && invocationRecordStore) {
        // Fallback path (standalone invocation): look up InvocationRecordStore
        const parentRecord = (await invocationRecordStore.get(record.parentInvocationId)) as {
          userMessageId?: string | null;
          threadId?: string | null;
        } | null;
        // P3-2 hardening: only trust userMessageId if parentRecord's threadId matches
        if (parentRecord?.userMessageId && (!parentRecord.threadId || parentRecord.threadId === effectiveThreadId)) {
          autoFilledReplyTo = parentRecord.userMessageId;
        }
      }
    }
    const effectiveReplyTo = replyTo ?? autoFilledReplyTo;
    if (effectiveReplyTo) {
      const parentMsg = await messageStore.getById(effectiveReplyTo);
      if (parentMsg && parentMsg.threadId === effectiveThreadId) {
        validatedReplyTo = effectiveReplyTo;
      } else if (replyTo) {
        // Only warn for explicit replyTo failures — auto-fill mismatches are expected
        // (e.g. cross-thread A2A where trigger is in a different thread)
        app.log.warn(
          { replyTo, effectiveThreadId, parentThreadId: parentMsg?.threadId },
          '[callbacks/post-message] replyTo rejected: not found or wrong thread',
        );
      }
    }

    // Store the message (scoped to the effective thread)
    // AC-B6-P1: When A2A mentions will be enqueued (invocationQueue available),
    // store with deliveryStatus:'queued' so ContextAssembler excludes this message
    // from other invocations' context until QueueProcessor.executeEntry marks it delivered.
    const hasA2AMentions = mentions.length > 0 && router && invocationRecordStore && effectiveThreadId;
    const willEnqueueToQueue = hasA2AMentions && opts.invocationQueue;
    const storedMsg = await messageStore.append({
      userId: record.userId,
      catId: record.catId,
      content: storedContent,
      mentions,
      ...(mentionsUser ? { mentionsUser } : {}),
      origin: 'callback',
      timestamp: Date.now(),
      threadId: effectiveThreadId,
      ...(extra ? { extra } : {}),
      ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
      ...(willEnqueueToQueue ? { deliveryStatus: 'queued' as const } : {}),
    });

    // F121: Hydrate reply preview for broadcast
    const replyPreview = validatedReplyTo ? await hydrateReplyPreview(messageStore, validatedReplyTo) : undefined;

    socketManager.broadcastAgentMessage(
      {
        type: 'text',
        catId: record.catId,
        content: storedContent,
        origin: 'callback',
        messageId: storedMsg.id,
        invocationId, // #454: always propagate — required by callback auth
        // F52+F098-C1: Include crossPost + targetCats in real-time broadcast
        ...(isCrossThread || validExplicitTargets.length
          ? {
              extra: {
                ...(isCrossThread
                  ? { crossPost: { sourceThreadId: record.threadId, sourceInvocationId: invocationId } }
                  : {}),
                ...(validExplicitTargets.length ? { targetCats: validExplicitTargets } : {}),
              },
            }
          : {}),
        ...(mentionsUser ? { mentionsUser } : {}),
        ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
        ...(replyPreview ? { replyPreview } : {}),
        timestamp: Date.now(),
      },
      effectiveThreadId,
    );

    // #83: Broadcast each extracted rich block as SSE event for live rendering
    // P2 cloud-review: include messageId for frontend correlation
    // #454: include invocationId so frontend can exact-match callback to stream bubble
    for (const block of richBlocks) {
      socketManager.broadcastAgentMessage(
        {
          type: 'system_info' as const,
          catId: record.catId,
          content: JSON.stringify({ type: 'rich_block', block, messageId: storedMsg.id }),
          invocationId,
          timestamp: Date.now(),
        },
        effectiveThreadId,
      );
    }

    // F27: Enqueue @mentioned cats into parent worklist (unified A2A path)
    if (mentions.length > 0 && router && invocationRecordStore && effectiveThreadId) {
      const a2aResult = await enqueueA2ATargets(
        {
          router,
          invocationRecordStore,
          socketManager,
          ...(invocationTracker ? { invocationTracker } : {}),
          ...(deliveryCursorStore ? { deliveryCursorStore } : {}),
          ...(queueProcessor ? { queueProcessor } : {}),
          ...(opts.invocationQueue ? { invocationQueue: opts.invocationQueue } : {}),
          log: app.log,
        },
        {
          targetCats: mentions,
          content: storedContent,
          userId: record.userId,
          threadId: effectiveThreadId,
          triggerMessage: storedMsg,
          callerCatId: senderCatId,
          parentInvocationId: record.parentInvocationId,
        },
      );

      // AC-B6-P1: If message was stored as 'queued' but no targets were actually enqueued
      // (depth/dedup/full rejected all), recover by marking delivered to prevent ghost message.
      if (willEnqueueToQueue && a2aResult.enqueued.length === 0) {
        try {
          await messageStore.markDelivered?.(storedMsg.id, Date.now());
        } catch (err) {
          app.log.warn(
            { messageId: storedMsg.id, threadId: effectiveThreadId, err },
            '[AC-B6-P1] Failed to recover ghost message — markDelivered rejected (best-effort)',
          );
        }
      }
    }

    if (opts.outboundHook) {
      const frontendBase = resolveFrontendBaseUrl(process.env);
      const thread = await opts.threadStore?.get(effectiveThreadId);
      const threadMeta = {
        threadShortId: effectiveThreadId.slice(0, 15),
        threadTitle: thread?.title ?? undefined,
        deepLinkUrl: `${frontendBase}/threads/${effectiveThreadId}`,
      };
      opts.outboundHook
        .deliver(
          effectiveThreadId,
          storedContent,
          record.catId,
          richBlocks.length > 0 ? richBlocks : undefined,
          threadMeta,
          'callback',
          validatedReplyTo,
        )
        .catch((err: unknown) => {
          app.log.error({ err, threadId: effectiveThreadId }, '[callbacks/post-message] Outbound delivery failed');
        });
    }

    return {
      status: 'ok',
      threadId: effectiveThreadId,
      ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
    };
  });

  app.get('/api/callbacks/pending-mentions', async (request, reply) => {
    const parsed = pendingMentionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Missing invocationId or callbackToken' };
    }

    const { invocationId, callbackToken, includeAcked } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    const includeAckedValues = Array.isArray(includeAcked) ? includeAcked : includeAcked ? [includeAcked] : [];
    const shouldIncludeAcked = includeAckedValues.some((v) => v === '1' || v.toLowerCase() === 'true');

    // DIAG: ghost-thread bug — log which thread this invocation thinks it owns
    app.log.debug(
      {
        invocationId,
        catId: record.catId,
        threadId: record.threadId,
      },
      '[DIAG/ghost-thread] pending-mentions: polling',
    );

    // #77: Use mention ack cursor to filter already-processed mentions
    const catId = createCatId(record.catId);
    const lastAckId = deliveryCursorStore
      ? await deliveryCursorStore.getMentionAckCursor(record.userId, catId, record.threadId)
      : undefined;

    const rawMentions = shouldIncludeAcked
      ? await messageStore.getRecentMentionsFor(record.catId, 20, record.userId, record.threadId)
      : await messageStore.getMentionsFor(record.catId, 20, record.userId, record.threadId, lastAckId);
    // F35: Filter out whispers not intended for this cat
    const mentionViewer = { type: 'cat' as const, catId };
    const mentions = rawMentions.filter((m) => canViewMessage(m, mentionViewer));
    return {
      mentions: mentions.map((item) => ({
        id: item.id,
        from: item.catId ?? item.userId,
        message: item.content,
        timestamp: item.timestamp,
        ...(shouldIncludeAcked ? { acked: Boolean(lastAckId && item.id <= lastAckId) } : {}),
      })),
    };
  });

  // #77: POST /api/callbacks/ack-mentions — explicit ack with 4-way validation
  app.post('/api/callbacks/ack-mentions', async (request, reply) => {
    const parsed = ackMentionsSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { invocationId, callbackToken, upToMessageId } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    if (!deliveryCursorStore) {
      reply.status(501);
      return { error: 'Mention ack not available (no cursor store)' };
    }

    const catId = createCatId(record.catId);

    // Validation 1: existence
    const targetMsg = await messageStore.getById(upToMessageId);
    if (!targetMsg) {
      reply.status(400);
      return { error: 'upToMessageId does not exist' };
    }

    // Validation 2: ownership (userId + threadId + mentions catId)
    if (targetMsg.userId !== record.userId) {
      reply.status(400);
      return { error: 'upToMessageId does not belong to current user session' };
    }
    if (targetMsg.threadId !== record.threadId) {
      reply.status(400);
      return { error: 'upToMessageId does not belong to current thread' };
    }
    if (!targetMsg.mentions.includes(catId)) {
      reply.status(400);
      return { error: 'upToMessageId does not mention current cat' };
    }

    // Validation 3: monotonic (noop if backwards)
    const currentCursor = await deliveryCursorStore.getMentionAckCursor(record.userId, catId, record.threadId);
    if (currentCursor && upToMessageId <= currentCursor) {
      return { status: 'noop', reason: 'already acknowledged' };
    }

    // Validation 4: window — upToMessageId must be within current pending window
    const pendingWindow = await messageStore.getMentionsFor(
      record.catId,
      20,
      record.userId,
      record.threadId,
      currentCursor,
    );
    if (pendingWindow.length > 0) {
      const windowLastId = pendingWindow[pendingWindow.length - 1]?.id;
      if (upToMessageId > windowLastId) {
        reply.status(400);
        return {
          error: 'upToMessageId exceeds current pending window, ack only within fetched batch',
          windowLastId,
        };
      }
    }

    await deliveryCursorStore.ackMentionCursor(record.userId, catId, record.threadId, upToMessageId);
    return { status: 'ok', ackedUpTo: upToMessageId };
  });

  app.get('/api/callbacks/thread-context', async (request, reply) => {
    const parsed = threadContextQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Missing invocationId or callbackToken' };
    }

    const { invocationId, callbackToken, limit, threadId: overrideThreadId, catId: filterCatId, keyword } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    if (filterCatId && filterCatId !== 'user' && !catRegistry.has(filterCatId)) {
      reply.status(400);
      return { error: `Unknown catId filter: ${filterCatId}` };
    }

    // F-Swarm-6: allow reading a different thread's context
    const effectiveThreadId = overrideThreadId ?? record.threadId;
    // F148 Phase B (AC-B2): tokenize keyword for relevance scoring
    const keywordTerms = keyword ? tokenizeKeyword(keyword) : [];

    const requestedLimit = limit ?? 20;
    let needsPlayFilter = false;
    if (effectiveThreadId && threadStore) {
      const thread = await threadStore.get(effectiveThreadId);
      needsPlayFilter = !!thread && (thread.thinkingMode ?? 'debug') === 'play';
    }

    let filtered: Awaited<ReturnType<typeof messageStore.getByThread>>;

    // F35: Viewer for whisper filtering.
    // Debug mode: cats see everything (like 铲屎官) — full transparency for debugging.
    // Play mode: cats only see whispers addressed to them — game privacy.
    const viewer = needsPlayFilter
      ? { type: 'cat' as const, catId: createCatId(record.catId) }
      : { type: 'user' as const };
    const matchesExtraFilters = (item: Awaited<ReturnType<typeof messageStore.getByThread>>[number]): boolean => {
      // F148 Phase E (AC-E2): briefing messages are non-routing, never enter cat context
      if (item.origin === 'briefing') return false;
      if (filterCatId) {
        if (filterCatId === 'user') {
          if (item.catId !== null) return false;
        } else if (item.catId !== filterCatId) {
          return false;
        }
      }
      // F148 Phase B (AC-B2): tokenized keyword relevance (replaces substring .includes())
      if (keywordTerms.length > 0 && scoreKeywordRelevance(item.content, keywordTerms) === 0) {
        return false;
      }
      return true;
    };

    if (!needsPlayFilter) {
      // Normal mode: paginate backwards collecting visible messages until we
      // have enough or data is exhausted. This ensures whisper filtering
      // doesn't silently shrink the result set.
      const visible: Awaited<ReturnType<typeof messageStore.getByThread>> = [];
      const pageSize = Math.max(requestedLimit * 2, 50);
      let cursorTimestamp = Number.MAX_SAFE_INTEGER;
      let cursorId: string | undefined;

      while (visible.length < requestedLimit) {
        const batch = effectiveThreadId
          ? await messageStore.getByThreadBefore(effectiveThreadId, cursorTimestamp, pageSize, cursorId, record.userId)
          : await messageStore.getBefore(cursorTimestamp, pageSize, record.userId, cursorId);

        if (batch.length === 0) break;

        for (const item of batch) {
          if (!canViewMessage(item, viewer)) continue;
          if (!matchesExtraFilters(item)) continue;
          visible.push(item);
        }

        const oldest = batch[0]!;
        cursorTimestamp = oldest.timestamp;
        cursorId = oldest.id;
      }

      // F148 Phase B (AC-B2): sort by keyword relevance when searching, chronological otherwise
      if (keywordTerms.length > 0) {
        visible.sort((a, b) => {
          const sa = scoreKeywordRelevance(a.content, keywordTerms);
          const sb = scoreKeywordRelevance(b.content, keywordTerms);
          return sb - sa || b.timestamp - a.timestamp; // higher relevance first, then newest first
        });
        filtered = visible.slice(0, requestedLimit); // P1-1 fix: take HEAD (highest relevance)
      } else {
        visible.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
        filtered = visible.slice(-requestedLimit); // take TAIL (most recent)
      }
    } else {
      // Play mode: paginate backwards collecting visible messages until we have enough
      // or data is exhausted. No fixed page cap — correctness over latency.
      const visible: Awaited<ReturnType<typeof messageStore.getByThread>> = [];
      const pageSize = Math.max(requestedLimit * 2, 50); // fetch in chunks, min 50
      let cursorTimestamp = Number.MAX_SAFE_INTEGER;
      let cursorId: string | undefined;

      while (visible.length < requestedLimit) {
        const batch = effectiveThreadId
          ? await messageStore.getByThreadBefore(effectiveThreadId, cursorTimestamp, pageSize, cursorId, record.userId)
          : await messageStore.getBefore(cursorTimestamp, pageSize, record.userId, cursorId);

        if (batch.length === 0) break; // no more messages

        for (const item of batch) {
          // F35: Skip whispers not intended for this cat
          if (!canViewMessage(item, viewer)) continue;
          // Visible in play mode: user messages, own cat's messages,
          // or other cats' messages that are NOT explicitly stream.
          // Legacy messages (no origin) are treated as visible for backward
          // compatibility — all new writes are tagged, so untagged = legacy callback.
          const isOtherCat = item.catId && item.catId !== record.catId;
          if (!isOtherCat || item.origin !== 'stream') {
            if (!matchesExtraFilters(item)) continue;
            visible.push(item);
          }
        }

        // Move cursor to oldest message in batch (batch is ascending, first is oldest)
        const oldest = batch[0]!;
        cursorTimestamp = oldest.timestamp;
        cursorId = oldest.id;
      }

      // visible is accumulated in reverse-chronological page order but each page is ascending.
      // P2-1 fix: play mode also sorts by keyword relevance when keyword is active
      if (keywordTerms.length > 0) {
        visible.sort((a, b) => {
          const sa = scoreKeywordRelevance(a.content, keywordTerms);
          const sb = scoreKeywordRelevance(b.content, keywordTerms);
          return sb - sa || b.timestamp - a.timestamp;
        });
        filtered = visible.slice(0, requestedLimit);
      } else {
        visible.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
        filtered = visible.slice(-requestedLimit);
      }
    }

    // F073 P1: Look up workflow SOP for resume capsule if thread has linked backlog item
    // P1-3: Only expose workflowSop when the thread belongs to this user
    let workflowSop: Record<string, unknown> | undefined;
    if (effectiveThreadId && threadStore && opts.workflowSopStore) {
      const thread = await threadStore.get(effectiveThreadId);
      const isOwnThread = thread && (thread.createdBy === record.userId || !overrideThreadId);
      if (isOwnThread && thread?.backlogItemId) {
        const sop = await opts.workflowSopStore.get(thread.backlogItemId);
        if (sop) {
          workflowSop = {
            featureId: sop.featureId,
            stage: sop.stage,
            batonHolder: sop.batonHolder,
            nextSkill: sop.nextSkill,
            resumeCapsule: sop.resumeCapsule,
            checks: sop.checks,
          };
        }
      }
    }

    return {
      // TD091: echo threadId so cats know which thread they're in
      threadId: effectiveThreadId,
      messages: filtered.map((item) => ({
        id: item.id,
        userId: item.userId,
        catId: item.catId,
        content: item.content,
        ...(item.contentBlocks ? { contentBlocks: item.contentBlocks } : {}),
        timestamp: item.timestamp,
        // F148 Phase B (AC-B2): include relevance score when keyword search is active
        ...(keywordTerms.length > 0 ? { relevanceScore: scoreKeywordRelevance(item.content, keywordTerms) } : {}),
      })),
      ...(workflowSop ? { workflowSop } : {}),
    };
  });

  app.get('/api/callbacks/list-threads', async (request, reply) => {
    const parsed = listThreadsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request query', details: parsed.error.issues };
    }

    const { invocationId, callbackToken, limit, activeSince, keyword } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    if (!threadStore) {
      reply.status(503);
      return { error: 'Thread store not configured' };
    }

    const requestedLimit = limit ?? 20;
    let threads = await threadStore.list(record.userId);
    if (activeSince !== undefined) {
      threads = threads.filter((thread) => thread.lastActiveAt >= activeSince);
    }
    if (keyword) {
      const needle = keyword.toLowerCase();
      threads = threads.filter((thread) => {
        const title = (thread.title ?? '').toLowerCase();
        return title.includes(needle) || thread.id.toLowerCase().includes(needle);
      });
    }

    threads.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const summaries = threads.slice(0, requestedLimit).map((thread) => ({
      threadId: thread.id,
      ...(thread.title ? { title: thread.title } : {}),
      lastActiveAt: thread.lastActiveAt,
      pinned: thread.pinned ?? false,
      messageCount: null,
      participants: thread.participants,
    }));

    return { threads: summaries };
  });

  app.get('/api/callbacks/feat-index', async (request, reply) => {
    const parsed = featIndexQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request query', details: parsed.error.issues };
    }

    const { invocationId, callbackToken, featId, query, limit } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    const normalizedFeatId = featId ? normalizeFeatId(featId) : undefined;
    const normalizedQuery = query?.trim().toLowerCase();
    const threadIdsByFeatId = await buildThreadIdsByFeatId(threadStore, backlogStore, record.userId, app.log);

    let items = await (featIndexProvider ? featIndexProvider() : readFeatIndexEntries());
    if (normalizedFeatId) {
      items = items.filter((item) => normalizeFeatId(item.featId) === normalizedFeatId);
    }
    if (normalizedQuery) {
      items = items.filter((item) => {
        const haystack = `${item.featId} ${item.name} ${item.status}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      });
    }

    const requestedLimit = limit ?? 20;
    const sliced = items.slice(0, requestedLimit);
    return {
      items: sliced.map((item) => ({
        featId: item.featId,
        name: item.name,
        status: item.status,
        ...(item.keyDecisions ? { keyDecisions: item.keyDecisions } : {}),
        threadIds: threadIdsByFeatId.get(normalizeFeatId(item.featId)) ?? [],
      })),
    };
  });

  // TD091: PR tracking registration via MCP callback
  // Cats call this after `gh pr create` to register the PR for Layer 1 routing.
  // Server resolves threadId from invocation record — cat doesn't need to know it.
  const registerPrTrackingSchema = callbackAuthSchema.extend({
    repoFullName: z
      .string()
      .min(1)
      .regex(/^[^/]+\/[^/]+$/, 'Must be owner/repo format'),
    prNumber: z.number().int().positive(),
    catId: z.string().min(1).optional(), // ignored — server uses record.catId
  });

  app.post('/api/callbacks/register-pr-tracking', async (request, reply) => {
    // #320: Unified model — write to TaskStore instead of PrTrackingStore
    if (!taskStore) {
      reply.status(503);
      return { error: 'Task store not configured' };
    }

    const parsed = registerPrTrackingSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { invocationId, callbackToken, repoFullName, prNumber } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    // Use authoritative catId from invocation record, not caller payload.
    const catId = record.catId;

    // Phase D: validate repo exists and is accessible (AC-D1)
    if (validateRepo) {
      let repoOk: boolean;
      try {
        repoOk = await validateRepo(repoFullName);
      } catch {
        reply.status(503);
        return { error: 'Repository validation unavailable — try again later' };
      }
      if (!repoOk) {
        reply.status(422);
        return { error: `Repository ${repoFullName} does not exist or is not accessible` };
      }
    }

    const subjectKey = `pr:${repoFullName}#${prNumber}`;
    try {
      const task = await taskStore.upsertBySubject({
        kind: 'pr_tracking',
        subjectKey,
        threadId: record.threadId,
        title: `PR tracking: ${repoFullName}#${prNumber}`,
        ownerCatId: catId,
        why: `Tracking PR ${repoFullName}#${prNumber} for review feedback, CI/CD, and conflict detection`,
        createdBy: catId,
        userId: record.userId,
      });

      return { status: 'ok', threadId: record.threadId, task };
    } catch (error) {
      if (isSubjectOwnershipConflictError(error)) {
        reply.status(409);
        return { error: `PR ${repoFullName}#${prNumber} already registered by another user` };
      }
      throw error;
    }
  });

  // F22: Rich block creation via MCP callback
  app.post('/api/callbacks/create-rich-block', async (request, reply) => {
    // #85 M2b: normalize block before Zod parse (type→kind, auto v:1)
    const rawBody = request.body as Record<string, unknown>;
    if (rawBody && typeof rawBody === 'object' && rawBody.block) {
      normalizeRichBlock(rawBody.block);
    }

    const parsed = createRichBlockSchema.safeParse(rawBody);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { invocationId, callbackToken, block } = parsed.data;

    // F34-b P2: audio blocks must have at least url or text (R10: trim whitespace)
    if (block.kind === 'audio' && !block.url?.trim() && !block.text?.trim()) {
      reply.status(400);
      return { error: 'audio block requires url or text' };
    }

    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    if (!registry.isLatest(invocationId)) {
      return { status: 'stale_ignored' };
    }

    // F34-b: Resolve voice blocks (audio with text, no url) before buffering
    let resolvedBlock: RichBlock = block as unknown as RichBlock;
    const synthesizer = getVoiceBlockSynthesizer();
    if (synthesizer && block.kind === 'audio' && 'text' in block) {
      const resolved = await synthesizer.resolveVoiceBlocks([block as unknown as RichBlock], record.catId as string);
      if (resolved.length > 0) resolvedBlock = resolved[0]!;
    }

    // Buffer the block — consumed at append time in route-serial/route-parallel
    const isNew = getRichBlockBuffer().add(record.threadId, record.catId as string, resolvedBlock, invocationId);

    // Only broadcast new blocks (dedup retries at server to prevent frontend duplicates)
    // #454: include invocationId so frontend can exact-match callback to stream bubble
    if (isNew) {
      socketManager.broadcastAgentMessage(
        {
          type: 'system_info' as const,
          catId: record.catId,
          content: JSON.stringify({ type: 'rich_block', block: resolvedBlock }),
          invocationId,
          timestamp: Date.now(),
        },
        record.threadId,
      );
    }

    return { status: 'ok' };
  });

  // F079 Gap 4: Cat-initiated vote via MCP callback
  const startVoteCallbackSchema = callbackAuthSchema.extend({
    question: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(100)).min(2).max(20),
    anonymous: z.boolean().optional().default(false),
    timeoutSec: z.number().int().min(10).max(600).optional().default(120),
    voters: z.array(z.string().min(1).max(50)).min(1).max(20),
  });

  app.post('/api/callbacks/start-vote', async (request, reply) => {
    if (!threadStore) {
      reply.status(503);
      return { error: 'Thread store not configured' };
    }

    const parsed = startVoteCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { invocationId, callbackToken, question, options, anonymous, timeoutSec, voters } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    // P1-2 fix: stale invocation guard (parity with post-message, create-rich-block)
    if (!registry.isLatest(invocationId)) {
      return { status: 'stale_ignored' };
    }

    // P2 fix: verify thread exists
    const thread = await threadStore.get(record.threadId);
    if (!thread) {
      reply.status(404);
      return { error: '对话不存在', code: 'THREAD_NOT_FOUND' };
    }

    // Check for existing active vote
    const existing = await threadStore.getVotingState(record.threadId);
    if (existing && existing.status === 'active') {
      reply.status(409);
      return { error: '已有活跃投票', code: 'VOTE_ALREADY_ACTIVE' };
    }

    // P1-1 fix: createdBy must be userId (closeVoteInternal uses it as message userId).
    // initiatedByCat tracks which cat started the vote (for display purposes).
    const votingState: VotingStateV1 = {
      v: 1,
      question,
      options,
      votes: {},
      anonymous,
      deadline: Date.now() + timeoutSec * 1000,
      createdBy: record.userId,
      status: 'active',
      voters,
      initiatedByCat: record.catId as string,
    };

    await threadStore.updateVotingState(record.threadId, votingState);

    // Register timeout auto-close (shared timer map with votes.ts)
    clearVoteTimer(record.threadId);
    const timer = setTimeout(() => {
      closeVoteInternal(record.threadId, threadStore, socketManager, messageStore).catch((err) => {
        log.error({ threadId: record.threadId, err }, 'Timeout auto-close failed');
      });
    }, timeoutSec * 1000);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    voteTimers.set(record.threadId, timer);

    socketManager.broadcastToRoom(`thread:${record.threadId}`, 'vote_started', {
      threadId: record.threadId,
      votingState,
    });

    // Send notification message to each voter (so they see the vote request in chat)
    const notificationContent = buildVoteNotification(question, options);
    const mentionCatIds = voters.map((v) => createCatId(v));
    let notificationMsg: Awaited<ReturnType<typeof messageStore.append>> | undefined;
    try {
      notificationMsg = await messageStore.append({
        userId: record.userId,
        catId: record.catId,
        content: notificationContent,
        mentions: mentionCatIds,
        origin: 'callback',
        timestamp: Date.now(),
        threadId: record.threadId,
      });
    } catch (err) {
      log.warn({ err }, 'Failed to persist vote notification');
    }

    // Dispatch voter cats so they receive the notification and can vote.
    // Uses enqueueA2ATargets (standard A2A dispatch, NOT multi_mention depth guard).
    // If queue overflows (>MAX_QUEUE_DEPTH), falls back to direct dispatch for remaining voters.
    if (notificationMsg && router && invocationRecordStore) {
      const a2aDeps = {
        router,
        invocationRecordStore,
        socketManager,
        invocationTracker,
        deliveryCursorStore,
        queueProcessor,
        invocationQueue: opts.invocationQueue,
        log: app.log,
      };
      const a2aOpts = {
        targetCats: mentionCatIds,
        content: notificationContent,
        userId: record.userId,
        threadId: record.threadId,
        triggerMessage: notificationMsg,
        callerCatId: record.catId as CatId,
      };
      try {
        const { enqueued } = await enqueueA2ATargets(a2aDeps, a2aOpts);
        // Fallback: voters that hit queue capacity limit → direct dispatch
        const missed = mentionCatIds.filter((c) => !enqueued.includes(c));
        if (missed.length > 0) {
          app.log.info(
            { threadId: record.threadId, missed, enqueued },
            '[callbacks/start-vote] Queue overflow: falling back to direct dispatch for remaining voters',
          );
          await triggerA2AInvocation(a2aDeps, { ...a2aOpts, targetCats: missed });
        }
      } catch (err) {
        app.log.warn(`[callbacks/start-vote] Failed to dispatch voter invocations: ${String(err)}`);
      }
    }

    return { status: 'ok', threadId: record.threadId, votingState };
  });

  if (taskStore) {
    registerCallbackTaskRoutes(app, {
      registry,
      taskStore,
      socketManager,
      ...(threadStore ? { threadStore } : {}),
    });
  }

  if (opts.workflowSopStore && opts.backlogStore) {
    registerCallbackWorkflowSopRoutes(app, {
      registry,
      workflowSopStore: opts.workflowSopStore,
      backlogStore: opts.backlogStore,
    });
  }

  // F087: Bootcamp state transition callbacks
  if (opts.threadStore) {
    registerCallbackBootcampRoutes(app, { registry, threadStore: opts.threadStore });
  }

  // Thread cats discovery for MCP
  if (opts.threadStore && opts.agentRegistry) {
    registerCallbackThreadCatsRoutes(app, {
      registry,
      threadStore: opts.threadStore,
      agentRegistry: opts.agentRegistry,
    });
  }

  await registerCallbackMemoryRoutes(app, {
    registry,
    evidenceStore: opts.evidenceStore,
    markerQueue: opts.markerQueue,
    reflectionService: opts.reflectionService,
  });

  // F126: Limb node callback routes
  if (opts.limbRegistry) {
    registerCallbackLimbRoutes(app, {
      limbRegistry: opts.limbRegistry,
      invocationRegistry: registry,
      pairingStore: opts.limbPairingStore,
    });
  }

  // F086: Multi-mention orchestration routes
  if (router && invocationRecordStore) {
    registerMultiMentionRoutes(app, {
      registry,
      messageStore,
      socketManager,
      router,
      invocationRecordStore,
      ...(invocationTracker ? { invocationTracker } : {}),
      ...(opts.invocationQueue ? { invocationQueue: opts.invocationQueue } : {}),
      ...(queueProcessor ? { queueProcessor } : {}),
    });
    // Wire orchestrator into SocketManager for cancel propagation (P1-1 fix)
    if (typeof socketManager.setMultiMentionOrchestrator === 'function') {
      socketManager.setMultiMentionOrchestrator(getMultiMentionOrchestrator());
    }
  }

  // F088 Phase J2: Document generation callback routes
  registerCallbackDocumentRoutes(app, { registry, socketManager });

  // F101: Game action callback for non-Claude cats (OpenCode/Codex/Gemini)
  registerCallbackGameRoutes(app, { registry });

  // F155: Guide engine — state-validated routes with ThreadStore authority
  if (opts.threadStore) {
    await registerCallbackGuideRoutes(app, {
      registry,
      threadStore: opts.threadStore,
      socketManager,
      ...(opts.guideSessionStore ? { guideSessionStore: opts.guideSessionStore } : {}),
      ...(opts.loadGuideFlow ? { loadGuideFlow: opts.loadGuideFlow } : {}),
    });
  }
};
