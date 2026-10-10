/** Exact message drill facet; canonical QueueProcessor owns adoption, not this read surface. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import { extractImagePaths, extractImageUrls } from '../domains/cats/services/agents/providers/image-paths.js';
import { getMessageSpeakerName } from '../domains/cats/services/context/ContextAssembler.js';
import { readDurableLocalReviewFact } from '../domains/cats/services/local-review-artifact.js';
import { messageFrom } from '../domains/cats/services/stores/message-from.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type {
  ITurnExecutionStore,
  TurnExecutionRecord,
} from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import {
  canViewMessage,
  getTimelineOrderTime,
  isAgentReadableManagedHoldMessage,
  isInternalNonQuotableParent,
  isSystemUserMessage,
  isTimelinePublished,
  type Viewer,
} from '../domains/cats/services/stores/visibility.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';
import { recordAnchorDrillEvent, recordAnchorPreviewEvent } from './anchor-event-log.js';
import { recordAnchorFullDrill } from './anchor-telemetry.js';
import { truncateHead } from './callback-anchor-helpers.js';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';
import { guardLiveCarrierRead } from './live-carrier-read-guard.js';

export interface CallbackMessageReadDeps {
  messageStore: IMessageStore;
  threadStore?: Pick<IThreadStore, 'get'>;
  invocationQueue?: InvocationQueue;
  queueProcessor?: Partial<Pick<QueueProcessor, 'adoptExposedQueuedEntries'>>;
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
  withLiveCarrierOperation?: <T>(
    query: { invocationId: string; catId: string; threadId: string },
    operation: () => Promise<T>,
  ) => Promise<T>;
}
export function registerCallbackMessageReadRoutes(app: FastifyInstance, opts: CallbackMessageReadDeps): void {
  const { messageStore, threadStore, queueProcessor } = opts;
  // #699: Look up a single message by ID with optional surrounding context
  const getMessageQuerySchema = z.object({
    messageId: z.string().min(1),
    contextCount: z.coerce.number().int().min(0).max(10).optional(),
    // F236 AC-B1: drill terminal is bounded — default preview, mode=full returns complete content.
    mode: z.enum(['preview', 'full']).optional(),
  });

  app.get(
    '/api/callbacks/get-message',
    guardLiveCarrierRead(opts, async (request, reply) => {
      const principal = requireCallbackPrincipal(request, reply);
      if (!principal) return;

      const parsed = getMessageQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid query parameters', details: parsed.error.issues };
      }

      const { messageId, contextCount } = parsed.data;
      const isFullDrill = (parsed.data.mode ?? 'preview') === 'full';
      const message = await messageStore.getById(messageId);
      if (!message || message.deletedAt) {
        reply.status(404);
        return { error: 'Message not found' };
      }

      // #699 P1 (gpt52 intake review): align get-message with isEligibleReplyParent —
      // system/briefing are internal, non-routable content, never retrievable here (no info leak).
      const isReadableManagedHold = isAgentReadableManagedHoldMessage(message) && message.userId === principal.userId;
      if (isInternalNonQuotableParent(message) && !isReadableManagedHold) {
        reply.status(404);
        return { error: 'Message not found' };
      }

      // #699 P1-1: Enforce owner scope before consulting this invocation's pending targets.
      if (message.userId !== principal.userId && !isSystemUserMessage(message)) {
        reply.status(404);
        return { error: 'Message not found' };
      }
      const expectedParentInvocationId =
        principal.kind === 'invocation' ? (principal.parentInvocationId ?? principal.invocationId) : undefined;
      const queuedDrillEntry =
        isFullDrill && principal.kind === 'invocation' && message.threadId === principal.threadId
          ? opts.invocationQueue
              ?.getQueuedBodyMessagesForCat(
                principal.threadId,
                principal.userId,
                principal.catId,
                expectedParentInvocationId,
              )
              .find((entry) => entry.messageId === message.id)
          : undefined;
      // An unpublished ordinary target is readable only after the exact child
      // adoption below commits. Preview, other threads and typed owners stay hidden.
      if (!isReadableManagedHold && !isTimelinePublished(message) && !queuedDrillEntry) {
        reply.status(404);
        return { error: 'Message not found' };
      }
      // Align with thread-context: debug = cats see all (user viewer), play = cats see own (cat viewer)
      let needsPlayFilter = false;
      if (message.threadId && threadStore) {
        const thread = await threadStore.get(message.threadId);
        needsPlayFilter = !!thread && (thread.thinkingMode ?? 'debug') === 'play';
      }
      const viewer: Viewer = needsPlayFilter ? { type: 'cat', catId: principal.catId } : { type: 'user' };
      if (!isReadableManagedHold && !canViewMessage(message, viewer)) {
        reply.status(404);
        return { error: 'Message not found' };
      }
      // A preview is not delivery evidence. Only this exact requested full body may
      // claim an ordinary pending target; typed wait/action/domain owners stay out.
      if (queuedDrillEntry && principal.kind === 'invocation') {
        if (!opts.turnExecutionStore || !queueProcessor?.adoptExposedQueuedEntries) {
          reply.status(503);
          return { error: 'Queued body drill unavailable', code: 'QUEUED_BODY_DRILL_UNAVAILABLE' };
        }
        let child: TurnExecutionRecord | null;
        try {
          child = await opts.turnExecutionStore.get(principal.invocationId);
        } catch (err) {
          app.log.error({ err, invocationId: principal.invocationId }, '[F236] exact drill execution unavailable');
          reply.status(503);
          return { error: 'Turn execution ledger unavailable', code: 'TURN_EXECUTION_LEDGER_UNAVAILABLE' };
        }
        if (
          !child ||
          child.invocationId !== principal.invocationId ||
          child.status !== 'running' ||
          child.parentInvocationId !== expectedParentInvocationId ||
          child.threadId !== principal.threadId ||
          child.userId !== principal.userId ||
          child.catId !== principal.catId
        ) {
          reply.status(409);
          return { error: 'Turn execution scope mismatch', code: 'TURN_EXECUTION_SCOPE_MISMATCH' };
        }
        const adoption = await queueProcessor
          .adoptExposedQueuedEntries({
            threadId: principal.threadId,
            userId: principal.userId,
            catId: principal.catId,
            invocationId: principal.invocationId,
            entries: [{ entryId: queuedDrillEntry.entryId, messageId: message.id }],
            seenAt: Date.now(),
          })
          .catch((err) => {
            app.log.error({ err, messageId: message.id }, '[F236] queued full drill adoption failed');
            return { outcome: 'rejected', reason: 'persistence_unavailable' } as const;
          });
        if (adoption.outcome !== 'adopted') {
          reply.status(adoption.reason === 'persistence_unavailable' ? 503 : 409);
          return { error: 'Queued body drill unavailable', code: 'QUEUED_BODY_DRILL_UNAVAILABLE' };
        }
      }
      const uploadDir = getDefaultUploadDir(process.env.UPLOAD_DIR);
      // F236 AC-B1: bounded drill terminal. Default preview truncates content (keeps the `content`
      // field name for consumer continuity + adds contentLength/truncated); mode=full returns the
      // complete content + contentBlocks. Image hints stay in both modes.
      const projectMsg = (m: typeof message) => {
        const localReviewFact = readDurableLocalReviewFact(m);
        const imagePaths = extractImagePaths(m.contentBlocks, uploadDir);
        const imageUrls = extractImageUrls(m.contentBlocks);
        const { preview, truncated } = isFullDrill ? { preview: m.content, truncated: false } : truncateHead(m.content);
        return {
          id: m.id,
          userId: m.userId,
          catId: m.catId,
          content: preview,
          contentLength: m.content.length,
          truncated,
          ...(localReviewFact ? { localReviewFact } : {}),
          // F236 R1 / 云端 Codex P2: preview-mode truncation carries a one-hop drill pointer to the
          // full content (consistent with thread-context/pending anchors — caller never left guessing).
          ...(truncated
            ? {
                drillDown: {
                  tool: 'cat_cafe_get_message',
                  args: {
                    messageId: m.id,
                    mode: 'full',
                    // F236 R1 云端 P2: agent-key caller needs agentKeyCatId in drill pointer for one-hop verbatim
                    ...(principal.kind === 'agent_key' ? { agentKeyCatId: principal.catId } : {}),
                  },
                },
              }
            : {}),
          ...(isFullDrill && m.contentBlocks ? { contentBlocks: m.contentBlocks } : {}),
          ...(imagePaths.length > 0 ? { imagePaths } : {}),
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
          ...(m.replyTo ? { replyTo: m.replyTo } : {}),
          speaker: getMessageSpeakerName(m),
          from: messageFrom(m),
          timestamp: m.timestamp,
          threadId: m.threadId,
        };
      };

      const result: {
        message: ReturnType<typeof projectMsg>;
        context?: ReturnType<typeof projectMsg>[];
      } = {
        message: projectMsg(message),
      };

      const effectiveContextCount = contextCount ?? 0;
      if (effectiveContextCount > 0 && message.threadId) {
        const principalUserId = principal.userId;
        const exposureAwareThreadRead = {
          includeQueuedCatMessages: true,
        } as const;
        const before = await messageStore.getByThreadBefore(
          message.threadId,
          getTimelineOrderTime(message),
          effectiveContextCount,
          message.id,
          principalUserId,
          exposureAwareThreadRead,
        );
        const after = await messageStore.getByThreadAfter(
          message.threadId,
          message.id,
          effectiveContextCount,
          principalUserId,
          exposureAwareThreadRead,
        );
        // #699 P1-1b: Apply same visibility predicate to context items as target
        const contextMsgs = [...before, ...after]
          .filter((m) => {
            if (m.id === messageId) return false;
            if (m.deletedAt) return false;
            // #699 P1 (gpt52 intake review): exclude internal/non-routable (system/briefing) from context too
            const isReadableManagedHoldNeighbor = isAgentReadableManagedHoldMessage(m) && m.userId === principalUserId;
            if (isInternalNonQuotableParent(m) && !isReadableManagedHoldNeighbor) return false;
            if (!isReadableManagedHoldNeighbor && !isTimelinePublished(m)) return false;
            if (m.userId !== principalUserId && !isSystemUserMessage(m)) return false;
            if (!isReadableManagedHoldNeighbor && !canViewMessage(m, viewer)) return false;
            return true;
          })
          .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
        result.context = contextMsgs.map(projectMsg);
      }

      const contextMessages = Array.isArray(result.context) ? result.context : [];

      // F236 AC-B2 (R1/砚砚 P1): record full-drill cost AFTER the whole payload (message +
      // context neighbors + contentBlocks) is assembled, so the cost account isn't undercounted.
      if (isFullDrill) {
        const fullDrillChars = JSON.stringify(result).length;
        app.log.info(
          {
            messageId: message.id,
            fullDrillChars,
            contextCount: result.context?.length ?? 0,
            catId: principal.catId,
          },
          '[F236] get_message full drill',
        );
        // F236 Track-1: also emit as OTel metrics (chars + request/response volume substrate).
        recordAnchorFullDrill({ tool: 'get-message', fullDrillChars });
        // F236 Track-2: per-event drill record with correlation key for drill↔preview join.
        recordAnchorDrillEvent({ tool: 'get-message', itemId: message.id, fullDrillChars });
        recordAnchorPreviewEvent({
          tool: 'get-message',
          itemIds: [message.id, ...contextMessages.map((m) => m.id)],
          returnedChars: result.message.content.length + contextMessages.reduce((sum, m) => sum + m.content.length, 0),
          originalChars: message.content.length + contextMessages.reduce((sum, m) => sum + m.contentLength, 0),
          modeResolved: 'full',
          modeSource: 'legacy_equivalent',
          catId: principal.catId,
        });
      } else {
        recordAnchorPreviewEvent({
          tool: 'get-message',
          itemIds: [message.id, ...contextMessages.map((m) => m.id)],
          returnedChars: result.message.content.length + contextMessages.reduce((sum, m) => sum + m.content.length, 0),
          originalChars: message.content.length + contextMessages.reduce((sum, m) => sum + m.contentLength, 0),
          modeResolved: 'anchor',
          modeSource: 'legacy_equivalent',
          catId: principal.catId,
        });
      }

      // F254: seenCursor is NOT pushed on targeted get-message reads.
      // A targeted read of a single message (by ID) does not mean the cat has seen
      // all messages up to that point. Advancing the monotonic cursor here would mark
      // skipped messages as "seen" (gpt52 P1-2 sparse-read invariant).
      // seenCursor only advances on contiguous thread-context reads (no keyword/window).

      return result;
    }),
  );
}
