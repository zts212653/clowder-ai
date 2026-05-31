/**
 * Invocations API Routes
 * GET  /api/invocations/:id       — 查询 InvocationRecord 状态
 * POST /api/invocations/:id/retry — 重试 failed/queued invocation
 *
 * ADR-008 S1: InvocationRecord 查询 + 重试端点桩
 * ADR-008 S2: retry 端点接通实际执行
 */

import type { FastifyPluginAsync } from 'fastify';
import { getDefaultCatId } from '../config/cat-config-loader.js';
import { createModuleLogger } from '../infrastructure/logger.js';

const log = createModuleLogger('routes/invocations');

import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import { stampVisibleTurn } from '../domains/cats/services/agents/invocation/visible-turn.js';
import type { AgentRouter } from '../domains/cats/services/agents/routing/AgentRouter.js';
import type { PersistenceContext } from '../domains/cats/services/agents/routing/route-helpers.js';
import { parseIntent } from '../domains/cats/services/context/IntentParser.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';

export interface InvocationsRoutesOptions {
  invocationRecordStore: IInvocationRecordStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  router: AgentRouter;
  invocationTracker: InvocationTracker;
  uploadDir?: string;
  /** F39: Queue processor for auto-dequeue on retry complete */
  queueProcessor?: QueueProcessor;
}

