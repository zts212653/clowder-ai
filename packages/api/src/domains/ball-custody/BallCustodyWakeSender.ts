import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import type { DeliverOpts, ScheduleInvokeTrigger } from '../../infrastructure/scheduler/types.js';
import type { BallCustodyWakeAdmissionReceipt, BallCustodyWakeSender } from './BallCustodyProbeScheduler.js';

export interface SchedulerBallCustodyWakeSenderOptions {
  readonly deliver: (opts: DeliverOpts) => Promise<string>;
  /** Reads History back so retries dispatch the exact body accepted by idempotent persistence. */
  readonly readPersistedContent: (messageId: string) => Promise<string | null>;
  readonly invokeTrigger?: ScheduleInvokeTrigger;
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

    const messageId = await this.opts.deliver({
      threadId: input.task.threadId,
      content,
      userId: 'scheduler',
      idempotencyKey: `ball-custody-wake:${input.task.id}:${
        input.projection.blockedSinceAt ?? input.projection.lastStateChangeAt
      }`,
      extra: { scheduler: { hiddenTrigger: true } },
    });
    let persistedContent: string | null;
    try {
      persistedContent = await this.opts.readPersistedContent(messageId);
    } catch (err) {
      this.opts.logger?.warn?.(
        { err, taskId: input.task.id, messageId },
        'F298: persisted wake could not be read back for exact admission',
      );
      return { kind: 'not_admitted', messageId, reason: 'persisted_message_unavailable' };
    }
    if (persistedContent === null) {
      return { kind: 'not_admitted', messageId, reason: 'persisted_message_unavailable' };
    }

    if (!this.opts.invokeTrigger) {
      return { kind: 'not_admitted', messageId, reason: 'trigger_unavailable' };
    }

    try {
      const outcome = await this.opts.invokeTrigger.trigger(
        input.task.threadId,
        ownerCatId,
        userId,
        persistedContent,
        messageId,
        undefined,
        {
          priority: 'normal',
          reason: 'f233_ball_custody_probe_satisfied',
          sourceCategory: 'scheduled',
        },
      );
      return outcome === 'full'
        ? { kind: 'not_admitted', messageId, reason: 'queue_full' }
        : { kind: 'admitted', messageId, outcome };
    } catch (err) {
      this.opts.logger?.warn?.({ err, taskId: input.task.id, ownerCatId }, 'F233 PR4: wake invokeTrigger failed');
      return { kind: 'not_admitted', messageId, reason: 'invoke_failed' };
    }
  }
}
