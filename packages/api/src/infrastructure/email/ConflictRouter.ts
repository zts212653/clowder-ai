import type { WaitOutcomeV1 } from '@cat-cafe/shared';
import { prSubjectKey } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { GitHubWaitLifecycleService } from '../../domains/github-signals/GitHubWaitLifecycleService.js';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';

export interface ConflictSignal {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly mergeState: string;
}

export type ConflictRouteResult =
  | {
      readonly kind: 'notified';
      readonly threadId: string;
      readonly catId: string;
      readonly messageId: string;
      readonly content: string;
      /**
       * #1392 R5: the outcome that was actually delivered, carried instead of collapsed into the word
       * "notified". A consumer that writes to a repository has to know WHICH condition matched: an
       * expiry and a conflict are both deliveries, and only one of them is a conflict.
       */
      readonly outcome: WaitOutcomeV1;
    }
  | {
      /**
       * The wait matched and its outcome is durably terminalized, but nothing has been announced
       * yet. Phase C AC-C1: a conflict the scheduler can repair itself should not disturb the
       * owner, and deciding that requires holding the authorization without the announcement. The
       * caller owes exactly one of `publish` or `settleWithoutWake`; if it dies owing that, the
       * outcome stays in the outbox and the next observation tells the owner anyway.
       */
      readonly kind: 'matched_pending';
      readonly taskId: string;
      readonly threadId: string;
      readonly catId: string;
      readonly outcome: WaitOutcomeV1;
    }
  | { readonly kind: 'deduped' | 'skipped'; readonly reason: string };

export interface ConflictRouterOptions {
  readonly taskStore: ITaskStore;
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly waitLifecycle: GitHubWaitLifecycleService;
  readonly log: FastifyBaseLogger;
}

export class ConflictRouter {
  constructor(private readonly opts: ConflictRouterOptions) {}

  async route(signal: ConflictSignal): Promise<ConflictRouteResult> {
    const sk = prSubjectKey(signal.repoFullName, signal.prNumber);
    const task = await this.opts.taskStore.getBySubject(sk);
    if (!task) return { kind: 'skipped', reason: `No tracking task for ${signal.repoFullName}#${signal.prNumber}` };
    if (signal.mergeState === 'UNKNOWN') return { kind: 'skipped', reason: 'mergeState UNKNOWN' };

    const result = await this.opts.waitLifecycle.observe({
      taskId: task.id,
      // Hold the announcement: this router's caller may be able to fix the conflict itself.
      deferDelivery: true,
      facts: {
        headSha: signal.headSha,
        conflict: { mergeState: signal.mergeState },
      },
      collectorPatch: {
        conflict: {
          mergeState: signal.mergeState,
          lastFingerprint: `${signal.headSha}:${signal.mergeState}`,
        },
      },
    });
    if (result.kind === 'pending_delivery') {
      return {
        kind: 'matched_pending',
        taskId: result.task.id,
        threadId: result.task.threadId,
        catId: result.task.ownerCatId ?? '',
        outcome: result.outcome,
      };
    }
    if (result.kind !== 'notified') {
      return {
        kind: result.kind === 'deduped' || result.kind === 'unrecorded' ? 'deduped' : 'skipped',
        reason: result.reason,
      };
    }
    return {
      kind: 'notified',
      threadId: result.task.threadId,
      catId: result.task.ownerCatId ?? '',
      messageId: result.messageId,
      content: result.content,
      outcome: result.outcome,
    };
  }

  /** Announce a deferred outcome: exactly one wake, or none if the outbox already flushed. */
  async publish(taskId: string, outcome: WaitOutcomeV1): Promise<ConflictRouteResult> {
    const result = await this.opts.waitLifecycle.publishDeferred(taskId, outcome.outcomeId);
    if (result.kind !== 'notified') {
      return { kind: result.kind === 'not_tracked' ? 'skipped' : 'deduped', reason: result.reason };
    }
    return {
      kind: 'notified',
      threadId: result.task.threadId,
      catId: result.task.ownerCatId ?? '',
      messageId: result.messageId,
      content: result.content,
      outcome: result.outcome,
    };
  }

  /** Close a deferred outcome the caller resolved itself, without waking the owner. */
  async settleWithoutWake(taskId: string, outcome: WaitOutcomeV1, reason: string): Promise<boolean> {
    return this.opts.waitLifecycle.settleDeferredWithoutWake(taskId, outcome.outcomeId, reason);
  }
}

export function buildConflictMessageContent(signal: ConflictSignal): string {
  return [
    `🔔 **PR wait satisfied** — ${signal.repoFullName}#${signal.prNumber}`,
    '',
    `- ${signal.mergeState.toLowerCase()}`,
    '',
    'Matched reason: `matched`',
  ].join('\n');
}