export const invocationsRoutes: FastifyPluginAsync<InvocationsRoutesOptions> = async (app, opts) => {
  const uploadDir = getDefaultUploadDir(opts.uploadDir ?? process.env.UPLOAD_DIR);

  // GET /api/invocations/:id — query InvocationRecord state
  app.get<{ Params: { id: string } }>('/api/invocations/:id', async (request, reply) => {
    const { id } = request.params;
    const record = await opts.invocationRecordStore.get(id);

    if (!record) {
      reply.status(404);
      return { error: 'Invocation not found', code: 'INVOCATION_NOT_FOUND' };
    }

    return {
      id: record.id,
      threadId: record.threadId,
      userId: record.userId,
      userMessageId: record.userMessageId,
      targetCats: record.targetCats,
      intent: record.intent,
      status: record.status,
      ...(record.error ? { error: record.error } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  });

  // POST /api/invocations/:id/retry — retry failed/queued invocation (ADR-008 S2)
  app.post<{ Params: { id: string } }>('/api/invocations/:id/retry', async (request, reply) => {
    const { id } = request.params;
    const record = await opts.invocationRecordStore.get(id);

    // ① Not found
    if (!record) {
      reply.status(404);
      return { error: 'Invocation not found', code: 'INVOCATION_NOT_FOUND' };
    }

    // Snapshot status before any await yields (in-memory get() returns a live reference)
    const snapshotStatus = record.status;

    // ② Only failed and queued are retryable
    if (snapshotStatus !== 'failed' && snapshotStatus !== 'queued') {
      reply.status(409);
      return {
        error: `Cannot retry invocation with status '${snapshotStatus}'`,
        code: 'INVOCATION_NOT_RETRYABLE',
        currentStatus: snapshotStatus,
      };
    }

    // ③ Need the original user message to re-execute
    if (record.userMessageId === null) {
      reply.status(400);
      return {
        error: '原始消息未保存，请重新发送',
        code: 'USER_MESSAGE_NOT_SAVED',
      };
    }

    const storedMessage = await opts.messageStore.getById(record.userMessageId);
    if (!storedMessage) {
      reply.status(400);
      return {
        error: '原始消息已过期或被删除，请重新发送',
        code: 'USER_MESSAGE_EXPIRED',
      };
    }

    // ④ Rebuild intent from stored content + targetCats
    const intent = parseIntent(storedMessage.content, record.targetCats.length);

    // ⑤ Delete guard check
    if (opts.invocationTracker.isDeleting(record.threadId)) {
      reply.status(409);
      return {
        error: '对话正在删除中',
        detail: '请稍后重试，或新建一个对话继续',
        code: 'THREAD_DELETING',
      };
    }

    // ⑥ Start invocation tracking for ALL target cats (multi-cat F5 recovery)
    const primaryCat = record.targetCats[0] ?? 'unknown';
    const controller = opts.invocationTracker.startAll(record.threadId, record.targetCats, record.userId);
    if (controller.signal.aborted) {
      await opts.invocationRecordStore.update(id, { status: 'canceled' });
      reply.status(409);
      return {
        error: '对话正在删除中',
        detail: '请稍后重试，或新建一个对话继续',
        code: 'THREAD_DELETING',
      };
    }

    // ⑦ Claim retry: CAS transition to running BEFORE reply (prevents concurrent retry)
    // expectedStatus ensures only one concurrent request wins; loser gets null → 409
    // Also clears stale error from previous failure (P2 fix)
    const claimed = await opts.invocationRecordStore.update(id, {
      status: 'running',
      error: '',
      expectedStatus: snapshotStatus,
    });
    if (!claimed) {
      opts.invocationTracker.completeAll(record.threadId, record.targetCats, controller);
      reply.status(409);
      return {
        error: `Cannot retry invocation with status '${snapshotStatus}'`,
        code: 'INVOCATION_NOT_RETRYABLE',
        currentStatus: snapshotStatus,
      };
    }

    // ⑧ Reply 202 immediately
    reply.status(202);
    reply.send({
      status: 'retrying',
      invocationId: id,
    });

    // ⑨ Background: routeExecution() → succeeded/failed
    void (async () => {
      const HEARTBEAT_INTERVAL_MS = 30_000;
      const heartbeatInterval = setInterval(() => {
        opts.socketManager.broadcastToRoom(`thread:${record.threadId}`, 'heartbeat', {
          threadId: record.threadId,
          timestamp: Date.now(),
        });
      }, HEARTBEAT_INTERVAL_MS);

      // F39: Track final status for queue auto-dequeue
      let finalStatus: 'succeeded' | 'failed' | 'canceled' = 'failed';

      try {
        opts.socketManager.broadcastToRoom(`thread:${record.threadId}`, 'intent_mode', {
          threadId: record.threadId,
          mode: intent.intent,
          targetCats: record.targetCats,
        });

        // ADR-008 S3: collect cursor boundaries; ack only after succeeded
        const cursorBoundaries = new Map<string, string>();
        // P1-2: track persistence failures across generator boundary
        const persistenceContext: PersistenceContext = { failed: false, errors: [] };
        // F070: track governance block errorCode (mirror messages.ts)
        let governanceErrorCode: string | undefined;

        for await (const msg of opts.router.routeExecution(
          record.userId,
          storedMessage.content,
          record.threadId,
          storedMessage.id,
          record.targetCats,
          intent,
          {
            ...(storedMessage.contentBlocks ? { contentBlocks: storedMessage.contentBlocks } : {}),
            uploadDir,
            signal: controller.signal,
            // F-parallel-cancel (cloud #7): the retry endpoint is a startAll caller too. After the
            // batchController split, controller.signal is the INDEPENDENT batch gate — a single-cat
            // cancel aborts only that cat's slot controller, not the batch gate. Pass signalForCat so
            // the route observes the per-cat signal and a Stop on one cat of a retried multi-cat
            // invocation is honored immediately (not ignored until cancel-all). Mirrors messages.ts /
            // QueueProcessor.
            signalForCat: (catId: string) => opts.invocationTracker.getController?.(record.threadId, catId)?.signal,
            ...(opts.queueProcessor
              ? {
                  queueHasQueuedMessages: (tid: string) =>
                    opts.queueProcessor?.hasQueuedNonAgentForThread(tid) ?? false,
                  hasQueuedOrActiveAgentForCat: (tid: string, catId: string) =>
                    opts.queueProcessor?.hasActiveOrQueuedAgentForCat(tid, catId) ?? false,
                  deferA2AEnqueue: (e: any) => opts.queueProcessor?.enqueueRaw(e),
                }
              : {}),
            cursorBoundaries,
            persistenceContext,
            parentInvocationId: id,
          },
        )) {
          if (msg.type === 'done' && msg.errorCode) {
            governanceErrorCode = msg.errorCode;
          }
          if ((msg.type === 'done' || msg.type === 'error') && msg.catId) {
            opts.invocationTracker.completeSlot(record.threadId, msg.catId, controller);
          }
          // F194 Phase Z9 (砚砚 R1 P1-2): use stampVisibleTurn helper. After route-serial /
          // route-parallel stamp ownInvocationId on yielded events (R1 P1-1), msg.invocationId
          // is always defined for assistant turns; helper falls back to parent only as defense
          // in depth for non-assistant or pre-system_info events.
          opts.socketManager.broadcastAgentMessage(
            { ...msg, ...stampVisibleTurn(id, msg.invocationId) },
            record.threadId,
          );
        }

        // P1-2: mark failed if any message persistence failed
        if (persistenceContext.failed) {
          const errorDetail = persistenceContext.errors.map((e) => `${e.catId}: ${e.error}`).join('; ');
          await opts.invocationRecordStore.update(id, {
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
            record.threadId,
          );
        } else if (governanceErrorCode) {
          await opts.invocationRecordStore.update(id, {
            status: 'failed',
            error: governanceErrorCode,
          });
        } else {
          // F-parallel-cancel (cloud #7): AGGREGATE finalStatus — a single-cat cancel no longer
          // aborts the batch gate, so raw controller.signal.aborted only covers whole-invocation
          // abort. Resolve canceled-by-user from per-cat slot tombstones (completeAll runs in the
          // finally below, AFTER this, so tombstones are still visible). Mirrors QueueProcessor.
          const batchReason = controller.signal.reason;
          const aggStatus = opts.invocationTracker.resolveFinalStatus
            ? opts.invocationTracker.resolveFinalStatus(record.threadId, record.targetCats, {
                aborted: controller.signal.aborted,
                reason: batchReason as string | undefined,
              })
            : controller.signal.aborted
              ? 'canceled'
              : 'succeeded';
          if (aggStatus === 'canceled_by_user' || aggStatus === 'canceled') {
            await opts.invocationRecordStore.update(id, { status: 'canceled' });
            finalStatus = 'canceled';
          } else {
            // ADR-008 S3: ack cursors before marking succeeded so that if ack
            // throws, the catch block sees running→failed (valid transition).
            await opts.router.ackCollectedCursors(record.userId, record.threadId, cursorBoundaries);
            await opts.invocationRecordStore.update(id, { status: 'succeeded' });
            finalStatus = 'succeeded';
          }
        }
      } catch (err) {
        log.error({ err }, 'Retry execution error');
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await opts.invocationRecordStore.update(id, {
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
          record.threadId,
        );
      } finally {
        clearInterval(heartbeatInterval);
        opts.invocationTracker.completeAll(record.threadId, record.targetCats, controller);
        // F39: Notify queue processor for auto-dequeue chain
        opts.queueProcessor?.onInvocationComplete(record.threadId, primaryCat, finalStatus).catch(() => {
          /* best-effort */
        });
      }
    })();
  });
};
