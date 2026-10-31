import { randomUUID } from 'node:crypto';
import { createCatId } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentRegistry } from '../domains/cats/services/agents/registry/AgentRegistry.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ProviderNativeRealtimeConsumer, ProviderNativeRealtimeSession } from '../domains/cats/services/types.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { resolveStrictUserId } from '../utils/request-identity.js';
import {
  type ActiveCompanion,
  consumeRealtimeCompanionEvent,
  projectActiveRealtimeCompanion,
  realtimeCompanionSessionKey,
  stopRealtimeCompanion,
} from './native-realtime-companion-lifecycle.js';
import type {
  RealtimeCompanionAudioSource,
  RealtimeCompanionAudioSubscription,
} from './realtime-companion-audio-source.js';

interface NativeRealtimeCompanionRouteOptions extends FastifyPluginOptions {
  readonly enabled: boolean;
  readonly threadStore: IThreadStore;
  readonly sessionChainStore: ISessionChainStore;
  readonly messageStore: IMessageStore;
  readonly agentRegistry: AgentRegistry;
  readonly audioSource: RealtimeCompanionAudioSource;
  readonly publishMessage?: (threadId: string, message: StoredMessage) => void;
}

interface ThreadParams {
  Params: { threadId: string };
}

interface StartRequest extends ThreadParams {
  Body: { consumer?: unknown; experimental?: unknown };
}

interface CompanionAccess {
  readonly userId: string;
  readonly catId: string;
  readonly thread: Thread;
}

const CONSUMERS = new Set<ProviderNativeRealtimeConsumer>(['watch_video', 'meeting_companion']);
const STARTUP_TIMEOUT_MS = 20_000;
const MAX_DURATION_MS = 4 * 60 * 60 * 1_000;
const CAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function nativeRealtimeCompanionRoutes(
  app: FastifyInstance,
  options: NativeRealtimeCompanionRouteOptions,
): Promise<void> {
  if (!options.enabled) return;
  const active = new Map<string, ActiveCompanion>();
  const starting = new Set<string>();

  app.addHook('onClose', async () => {
    await Promise.allSettled([...active.values()].map((session) => stopRealtimeCompanion(active, session, true)));
  });

  app.get<ThreadParams>('/api/threads/:threadId/realtime-companion/status', async (request, reply) => {
    const access = await resolveAccess(request, reply, options);
    if (!access) return;
    const session = active.get(realtimeCompanionSessionKey(access));
    return session
      ? reply.send(projectActiveRealtimeCompanion(session))
      : reply.send({ status: 'inactive', catId: access.catId });
  });

  app.post<StartRequest>('/api/threads/:threadId/realtime-companion/start', async (request, reply) => {
    const access = await resolveAccess(request, reply, options);
    if (!access) return;
    if (request.body?.experimental !== true) {
      return reply.status(400).send({
        error: 'Explicit experimental opt-in is required',
        code: 'REALTIME_COMPANION_EXPERIMENTAL_OPT_IN_REQUIRED',
      });
    }
    const consumer = parseConsumer(request.body?.consumer);
    if (!consumer) {
      return reply
        .status(400)
        .send({ error: 'Unknown realtime companion consumer', code: 'REALTIME_COMPANION_INVALID_CONSUMER' });
    }
    const key = realtimeCompanionSessionKey(access);
    if (starting.has(key) || active.has(key)) {
      return reply
        .status(409)
        .send({ error: 'Realtime companion already active', code: 'REALTIME_COMPANION_ALREADY_ACTIVE' });
    }
    starting.add(key);
    try {
      const capture = await options.audioSource.inspect(access.thread.id);
      if (capture.state === 'thread_mismatch') {
        return reply.status(409).send({
          error: 'Audio capture belongs to another thread',
          code: 'REALTIME_COMPANION_CAPTURE_THREAD_MISMATCH',
        });
      }
      if (capture.state === 'not_running') {
        return reply
          .status(409)
          .send({ error: 'Audio capture is not active', code: 'REALTIME_COMPANION_CAPTURE_REQUIRED' });
      }
      if (capture.state === 'unavailable') {
        return reply
          .status(502)
          .send({ error: 'Audio capture status is unavailable', code: 'REALTIME_COMPANION_CAPTURE_UNAVAILABLE' });
      }
      const native = await options.sessionChainStore.getActive(
        createCatId(access.catId),
        access.thread.id,
        access.userId,
      );
      if (!native?.cliSessionId) {
        return reply
          .status(409)
          .send({ error: 'Native session unavailable', code: 'REALTIME_COMPANION_NATIVE_SESSION_UNAVAILABLE' });
      }
      const service = options.agentRegistry.get(access.catId);
      if (!service.openNativeRealtimeCompanion) {
        return reply
          .status(409)
          .send({ error: 'Realtime companion unsupported', code: 'REALTIME_COMPANION_UNSUPPORTED' });
      }
      let record: ActiveCompanion | undefined;
      let startupAudioFailure: 'stopped' | 'unavailable' | undefined;
      let audio: RealtimeCompanionAudioSubscription;
      try {
        audio = await options.audioSource.subscribe(access.thread.id, {
          onTranscript: (transcript) => record?.provider.appendTranscript(transcript),
          onStopped: () => {
            startupAudioFailure = 'stopped';
            return record ? stopRealtimeCompanion(active, record, true) : undefined;
          },
          onError: (error) => {
            startupAudioFailure = 'unavailable';
            app.log.warn({ err: error, threadId: access.thread.id }, 'F306 realtime companion audio stream failed');
            return record ? stopRealtimeCompanion(active, record, true) : undefined;
          },
        });
      } catch (error) {
        app.log.warn({ err: error, threadId: access.thread.id }, 'F306 realtime companion audio subscribe failed');
        return reply
          .status(502)
          .send({ error: 'Audio event stream unavailable', code: 'REALTIME_COMPANION_CAPTURE_UNAVAILABLE' });
      }
      const captureAfterSubscribe = await options.audioSource.inspect(access.thread.id);
      if (startupAudioFailure || captureAfterSubscribe.state !== 'ready') {
        audio.close();
        return sendCaptureFailure(reply, startupAudioFailure, captureAfterSubscribe);
      }
      const invocationId = `realtime-companion-${randomUUID()}`;
      let provider: ProviderNativeRealtimeSession;
      try {
        provider = await service.openNativeRealtimeCompanion({
          sessionId: native.cliSessionId,
          invocationId,
          consumer,
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
          maxDurationMs: MAX_DURATION_MS,
          onEvent: async (event) => {
            if (record) {
              await consumeRealtimeCompanionEvent(
                {
                  messageStore: options.messageStore,
                  ...(options.publishMessage ? { publishMessage: options.publishMessage } : {}),
                },
                active,
                record,
                event,
              );
            }
          },
        });
      } catch (error) {
        audio.close();
        throw error;
      }
      record = {
        key,
        idempotencyScope: invocationId,
        threadId: access.thread.id,
        userId: access.userId,
        catId: access.catId,
        consumer,
        startedAt: Date.now(),
        provider,
        audio,
        outputOrdinal: 0,
      };
      active.set(key, record);
      if (startupAudioFailure) {
        await stopRealtimeCompanion(active, record, true);
        return sendCaptureFailure(reply, startupAudioFailure, { state: 'not_running' });
      }
      void provider.closed.then(
        () => (record ? stopRealtimeCompanion(active, record, false) : undefined),
        () => (record ? stopRealtimeCompanion(active, record, false) : undefined),
      );
      void audio.closed.then(() => (record ? stopRealtimeCompanion(active, record, true) : undefined));
      return reply.status(201).send(projectActiveRealtimeCompanion(record));
    } catch (error) {
      app.log.warn(
        { err: error, threadId: access.thread.id, catId: access.catId },
        'F306 realtime companion start failed',
      );
      return reply
        .status(409)
        .send({ error: 'Native realtime session unavailable', code: 'REALTIME_COMPANION_NATIVE_SESSION_UNAVAILABLE' });
    } finally {
      starting.delete(key);
    }
  });

  app.post<ThreadParams>('/api/threads/:threadId/realtime-companion/stop', async (request, reply) => {
    const access = await resolveAccess(request, reply, options);
    if (!access) return;
    const session = active.get(realtimeCompanionSessionKey(access));
    if (!session) return reply.send({ status: 'inactive', catId: access.catId });
    await stopRealtimeCompanion(active, session, true);
    return reply.send({ status: 'stopped', catId: access.catId });
  });
}

