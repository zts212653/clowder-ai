import { createHash } from 'node:crypto';
import {
  type ProducerAttentionReceiptV1,
  type ProducerAttentionReevaluationLinkV1,
  producerAttentionReevaluationLinkV1Schema,
  type TaskItem,
} from '@cat-cafe/shared';
import type { TaskTemplate } from '../../infrastructure/scheduler/templates/types.js';
import type { TaskSpec_P1, TriggerSpec } from '../../infrastructure/scheduler/types.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { NeedsMeProducerCatalog } from './NeedsMeProducerCatalog.js';

export const ENTRUSTED_WORK_REEVALUATION_TEMPLATE_ID = 'entrusted-work-producer-reevaluation';

export interface ProducerAttentionReevaluationDeps {
  readonly tasks: Pick<ITaskStore, 'get'>;
  readonly producerCatalog: NeedsMeProducerCatalog;
  readonly invalidateProjection?: (ownerUserId: string) => void;
}

export interface CreateProducerAttentionReevaluationTaskSpecInput extends ProducerAttentionReevaluationDeps {
  readonly trigger: TriggerSpec;
  readonly link: ProducerAttentionReevaluationLinkV1;
}

export function producerAttentionReevaluationTaskId(rawLink: ProducerAttentionReevaluationLinkV1): string {
  const link = producerAttentionReevaluationLinkV1Schema.parse(rawLink);
  const pair = [link.producer.producerId, link.producer.subjectRef, link.taskRef.subjectRef].join('\u0000');
  return `f310-reeval-${createHash('sha256').update(pair).digest('hex').slice(0, 32)}`;
}

export function createProducerAttentionReevaluationTaskSpec(
  instanceId: string,
  input: CreateProducerAttentionReevaluationTaskSpecInput,
): TaskSpec_P1 {
  const link = producerAttentionReevaluationLinkV1Schema.parse(input.link);
  return {
    id: instanceId,
    profile: 'awareness',
    trigger: input.trigger,
    admission: {
      async gate() {
        const receipt = await readExactCurrentReceipt(link, input);
        if (!receipt) return { run: false, reason: 'Task or producer owner coordinates are no longer current' };
        return {
          run: true,
          workItems: [
            {
              signal: link,
              subjectKey: `${link.producer.producerId}:${link.producer.subjectRef}|${link.taskRef.subjectRef}`,
              dedupeKey: producerAttentionReevaluationTaskId(link),
            },
          ],
        };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 30_000,
      async execute(rawSignal) {
        const signal = producerAttentionReevaluationLinkV1Schema.parse(rawSignal);
        const current = await readExactCurrentReceipt(signal, input);
        if (!current) return;
        const result = await input.producerCatalog.reEvaluate(signal.producer.producerId, {
          ownerUserId: signal.ownerUserId,
          producerSubjectRef: signal.producer.subjectRef,
          expectedProducerRevision: signal.producer.observedRevision,
          taskRef: signal.taskRef,
          reEvaluateActionRef: signal.reEvaluateActionRef,
        });
        if (result.state === 'refreshed' || result.state === 'retired') {
          input.invalidateProjection?.(signal.ownerUserId);
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => true,
    display: {
      label: 'Re-evaluate entrusted work',
      category: 'system',
      description: 'Re-read one current entrusted Task and invoke its source producer action',
      subjectKind: 'none',
    },
  };
}

export function createProducerAttentionReevaluationTemplate(deps: ProducerAttentionReevaluationDeps): TaskTemplate {
  return {
    templateId: ENTRUSTED_WORK_REEVALUATION_TEMPLATE_ID,
    label: 'Re-evaluate entrusted work',
    category: 'system',
    description: 'Invoke one producer-owned action after re-reading its exact entrusted Task coordinates',
    subjectKind: 'none',
    defaultTrigger: { type: 'once', fireAt: 0 },
    paramSchema: {},
    createSpec(instanceId, params) {
      if (!params.entrustedWorkReevaluation) {
        throw new Error('entrusted-work producer re-evaluation requires a typed owner link');
      }
      return createProducerAttentionReevaluationTaskSpec(instanceId, {
        ...deps,
        trigger: params.trigger,
        link: params.entrustedWorkReevaluation,
      });
    },
  };
}

async function readExactCurrentReceipt(
  link: ProducerAttentionReevaluationLinkV1,
  deps: ProducerAttentionReevaluationDeps,
): Promise<ProducerAttentionReceiptV1 | null> {
  const taskId = taskIdFromSubjectRef(link.taskRef.subjectRef);
  if (!taskId) return null;
  const task = await deps.tasks.get(taskId);
  if (!isExactCurrentTask(task, link)) return null;
  const receipt = await deps.producerCatalog.get(link.producer.producerId).readCurrentReceipt({
    ownerUserId: link.ownerUserId,
    producerSubjectRef: link.producer.subjectRef,
  });
  if (!receipt?.eligible) return null;
  const exact =
    receipt.producer.producerId === link.producer.producerId &&
    receipt.producer.subjectRef === link.producer.subjectRef &&
    receipt.producer.revision === link.producer.observedRevision &&
    receipt.taskRef.subjectRef === link.taskRef.subjectRef &&
    receipt.taskRef.observedRevision === link.taskRef.observedRevision &&
    receipt.reEvaluateActionRef === link.reEvaluateActionRef;
  return exact ? receipt : null;
}

function taskIdFromSubjectRef(subjectRef: string): string | null {
  const match = /^task:work:(.+)$/u.exec(subjectRef);
  return match?.[1] ?? null;
}

function isExactCurrentTask(task: TaskItem | null, link: ProducerAttentionReevaluationLinkV1): task is TaskItem {
  return Boolean(
    task &&
      task.kind === 'work' &&
      task.userId === link.ownerUserId &&
      task.status !== 'done' &&
      task.entrustedWork?.closure.state === 'open' &&
      task.entrustedWork.revision === link.taskRef.observedRevision &&
      `task:work:${task.id}` === link.taskRef.subjectRef,
  );
}
