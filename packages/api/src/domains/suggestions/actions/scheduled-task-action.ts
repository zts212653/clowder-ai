import { DEVELOPMENT_RETURN_TEMPLATE_ID } from '@cat-cafe/shared';
import { z } from 'zod';
import type { DynamicTaskDef, DynamicTaskStore } from '../../../infrastructure/scheduler/DynamicTaskStore.js';
import { isF255ConfigOnlyTemplate } from '../../../infrastructure/scheduler/f255-template-boundary.js';
import { fingerprintDynamicTaskDef } from '../../../infrastructure/scheduler/mutations/schedule-mutation-storage.js';
import type { TriggerSpec } from '../../../infrastructure/scheduler/types.js';
import {
  commitOwnerDynamicTask,
  type OwnerScheduleCommitDeps,
  removeOwnerDynamicTask,
} from '../../../routes/schedule-owner-commit.js';
import {
  normalizeOnceTrigger,
  normalizeScheduleTargetParam,
  type ScheduleRoutesOptions,
  toPlainScheduleParams,
} from '../../../routes/schedule-route-support.js';
import { ENTRUSTED_WORK_REEVALUATION_TEMPLATE_ID } from '../../growing/ProducerAttentionReevaluationTaskSpec.js';
import type {
  SuggestionActionContext,
  SuggestionActionHandler,
  SuggestionActionResult,
} from '../suggestion-actions.js';

export const SCHEDULED_TASK_SUGGESTION_KIND = 'scheduled-task';

