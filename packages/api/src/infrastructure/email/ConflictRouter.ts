import { prSubjectKey } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { GitHubWaitLifecycleService } from '../../domains/github-signals/GitHubWaitLifecycleService.js';
import { projectWaitWakeDisposition } from '../../domains/github-signals/WaitWakeDisposition.js';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';

export interface ConflictSignal {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly mergeState: string;
  readonly mergeStateStatus?: string;
  /** Exact base/head ancestry from GitHub's compare API. */
  readonly isBehind: boolean;
}

export type ConflictRouteResult =
  | {
      readonly kind: 'notified';
      readonly threadId: string;
      readonly catId: string;
      readonly messageId: string;
      readonly content: string;
      /**
       * WHICH subscribed events produced this notification.
       *
       * "Something matched" is not authorization to act on a specific one. This router always
       * emits `pr_head_changed` alongside the conflict event, so a tracker that subscribed to
       * `head_changed` and EXCLUDED `conflict` still got `notified` on a conflicting poll — and
       * the caller read that as permission to rebase and force the branch. A write must be
       * authorized by the event the owner actually subscribed to, so the caller gets the kinds
       * rather than a boolean.
       */
      readonly matchedKinds: readonly string[];
      /** sol R33: the outcome's own wake decision, honoured no matter which poll delivered it. */
      readonly autoWakeSuppressed: boolean;
      readonly observationEvaluated: boolean;
    }
  | { readonly kind: 'deduped' | 'skipped'; readonly reason: string };

export interface ConflictRouterOptions {
  readonly taskStore: ITaskStore;
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly waitLifecycle: GitHubWaitLifecycleService;
  readonly log: FastifyBaseLogger;
}

function authoritativeBaseFact(isBehind: boolean | undefined): { base?: { isBehind: boolean } } {
  return isBehind === undefined ? {} : { base: { isBehind } };
}

export class ConflictRouter {
  constructor(private readonly opts: ConflictRouterOptions) {}

  async route(signal: ConflictSignal): Promise<ConflictRouteResult> {
    const sk = prSubjectKey(signal.repoFullName, signal.prNumber);
    const task = await this.opts.taskStore.getBySubject(sk);
    if (!task) return { kind: 'skipped', reason: `No tracking task for ${signal.repoFullName}#${signal.prNumber}` };
    if (signal.mergeState === 'UNKNOWN' && signal.mergeStateStatus === undefined) {
      return { kind: 'skipped', reason: 'merge state unavailable' };
    }

    const result = await this.opts.waitLifecycle.observe({
      taskId: task.id,
      events: [
        {
          type: 'pr_head_changed',
          source: 'pr_head',
          id: signal.headSha,
          summary: `HEAD changed to ${signal.headSha.slice(0, 7)}`,
        },
        ...(signal.mergeState === 'CONFLICTING'
          ? [
              {
                type: 'pr_became_conflicting' as const,
                source: 'pr_conflict' as const,
                id: signal.mergeState,
                summary: 'PR became conflicting',
              },
            ]
          : []),
        ...(signal.isBehind === true
          ? [
              {
                type: 'pr_base_behind' as const,
                source: 'pr_base' as const,
                id: 'true',
                summary: 'base branch advanced — PR is behind base',
              },
            ]
          : []),
      ],
      facts: {
        headSha: signal.headSha,
        ...(signal.mergeState !== 'UNKNOWN' ? { conflict: { mergeState: signal.mergeState } } : {}),
        ...authoritativeBaseFact(signal.isBehind),
      },
      collectorPatch: {
        conflict: {
          mergeState: signal.mergeState,
          ...(signal.mergeStateStatus ? { mergeStateStatus: signal.mergeStateStatus } : {}),
          lastFingerprint: `${signal.headSha}:${signal.mergeState}:${signal.mergeStateStatus ?? 'UNKNOWN'}`,
        },
      },
    });
    if (result.kind !== 'notified') {
      return {
        kind: result.kind === 'deduped' ? 'deduped' : 'skipped',
        reason: result.reason,
      };
    }
    return {
      kind: 'notified',
      threadId: result.task.threadId,
      catId: result.task.ownerCatId ?? '',
      messageId: result.messageId,
      content: result.content,
      // sol R30 second-order: when observe re-published an EARLIER outcome, its `matched` kinds
      // belong to that older observation. Passing them through would let generation N's conflict
      // authorize a branch rewrite for an observation that was never evaluated.
      matchedKinds: result.observationEvaluated ? (result.outcome.matched ?? []).map((delta) => delta.kind) : [],
      ...projectWaitWakeDisposition(result),
    };
  }
}
