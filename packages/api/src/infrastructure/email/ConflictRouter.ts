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
