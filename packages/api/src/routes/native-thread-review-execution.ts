import { type CatId, type ProviderReviewSemanticEvent, projectProviderSemanticEvent } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type {
  ProviderNativeReview,
  ProviderNativeReviewRequest,
  ProviderNativeReviewTarget,
} from '../domains/cats/services/types.js';
import type { NativeSessionTarget } from './native-session-target.js';
import { type NativeReviewProjectionV1, projectReviewMessages } from './native-thread-review-projection.js';

export interface ReviewExecutionOptions {
  readonly messageStore: IMessageStore;
  readonly publishMessage?: (threadId: string, message: StoredMessage) => void;
}

export interface ReviewAccess {
  readonly thread: Thread;
  readonly userId: string;
}

interface NativeReviewExecutionInput {
  options: ReviewExecutionOptions;
  access: ReviewAccess;
  reviewId: string;
  targetSession: NativeSessionTarget;
  requestedAt: number;
  request: ProviderNativeReviewRequest;
  logger: Pick<FastifyInstance['log'], 'warn'>;
}

export async function executeNativeReview(input: NativeReviewExecutionInput): Promise<void> {
  const published = new Set<string>();
  const publishUpdate = (review: ProviderNativeReview) => publishReviewUpdate(input, published, review);
  try {
    const result = await input.targetSession.service.requestNativeReview?.({
      sessionId: input.targetSession.sessionId,
      invocationId: `native-review-${input.reviewId}`,
      timeoutMs: 600_000,
      request: input.request,
      onUpdate: publishUpdate,
    });
    if (!result) throw new Error('native_review_unsupported');
    await publishUpdate(result);
  } catch (error) {
    input.logger.warn(
      { err: error, threadId: input.access.thread.id, reviewId: input.reviewId },
      'F306 native review execution failed',
    );
    if (!published.has('terminal')) {
      await appendReviewFailure(
        input.options,
        input.access,
        input.reviewId,
        input.request.target,
        input.request.delivery,
        'Codex 原生 Review 未完成',
        input.targetSession.catId,
        'native_review_request_failed',
        input.requestedAt,
      );
    }
  }
}

async function publishReviewUpdate(
  input: NativeReviewExecutionInput,
  published: Set<string>,
  review: ProviderNativeReview,
): Promise<void> {
  await publishReviewBinding(input, published, review);
  await publishReviewItems(input, published, review);
  if (!review.result || published.has('terminal')) return;
  const failed = review.result.status === 'failed';
  const errorCode = failed ? (review.result.errorCode ?? 'unknown_failure') : null;
  await appendReviewEvent(input.options, input.access, {
    ...baseReviewEvent(
      input.reviewId,
      failed ? 'failed' : 'result',
      failed ? reviewFailureSummary(errorCode ?? 'unknown_failure') : (review.result.summary ?? 'Review 已完成'),
    ),
    id: `native-review:${input.reviewId}:terminal`,
    actorCatId: input.targetSession.catId,
    requestedAt: input.requestedAt,
    target: input.request.target,
    targetLabel: targetLabel(input.request.target),
    delivery: input.request.delivery,
    reviewThreadId: review.reviewThreadId,
    turnId: review.turnId,
    severity: failed ? 'error' : 'info',
    ...(errorCode ? { errorCode } : {}),
  });
  published.add('terminal');
}

async function publishReviewBinding(
  input: NativeReviewExecutionInput,
  published: Set<string>,
  review: ProviderNativeReview,
): Promise<void> {
  if (published.has('binding')) return;
  await appendReviewEvent(input.options, input.access, {
    ...baseReviewEvent(input.reviewId, 'progress', 'Codex 原生 Review 已连接'),
    id: `native-review:${input.reviewId}:binding`,
    actorCatId: input.targetSession.catId,
    reviewThreadId: review.reviewThreadId,
    turnId: review.turnId,
  });
  published.add('binding');
}

async function publishReviewItems(
  input: NativeReviewExecutionInput,
  published: Set<string>,
  review: ProviderNativeReview,
): Promise<void> {
  for (const item of review.items) {
    if (published.has(item.id)) continue;
    published.add(item.id);
    await appendReviewEvent(input.options, input.access, {
      ...baseReviewEvent(input.reviewId, itemStage(item.kind), item.text, item.completedAt),
      id: `native-review:${input.reviewId}:item:${item.id}`,
      actorCatId: input.targetSession.catId,
      reviewThreadId: review.reviewThreadId,
      turnId: review.turnId,
    });
  }
}

export async function appendReviewEvent(
  options: ReviewExecutionOptions,
  access: ReviewAccess,
  event: ProviderReviewSemanticEvent,
): Promise<StoredMessage> {
  const projection = projectProviderSemanticEvent(event);
  if (projection.status !== 'projected') throw new Error('invalid_review_semantic_event');
  const stored = await options.messageStore.append({
    userId: 'system',
    catId: 'system' as CatId,
    threadId: access.thread.id,
    content: projection.content,
    mentions: [],
    timestamp: event.occurredAt,
    idempotencyKey: event.id,
    extra: { semanticEvent: event },
  });
  options.publishMessage?.(access.thread.id, stored);
  return stored;
}

export async function appendReviewFailure(
  options: ReviewExecutionOptions,
  access: ReviewAccess,
  reviewId: string,
  target: ProviderNativeReviewTarget,
  delivery: 'inline' | 'detached',
  summary: string,
  actorCatId: string,
  errorCode: string,
  requestedAt: number,
): Promise<NativeReviewProjectionV1> {
  const terminal = await appendReviewEvent(options, access, {
    ...baseReviewEvent(reviewId, 'failed', summary),
    id: `native-review:${reviewId}:terminal`,
    actorCatId,
    requestedAt,
    target,
    targetLabel: targetLabel(target),
    delivery,
    severity: 'error',
    errorCode,
  });
  const review = projectReviewMessages([terminal]).find((candidate) => candidate.id === reviewId);
  if (!review) throw new Error(`native_review_projection_missing:${reviewId}`);
  return review;
}

function reviewFailureSummary(errorCode: string): string {
  if (errorCode === 'provider_review_interrupted') return 'Codex 原生 Review 已被中断';
  if (errorCode === 'native_session_busy') return '原生会话正在处理其他工作';
  return 'Codex 原生 Review 未完成';
}

export function baseReviewEvent(
  reviewId: string,
  stage: ProviderReviewSemanticEvent['stage'],
  summary: string,
  occurredAt = Date.now(),
): ProviderReviewSemanticEvent {
  return {
    v: 1,
    id: `native-review:${reviewId}:${stage}`,
    kind: 'review',
    reviewId,
    stage,
    summary,
    occurredAt,
    provenance: { provider: 'openai_codex', carrier: 'app_server' },
  };
}

function itemStage(kind: ProviderNativeReview['items'][number]['kind']): ProviderReviewSemanticEvent['stage'] {
  if (kind === 'mode_entered') return 'mode_entered';
  if (kind === 'mode_exited') return 'mode_exited';
  return 'progress';
}

export function targetLabel(target: ProviderNativeReviewTarget): string {
  if (target.kind === 'uncommitted_changes') return '未提交改动';
  if (target.kind === 'base_branch') return `相对 ${target.branch}`;
  if (target.kind === 'commit') return `提交 ${target.sha.slice(0, 10)}`;
  return '自定义审查';
}
