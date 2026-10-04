import { randomUUID } from 'node:crypto';
import { catRegistry, createCompanionIdentitySnapshot } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isCatAvailable } from '../config/cat-config-loader.js';
import type { InvocationQueue, QueueEntry } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IConciergeConfigStore } from '../domains/concierge/ConciergeConfigStore.js';
import type { ConciergeThreadService } from '../domains/concierge/ConciergeThreadService.js';
import type { OwnerPageActionService } from '../domains/concierge/live/host/owner-page-action-service.js';
import { MessageLiveInboxSource } from '../domains/concierge/live/inbox/MessageLiveInboxSource.js';
import {
  LiveCallAlreadyActiveError,
  type LiveCompanionSessions,
} from '../domains/concierge/live/LiveCompanionSessions.js';
import {
  LiveCompanionSelectionError,
  resolveLiveCompanionSelection,
  sameLiveExecutionSelection,
} from '../domains/concierge/live/live-companion-selection.js';
import { readLiveConversationContext } from '../domains/concierge/live/live-conversation-context.js';
import type { LiveRecoveryOptions } from '../domains/concierge/live/recovery/live-recovery-contract.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { registerLiveTranscriptRoutes } from './concierge-live-transcript.js';
import { requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

interface Options {
  ownerUserId: string;
  configStore: Pick<IConciergeConfigStore, 'get'> & Partial<Pick<IConciergeConfigStore, 'getSaved'>>;
  sessions: LiveCompanionSessions;
  threadService: Pick<ConciergeThreadService, 'getOrCreate' | 'isCurrent'>;
  sessionChainStore: Pick<ISessionChainStore, 'getActive'>;
  messageStore: Pick<IMessageStore, 'appendIdempotent' | 'getByThread' | 'getByThreadAfter' | 'getById'>;
  invocationQueue: Pick<InvocationQueue, 'getQueuedBodyMessagesForCat' | 'getEntrySnapshot'>;
  recovery: Pick<LiveRecoveryOptions, 'tasks' | 'approvals' | 'epochs'>;
  progressOwnedCarrier(entry: QueueEntry, catId: string): Promise<unknown>;
  mcpDistDir: string;
  desktopRoot?: string;
  allowedDirectories: readonly string[];
  publish(message: StoredMessage): void;
  pageActionOwner?: OwnerPageActionService;
}
const prepareSchema = z
  .object({
    allowHomeReads: z.boolean(),
    expectedDutyCatProfileId: z.string().min(1).max(160).optional(),
  })
  .strict();
const startSchema = z.object({ offer: z.string().min(1).max(128_000) }).strict();
const textSchema = z.object({ text: z.string().trim().min(1).max(8000), clientMessageId: z.string().uuid() }).strict();
const selectionId = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const screenSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open'), selectionId, label: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('close') }).strict(),
  z
    .object({
      kind: z.literal('frame'),
      selectionId,
      frame: z
        .object({
          image: z.string().max(1_400_000),
          width: z.number().int().min(1).max(1600),
          height: z.number().int().min(1).max(1600),
          frameId: z.string().max(160),
          sourceLabel: z.string().max(256),
          observedAt: z.number().finite(),
        })
        .strict(),
    })
    .strict(),
]);

