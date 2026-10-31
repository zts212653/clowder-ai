import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentRegistry } from '../domains/cats/services/agents/registry/AgentRegistry.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ProviderNativeReviewTarget } from '../domains/cats/services/types.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { resolveStrictUserId } from '../utils/request-identity.js';
import { listNativeSessionTargets } from './native-session-target.js';
import { listNativeTargetChoices } from './native-target-selection.js';
import {
  appendReviewEvent,
  appendReviewFailure,
  baseReviewEvent,
  executeNativeReview,
  type ReviewAccess,
  targetLabel,
} from './native-thread-review-execution.js';
import { type NativeReviewProjectionV1, projectReviewMessages } from './native-thread-review-projection.js';

interface NativeThreadReviewRouteOptions extends FastifyPluginOptions {
  readonly agentRegistry: AgentRegistry;
  readonly messageStore: IMessageStore;
  readonly sessionChainStore: ISessionChainStore;
  readonly threadStore: IThreadStore;
  readonly isSessionBusy?: (threadId: string, catId: string, userId: string) => boolean;
  readonly publishMessage?: (threadId: string, message: StoredMessage) => void;
}

interface ReviewParams {
  Params: { threadId: string };
}

interface ReviewStartRequest extends ReviewParams {
  Body: { target?: unknown; delivery?: unknown; catId?: string };
}

const NATIVE_REVIEW_HISTORY_MESSAGE_LIMIT = 200;

interface ActiveNativeReview {
  readonly threadId: string;
  readonly projection: NativeReviewProjectionV1;
}

export async function nativeThreadReviewRoutes(
  app: FastifyInstance,
  options: NativeThreadReviewRouteOptions,
): Promise<void> {
  const activeSessions = new Set<string>();
  const activeReviews = new Map<string, ActiveNativeReview>();
  app.get<ReviewParams>('/api/threads/:threadId/reviews/native', async (request, reply) => {
    const access = await resolveReviewAccess(request, reply, options);
    if (!access) return;
    const messages = await options.messageStore.getByThread(
      access.thread.id,
      NATIVE_REVIEW_HISTORY_MESSAGE_LIMIT,
      access.userId,
    );
    const projectedReviews = projectReviewMessages(messages).map((review) =>
      review.status === 'running' && !activeReviews.has(review.id)
        ? { ...review, status: 'unavailable' as const, unavailableReason: 'runtime_liveness_unverifiable' }
        : review,
    );
    const activeForThread = [...activeReviews.entries()].filter(([, active]) => active.threadId === access.thread.id);
    const projectedIds = new Set(projectedReviews.map((review) => review.id));
    const reviews = [
      ...activeForThread.filter(([reviewId]) => !projectedIds.has(reviewId)).map(([, active]) => active.projection),
      ...projectedReviews,
    ].sort((left, right) => right.updatedAt - left.updatedAt);
    return reply.send({
      reviews,
      activeReviewIds: activeForThread.map(([reviewId]) => reviewId),
      nativeTargets: await listNativeTargetChoices({
        agentRegistry: options.agentRegistry,
        sessionChainStore: options.sessionChainStore,
        threadId: access.thread.id,
        userId: access.userId,
        capability: 'requestNativeReview',
      }),
    });
  });
  app.post<ReviewStartRequest>('/api/threads/:threadId/reviews/native', async (request, reply) => {
    return startNativeReview({ app, options, request, reply, activeReviews, activeSessions });
  });
}