/** The same fields as `cat_cafe_register_scheduled_task`, as objects; the delivery thread is the conversation itself. */
const paramsSchema = z
  .object({
    templateId: z.string().trim().min(1).max(120),
    trigger: z.record(z.string(), z.unknown()),
    params: z.record(z.string(), z.unknown()).optional(),
    label: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(40).optional(),
    description: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
type ScheduledTaskParams = z.infer<typeof paramsSchema>;

/** Templates with their own typed owner flows never come through a one-tap suggestion. */
const RESERVED_TEMPLATES = new Set([DEVELOPMENT_RETURN_TEMPLATE_ID, ENTRUSTED_WORK_REEVALUATION_TEMPLATE_ID]);

export interface ScheduledTaskSuggestionDeps {
  ownerUserId?: string;
  templateRegistry?: ScheduleRoutesOptions['templateRegistry'];
  packTemplateStore?: ScheduleRoutesOptions['packTemplateStore'];
  dynamicTaskStore?: DynamicTaskStore;
  commit?: OwnerScheduleCommitDeps;
}

const fail = <T>(error: string): SuggestionActionResult<T> => ({ ok: false, error });

function taskIdOf(ref: Record<string, unknown>): string | null {
  return typeof ref.taskId === 'string' && ref.taskId.startsWith('dyn-') ? ref.taskId : null;
}

/**
 * 「创建定时任务」：猫拟好任务，人点一下就是人自己创建（立即生效，不再出一张待批卡）；撤销就是人自己删除。
 * 「改了」= 任务被人改过或删掉（按任务指纹比对）。
 */
export function createScheduledTaskSuggestionAction(deps: ScheduledTaskSuggestionDeps): SuggestionActionHandler {
  function checkTask(parsed: ScheduledTaskParams): SuggestionActionResult<ScheduledTaskParams> {
    const { templateId, trigger, params } = parsed;
    if (RESERVED_TEMPLATES.has(templateId) || isF255ConfigOnlyTemplate(templateId, deps.packTemplateStore)) {
      return fail('This template has its own owner flow');
    }
    if (!deps.templateRegistry?.get(templateId)) return fail(`Unknown template: ${templateId}`);
    const normalized = normalizeOnceTrigger(trigger);
    if ('error' in normalized) return fail(normalized.error);
    const plain = toPlainScheduleParams(params ?? {});
    if (!plain) return fail('params must be a plain object');
    const target = normalizeScheduleTargetParam(plain);
    if (!target.ok) return fail('Unknown target cat in params');
    return { ok: true, value: { ...parsed, params: target.params } };
  }

  function check(
    ctx: SuggestionActionContext,
    raw: Record<string, unknown>,
  ): SuggestionActionResult<ScheduledTaskParams> {
    if (!deps.ownerUserId || !deps.templateRegistry || !deps.dynamicTaskStore || !deps.commit) {
      return fail('Scheduled tasks are not available here');
    }
    if (ctx.userId !== deps.ownerUserId) return fail('Scheduled tasks belong to the configured owner');
    const parsed = paramsSchema.safeParse(raw);
    if (!parsed.success) return fail(`Invalid scheduled task: ${parsed.error.issues[0]?.message ?? 'bad params'}`);
    return checkTask(parsed.data);
  }

  return {
    kind: SCHEDULED_TASK_SUGGESTION_KIND,
    kindLabel: '创建定时任务',
    undoLabel: 'undo',

    async prepare(ctx, raw) {
      // A relative once-trigger (`delayMs`) keeps counting from the tap, not from when the cat offered it.
      const checked = check(ctx, raw);
      return checked.ok ? { ok: true, value: checked.value } : checked;
    },

    async apply(ctx, raw) {
      const checked = check(ctx, raw);
      if (!checked.ok) return checked;
      const { templateRegistry, dynamicTaskStore, commit, ownerUserId } = deps;
      const template = templateRegistry?.get(checked.value.templateId);
      if (!template || !dynamicTaskStore || !commit || !ownerUserId) return fail('Scheduled tasks are not available');
      const id = `dyn-sugg-${ctx.suggestionId}-${ctx.attempt ?? 1}`;
      const existing = dynamicTaskStore.getById(id);
      if (!existing) {
        const trigger = normalizeOnceTrigger(checked.value.trigger) as TriggerSpec;
        const def: DynamicTaskDef = {
          id,
          templateId: checked.value.templateId,
          trigger,
          params: { ...(checked.value.params ?? {}), triggerUserId: ctx.userId },
          display: {
            label: checked.value.label ?? template.label,
            category: (checked.value.category ?? template.category) as DynamicTaskDef['display']['category'],
            description: checked.value.description ?? template.description,
          },
          deliveryThreadId: ctx.threadId,
          enabled: true,
          createdBy: 'user',
          createdAt: new Date().toISOString(),
        };
        commitOwnerDynamicTask(commit, {
          ownerUserId,
          principal: { kind: 'cvo', userId: ctx.userId },
          template,
          def,
        });
      }
      const stored = dynamicTaskStore.getById(id);
      if (!stored) return fail('The scheduled task was not saved');
      return {
        ok: true,
        value: {
          appliedRef: { taskId: id, fingerprint: fingerprintDynamicTaskDef(stored) },
          receipt: {
            text: `已创建定时任务「${stored.display.label}」`,
            open: { kind: 'workspace-mode', mode: 'schedule' },
          },
        },
      };
    },

    async undo(ctx, ref) {
      const taskId = taskIdOf(ref);
      if (!taskId || !deps.dynamicTaskStore || !deps.commit || !deps.ownerUserId) return fail('Nothing to undo');
      const def = deps.dynamicTaskStore.getById(taskId);
      // Already deleted by the person: undoing has nothing left to do.
      if (!def) return { ok: true, value: undefined };
      removeOwnerDynamicTask(deps.commit, {
        ownerUserId: deps.ownerUserId,
        principal: { kind: 'cvo', userId: ctx.userId },
        def,
      });
      return { ok: true, value: undefined };
    },

    async inspect(_ctx, ref) {
      const taskId = taskIdOf(ref);
      if (!taskId || !deps.dynamicTaskStore) return 'unknown';
      const def = deps.dynamicTaskStore.getById(taskId);
      if (!def) return 'gone';
      return fingerprintDynamicTaskDef(def) === ref.fingerprint ? 'intact' : 'edited';
    },

    /** A cat's own receipt may undo only a task it registered for this conversation. */
    async verifyReceipt(ctx, ref) {
      const taskId = taskIdOf(ref);
      const def = taskId ? deps.dynamicTaskStore?.getById(taskId) : null;
      return Boolean(def && def.createdBy === ctx.catId && def.deliveryThreadId === ctx.threadId);
    },
  };
}