export const conciergeLiveRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  registerLiveTranscriptRoutes(app, {
    ownerUserId: options.ownerUserId,
    messages: options.messageStore,
    threads: options.threadService,
    sessions: options.sessions,
  });
  const resolveSelection = async (userId: string, expectedDutyCatProfileId?: string) => {
    const config = await (expectedDutyCatProfileId
      ? options.configStore.getSaved?.(userId)
      : options.configStore.get(userId));
    if (!config) throw new Error('Saved selection unavailable');
    if (expectedDutyCatProfileId && config.dutyCatProfileId !== expectedDutyCatProfileId)
      throw new LiveCompanionSelectionError('live_duty_unavailable');
    const cats = Object.values(catRegistry.getAllConfigs()).filter(
      (cat) => !expectedDutyCatProfileId || isCatAvailable(cat.id),
    );
    return resolveLiveCompanionSelection(config, cats);
  };
  app.addHook('preHandler', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, request.method === 'GET' ? 'read' : 'write');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    if (access.operator !== options.ownerUserId) return reply.code(403).send({ error: 'Host owner required' });
    const { id } = request.params as { id?: string };
    const call = id && request.method !== 'DELETE' ? options.sessions.get(id, access.operator) : undefined;
    if (call) {
      let current: boolean;
      try {
        current = await call.hasCurrentCompanion();
      } catch {
        await call.fail(new Error('Live companion configuration unavailable'));
        return reply
          .code(503)
          .send({ code: 'live_configuration_unavailable', error: 'Companion configuration unavailable' });
      }
      if (!current) {
        await call.fail(new Error('Live companion selection changed'));
        return reply.code(409).send({ code: 'live_selection_changed', error: 'Companion selection changed' });
      }
    }
  });
  app.get('/api/concierge/live/identity', async (request, reply) => {
    try {
      const companion = await resolveSelection(resolveSessionUserId(request)!);
      return {
        status: 'selected',
        identity: createCompanionIdentitySnapshot({
          ...companion,
          liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
        }),
      };
    } catch (error) {
      if (error instanceof LiveCompanionSelectionError)
        return reply.code(409).send({ code: error.code, error: 'Live companion identity unavailable' });
      request.log.error({ code: 'live_configuration_unavailable' }, 'Live companion configuration unavailable');
      return reply
        .code(503)
        .send({ code: 'live_configuration_unavailable', error: 'Companion configuration unavailable' });
    }
  });
  app.post('/api/concierge/live', async (request, reply) => {
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'Household access choice required; identity is Host-owned' });
    const userId = resolveSessionUserId(request)!;
    let companion;
    try {
      companion = await resolveSelection(userId, parsed.data.expectedDutyCatProfileId);
    } catch (error) {
      if (error instanceof LiveCompanionSelectionError)
        return reply.code(409).send({ code: error.code, error: 'Live companion identity unavailable' });
      request.log.error({ code: 'live_configuration_unavailable' }, 'Live companion configuration unavailable');
      return reply
        .code(503)
        .send({ code: 'live_configuration_unavailable', error: 'Companion configuration unavailable' });
    }
    const catId = companion.carrier.catId;
    const threadId = await options.threadService.getOrCreate(userId);
    const pageActionLedger = options.pageActionOwner?.enabled ? options.pageActionOwner.newLedger() : undefined;
    let call: Awaited<ReturnType<LiveCompanionSessions['prepare']>>;
    try {
      call = await options.sessions.prepare({
        binding: { userId, threadId, catId, callId: randomUUID() },
        messageStore: options.messageStore,
        mcpDistDir: options.mcpDistDir,
        ...(options.desktopRoot ? { desktopRoot: options.desktopRoot } : {}),
        allowedDirectories: options.allowedDirectories,
        householdToolsEnabled: parsed.data.allowHomeReads,
        companion,
        identitySnapshot: createCompanionIdentitySnapshot({
          ...companion,
          liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
        }),
        verifyCompanion: async () => {
          try {
            return sameLiveExecutionSelection(
              companion,
              await resolveSelection(userId, parsed.data.expectedDutyCatProfileId),
            );
          } catch (error) {
            if (error instanceof LiveCompanionSelectionError) return false;
            throw error;
          }
        },
        loadConversation: () =>
          readLiveConversationContext(options.messageStore, {
            userId,
            threadId,
            catId,
            dutyCatId: companion.duty.catId,
          }),
        verifyNativeBinding: async (nativeId) =>
          (await options.sessionChainStore.getActive(catId, threadId, userId))?.cliSessionId === nativeId,
        inbox: {
          source: (_scope, authorize, isSameCallExposure) =>
            new MessageLiveInboxSource({
              store: options.messageStore,
              queue: options.invocationQueue,
              authorize,
              isSameCallExposure,
              // An invocation ID alone cannot prove retained F296 context.
              retainsCurrentInvocationReads: () => false,
            }),
          onSuccessorRequired: async (scope, references) => {
            for (const reference of references) {
              const entry = options.invocationQueue.getEntrySnapshot(
                scope.threadId,
                scope.userId,
                reference.queueEntryId,
              );
              if (
                !entry ||
                !entry.targetCats.includes(scope.catId) ||
                (entry.messageId !== reference.messageId && !entry.mergedMessageIds?.includes(reference.messageId))
              )
                continue;
              await options.progressOwnedCarrier(entry, scope.catId);
            }
          },
        },
        recovery: {
          ...options.recovery,
          messages: options.messageStore,
          authorize: (scope) => options.threadService.isCurrent(scope.userId, scope.threadId),
        },
        ...(pageActionLedger
          ? {
              pageAction: {
                messages: options.messageStore,
                isCurrentThread: (ownerId: string, currentThreadId: string) =>
                  options.threadService.isCurrent(ownerId, currentThreadId),
                approvalLedger: pageActionLedger,
              },
            }
          : {}),
        reportInboxFailure: (error) => request.log.warn({ err: error }, 'Live inbox boundary deferred'),
        publish: options.publish,
      });
      if (pageActionLedger) options.pageActionOwner?.bindCall(call, pageActionLedger);
    } catch (error) {
      pageActionLedger?.close();
      if (error instanceof LiveCallAlreadyActiveError)
        return reply.code(409).send({ code: 'live_call_active', error: 'Live call already active' });
      request.log.error({ code: 'live_prepare_failed' }, 'Live call preparation failed');
      return reply.code(503).send({ code: 'live_prepare_failed', error: 'Live preparation failed' });
    }
    try {
      const admission = await app.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { cookie: request.headers.cookie ?? '', 'x-cat-cafe-live-session': call.id },
        payload: {
          content: `@${catId}\n开始语音交流。${parsed.data.allowHomeReads ? '已允许查询家里资料' : '未开放家里资料'}；屏幕只在另行选择后共享。`,
          threadId,
          deliveryMode: 'immediate',
          idempotencyKey: call.id,
        },
      });
      const admitted = admission.json();
      if (admission.statusCode !== 200 || admitted.status !== 'processing') {
        await call.fail(new Error('Host did not admit Live'));
        return reply
          .code(admission.statusCode >= 400 ? admission.statusCode : 409)
          .send({ error: 'Host did not admit Live' });
      }
      if (pageActionLedger) pageActionLedger.markHostAdmissionSource(admitted.userMessageId);
      // Return the admitted handle immediately so the desktop can cancel during native startup.
      // It must poll until ready before opening its microphone.
      return reply.code(202).send(call.status());
    } catch (error) {
      await call.fail(error instanceof Error ? error : new Error('Live admission failed'));
      return reply.code(503).send({ error: 'Live admission failed' });
    }
  });
  app.get<{ Params: { id: string } }>('/api/concierge/live/:id', async (request, reply) => {
    const call = options.sessions.get(request.params.id, resolveSessionUserId(request)!);
    call?.touchSurface();
    return (
      options.sessions.readStatus(request.params.id, resolveSessionUserId(request)!) ??
      reply.code(404).send({ error: 'Live call unavailable' })
    );
  });
  app.post<{ Params: { id: string } }>('/api/concierge/live/:id/start', async (request, reply) => {
    const call = options.sessions.get(request.params.id, resolveSessionUserId(request)!);
    if (!call) return reply.code(404).send({ error: 'Live call unavailable' });
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid offer' });
    try {
      const answer = await call.start(parsed.data.offer);
      return { ...call.status(), answer };
    } catch {
      return reply.code(503).send({ error: 'Live connection failed' });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/concierge/live/:id', async (request, reply) => {
    const call = options.sessions.get(request.params.id, resolveSessionUserId(request)!);
    if (!call) return reply.code(404).send({ error: 'Live call unavailable' });
    await call.stop();
    if (call.status().state !== 'closed') return reply.code(503).send({ error: 'Live teardown unconfirmed' });
    return { stopped: true };
  });
  app.post<{ Params: { id: string } }>('/api/concierge/live/:id/text', async (request, reply) => {
    const call = options.sessions.get(request.params.id, resolveSessionUserId(request)!);
    if (!call) return reply.code(404).send({ error: 'Live call unavailable' });
    const parsed = textSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid message' });
    try {
      return await call.sendText(parsed.data.text, parsed.data.clientMessageId);
    } catch {
      return reply.code(503).send({ error: 'Live text delivery unconfirmed' });
    }
  });
  app.post<{ Params: { id: string } }>(
    '/api/concierge/live/:id/screen',
    { bodyLimit: 1_500_000 },
    async (request, reply) => {
      const call = options.sessions.get(request.params.id, resolveSessionUserId(request)!);
      if (!call) return reply.code(404).send({ error: 'Live call unavailable' });
      const parsed = screenSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid shared screen' });
      try {
        call.shareScreen(parsed.data);
        return { accepted: true };
      } catch {
        return reply.code(409).send({ error: 'Shared screen grant expired' });
      }
    },
  );
  app.addHook('onClose', async () => options.sessions.close());
};