async function startNativeReview(input: {
  app: FastifyInstance;
  options: NativeThreadReviewRouteOptions;
  request: FastifyRequest<ReviewStartRequest>;
  reply: FastifyReply;
  activeReviews: Map<string, ActiveNativeReview>;
  activeSessions: Set<string>;
}): Promise<unknown> {
  const { app, options, request, reply, activeReviews, activeSessions } = input;
  const access = await resolveReviewAccess(request, reply, options);
  if (!access) return;
  const target = parseReviewTarget(request.body?.target);
  const delivery = request.body?.delivery;
  if (!target || (delivery !== 'inline' && delivery !== 'detached')) {
    return reply.status(400).send({ error: 'Invalid native review request' });
  }
  const candidates = await listNativeSessionTargets({
    agentRegistry: options.agentRegistry,
    sessionChainStore: options.sessionChainStore,
    threadId: access.thread.id,
    userId: access.userId,
    capability: 'requestNativeReview',
  });
  const nativeTargets = candidates.map(({ catId }) => ({ catId }));
  if (!request.body?.catId && candidates.length > 1) {
    return reply.status(409).send({
      error: 'Select a native session',
      code: 'NATIVE_SESSION_SELECTION_REQUIRED',
      nativeTargets,
    });
  }
  const targetSession = request.body?.catId
    ? candidates.find((candidate) => candidate.catId === request.body.catId)
    : candidates[0];
  if (!targetSession) {
    return reply.status(409).send({
      error: 'Native session unavailable',
      code: 'NATIVE_SESSION_UNAVAILABLE',
      nativeTargets,
    });
  }
  const reviewId = randomUUID();
  const requestedAt = Date.now();
  await appendReviewEvent(options, access, {
    ...baseReviewEvent(reviewId, 'started', 'Codex 原生 Review 已启动', requestedAt),
    requestedAt,
    actorCatId: targetSession.catId,
    target,
    targetLabel: targetLabel(target),
    delivery,
  });
  const running = runningProjection(reviewId, target, delivery, targetSession.catId, requestedAt);
  activeReviews.set(reviewId, { threadId: access.thread.id, projection: running });
  if (
    activeSessions.has(targetSession.sessionId) ||
    options.isSessionBusy?.(access.thread.id, targetSession.catId, access.userId)
  ) {
    const failed = await appendReviewFailure(
      options,
      access,
      reviewId,
      target,
      delivery,
      '原生会话正在处理其他工作',
      targetSession.catId,
      'native_session_busy',
      requestedAt,
    );
    activeReviews.delete(reviewId);
    return reply.status(202).send({ review: failed });
  }
  activeSessions.add(targetSession.sessionId);
  void executeNativeReview({
    options,
    access,
    reviewId,
    targetSession,
    requestedAt,
    request: { target, delivery },
    logger: app.log,
  }).finally(() => {
    activeSessions.delete(targetSession.sessionId);
    activeReviews.delete(reviewId);
  });
  return reply.status(202).send({
    review: running,
  });
}

async function resolveReviewAccess(
  request: FastifyRequest<ReviewParams>,
  reply: FastifyReply,
  options: NativeThreadReviewRouteOptions,
): Promise<ReviewAccess | null> {
  const userId = resolveStrictUserId(request);
  if (!userId) return reply.status(401).send({ error: 'Identity required' });
  const thread = await options.threadStore.get(request.params.threadId);
  if (!thread) return reply.status(404).send({ error: 'Thread not found' });
  if (!canAccessThread(thread, userId)) return reply.status(403).send({ error: 'Access denied' });
  return { thread, userId };
}

function parseReviewTarget(value: unknown): ProviderNativeReviewTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (target.kind === 'uncommitted_changes') return { kind: 'uncommitted_changes' };
  if (target.kind === 'base_branch' && isBoundedText(target.branch, 256)) {
    return { kind: 'base_branch', branch: target.branch.trim() };
  }
  if (target.kind === 'commit' && typeof target.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(target.sha)) {
    return {
      kind: 'commit',
      sha: target.sha,
      ...(isBoundedText(target.title, 500) ? { title: target.title.trim() } : {}),
    };
  }
  if (target.kind === 'custom' && isBoundedText(target.instructions, 4_000)) {
    return { kind: 'custom', instructions: target.instructions.trim() };
  }
  return null;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function runningProjection(
  reviewId: string,
  target: ProviderNativeReviewTarget,
  delivery: 'inline' | 'detached',
  catId: string,
  requestedAt: number,
): NativeReviewProjectionV1 {
  return {
    v: 1,
    id: reviewId,
    target,
    delivery,
    status: 'running',
    requestedAt,
    updatedAt: requestedAt,
    catId,
    items: [],
  };
}
