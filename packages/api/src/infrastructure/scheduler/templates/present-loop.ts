import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import type { PresentLoopService } from '../../../domains/auto-dream/PresentLoopService.js';
import type { ExecuteContext, ScheduleRunTiming, TriggerSpec } from '../types.js';
import type { DynamicTaskParams, TaskTemplate } from './types.js';

export interface PresentLoopTemplateDependencies {
  service: PresentLoopService;
}

function fallbackTiming(trigger: TriggerSpec): ScheduleRunTiming {
  const now = Date.now();
  const scheduledAt = trigger.type === 'once' ? new Date(trigger.fireAt).toISOString() : null;
  return {
    triggerKind: trigger.type,
    scheduledAt,
    firedAt: new Date(now).toISOString(),
    latenessMs: trigger.type === 'once' ? Math.max(0, now - trigger.fireAt) : 0,
    missedSlots: 0,
    late: trigger.type === 'once' && now > trigger.fireAt,
  };
}

interface PresentLoopExecutionInput {
  service: PresentLoopService;
  context: ExecuteContext;
  trigger: TriggerSpec;
  subjectKey: string;
  taskId: string;
  ownerUserId: string;
  targetCatId: string;
}

function requireExecutionPorts(context: ExecuteContext) {
  if (!context.deliver) throw new Error('deliver not available');
  if (!context.invokeTrigger) throw new Error('invokeTrigger not available');
  return { deliver: context.deliver, invokeTrigger: context.invokeTrigger };
}

async function executePresentLoop(input: PresentLoopExecutionInput): Promise<void> {
  const { deliver, invokeTrigger } = requireExecutionPorts(input.context);
  const threadId = input.subjectKey.replace(/^thread-/, '');
  const schedule = input.context.schedule ?? fallbackTiming(input.trigger);
  const started = await input.service.beginScheduledRun({
    ownerUserId: input.ownerUserId,
    catId: input.targetCatId,
    threadId,
    taskId: input.taskId,
    schedule,
  });
  if (!started.created) return;

  const persistedContent = `${SCHEDULER_TRIGGER_PREFIX} ${input.service.renderPersistedWakeTrigger(started, schedule)}`;
  const invocationContent = `${SCHEDULER_TRIGGER_PREFIX} ${input.service.renderWakePrompt(started, schedule)}`;
  try {
    const messageId = await deliver({
      threadId,
      content: persistedContent,
      userId: 'scheduler',
      extra: { scheduler: { hiddenTrigger: true } },
    });
    const outcome = await invokeTrigger.trigger(
      threadId,
      input.targetCatId,
      input.ownerUserId,
      invocationContent,
      messageId,
      undefined,
      {
        sourceCategory: 'scheduled',
        reason: 'f255_present_loop',
      },
    );
    if (outcome === 'full') throw new Error('present loop invocation queue is full');
  } catch (error) {
    await input.service.failWake(input.ownerUserId, started.run.runId, error);
    throw error;
  }
}

export function createPresentLoopTemplate({ service }: PresentLoopTemplateDependencies): TaskTemplate {
  return {
    templateId: 'present-loop',
    label: '猫的私人时间',
    category: 'system',
    description: '按自选作息唤醒一段不以产出为目的的私人时间',
    subjectKind: 'thread',
    defaultTrigger: { type: 'interval', ms: 3_600_000 },
    paramSchema: {
      targetCatId: { type: 'string', required: true, description: '拥有这段私人时间的猫' },
    },
    createSpec(instanceId: string, params: DynamicTaskParams) {
      const targetCatId = typeof params.params.targetCatId === 'string' ? params.params.targetCatId.trim() : '';
      const ownerUserId = typeof params.params.triggerUserId === 'string' ? params.params.triggerUserId.trim() : '';
      const configuredThreadId = params.deliveryThreadId;

      return {
        id: instanceId,
        profile: 'awareness',
        trigger: params.trigger,
        admission: {
          async gate() {
            if (!targetCatId) return { run: false, reason: 'no targetCatId' };
            if (!ownerUserId) return { run: false, reason: 'no triggerUserId' };
            if (!configuredThreadId) return { run: false, reason: 'no deliveryThreadId' };
            if (!service.acceptsOwner(ownerUserId)) {
              return { run: false, reason: 'owner is not configured for private diary persistence' };
            }
            return { run: true, workItems: [{ signal: null, subjectKey: `thread-${configuredThreadId}` }] };
          },
        },
        run: {
          overlap: 'skip',
          timeoutMs: 60_000,
          async execute(_signal, subjectKey, context) {
            await executePresentLoop({
              service,
              context,
              trigger: params.trigger,
              subjectKey,
              taskId: instanceId,
              ownerUserId,
              targetCatId,
            });
          },
        },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'record' },
        enabled: () => true,
        display: {
          label: `${targetCatId || '猫猫'}的私人时间`,
          category: 'system',
          description: '频率是可调整的实验参数；安静和发呆都是完整结果',
          subjectKind: 'thread',
        },
      };
    },
  };
}