async function resolveAccess(
  request: FastifyRequest<ThreadParams>,
  reply: FastifyReply,
  options: NativeRealtimeCompanionRouteOptions,
): Promise<CompanionAccess | null> {
  const userId = resolveStrictUserId(request);
  if (!userId) return reply.status(401).send({ error: 'Identity required' });
  const rawCatId = request.headers['x-cat-id'];
  const catId = typeof rawCatId === 'string' ? rawCatId.trim() : '';
  if (!CAT_ID_PATTERN.test(catId)) {
    return reply
      .status(400)
      .send({ error: 'Current cat identity is required', code: 'REALTIME_COMPANION_CALLER_CAT_REQUIRED' });
  }
  if (!options.agentRegistry.has(catId)) {
    return reply
      .status(409)
      .send({ error: 'Native session unavailable', code: 'REALTIME_COMPANION_NATIVE_SESSION_UNAVAILABLE' });
  }
  const thread = await options.threadStore.get(request.params.threadId);
  if (!thread) return reply.status(404).send({ error: 'Thread not found' });
  if (!canAccessThread(thread, userId)) return reply.status(403).send({ error: 'Access denied' });
  return { userId, catId, thread };
}

function parseConsumer(value: unknown): ProviderNativeRealtimeConsumer | null {
  return typeof value === 'string' && CONSUMERS.has(value as ProviderNativeRealtimeConsumer)
    ? (value as ProviderNativeRealtimeConsumer)
    : null;
}

function sendCaptureFailure(
  reply: FastifyReply,
  startupFailure: 'stopped' | 'unavailable' | undefined,
  capture: Awaited<ReturnType<RealtimeCompanionAudioSource['inspect']>>,
) {
  if (startupFailure === 'unavailable' || capture.state === 'unavailable') {
    return reply.status(502).send({
      error: 'Audio capture status is unavailable',
      code: 'REALTIME_COMPANION_CAPTURE_UNAVAILABLE',
    });
  }
  if (capture.state === 'thread_mismatch') {
    return reply.status(409).send({
      error: 'Audio capture belongs to another thread',
      code: 'REALTIME_COMPANION_CAPTURE_THREAD_MISMATCH',
    });
  }
  return reply.status(409).send({
    error: 'Audio capture ended during realtime startup',
    code: 'REALTIME_COMPANION_CAPTURE_REQUIRED',
  });
}
