import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import type { DeliverOpts, ScheduleInvokeTrigger } from '../../infrastructure/scheduler/types.js';
import type { BallCustodyWakeSender } from './BallCustodyProbeScheduler.js';

export interface SchedulerBallCustodyWakeSenderOptions {
  readonly deliver: (opts: DeliverOpts) => Promise<string>;
  readonly invokeTrigger?: ScheduleInvokeTrigger;
  readonly defaultUserId?: string;
  readonly logger?: {
    warn?: (obj: unknown, msg?: string) => void;
  };
}

export class SchedulerBallCustodyWakeSender implements BallCustodyWakeSender {
  constructor(private readonly opts: SchedulerBallCustodyWakeSenderOptions) {}

  async send(input: Parameters<BallCustodyWakeSender['send']>[0]): Promise<{ messageId: string }> {
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
      ...(this.opts.invokeTrigger ? { extra: { scheduler: { hiddenTrigger: true } } } : {}),
    });

    if (this.opts.invokeTrigger) {
      try {
        await Promise.resolve(
          this.opts.invokeTrigger.trigger(input.task.threadId, ownerCatId, userId, content, messageId, undefined, {
            priority: 'normal',
            reason: 'f233_ball_custody_probe_satisfied',
            sourceCategory: 'scheduled',
          }),
        );
      } catch (err) {
        this.opts.logger?.warn?.({ err, taskId: input.task.id, ownerCatId }, 'F233 PR4: wake invokeTrigger failed');
      }
    }

    return { messageId };
  }
}
