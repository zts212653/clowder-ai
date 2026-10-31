import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import type { DeliverOpts } from '../../infrastructure/scheduler/types.js';
import type { BallCustodyWakeAdmissionReceipt, BallCustodyWakeSender } from './BallCustodyProbeScheduler.js';

export interface SchedulerBallCustodyWakeSenderOptions {
  readonly deliver: (opts: DeliverOpts) => Promise<string>;
  /** Reads History back so retries dispatch the exact body accepted by idempotent persistence. */
  readonly readPersistedContent: (messageId: string) => Promise<string | null>;
  readonly defaultUserId?: string;
  readonly logger?: {
    warn?: (obj: unknown, msg?: string) => void;
  };
}

export class SchedulerBallCustodyWakeSender implements BallCustodyWakeSender {
  constructor(private readonly opts: SchedulerBallCustodyWakeSenderOptions) {}

  async send(input: Parameters<BallCustodyWakeSender['send']>[0]): Promise<BallCustodyWakeAdmissionReceipt> {
    const ownerCatId = input.task.ownerCatId;
    if (!ownerCatId) {
      throw new Error(`F233 PR4: cannot wake blocked task ${input.task.id} without ownerCatId`);
    }

    const userId = input.task.userId ?? this.opts.defaultUserId ?? 'default-user';
    const content = [
      `${SCHEDULER_TRIGGER_PREFIX} 条件探针已满足，球回到 @${ownerCatId}：${input.task.title}`,
      input.task.why ? '' : undefined,
      input.task.why || undefined,
    ]
      .filter((line): line is string => typeof line === 'string')
      .join('\n');

    // RFC §5.2: one envelope, one atomic Message + Queue admission. The old shape persisted the
    // wake, read it back to prove exactness, then admitted it — three steps to patch the window
    // between the first two. Writing the message and its Queue row together removes the window,
    // so there is nothing to read back and nothing to leave unadmitted.
    try {
      const messageId = await this.opts.deliver({
        threadId: input.task.threadId,
        content,
        userId,
        targetCatId: ownerCatId,
        sourceCategory: 'scheduled',
        idempotencyKey: `ball-custody-wake:${input.task.id}:${
          input.projection.blockedSinceAt ?? input.projection.lastStateChangeAt
        }`,
      });
      return { kind: 'admitted', messageId, outcome: 'enqueued' };
    } catch (err) {
      this.opts.logger?.warn?.({ err, taskId: input.task.id, ownerCatId }, 'F233 PR4: wake admission failed');
      return { kind: 'not_admitted', messageId: '', reason: 'invoke_failed' };
    }
  }
}
