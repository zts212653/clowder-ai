import type { ScheduleMutationTaskDefinition } from '@cat-cafe/shared';
import type { TaskTemplate } from '../infrastructure/scheduler/templates/types.js';
import type { TaskSpec_P1 } from '../infrastructure/scheduler/types.js';

export function buildUpdatedScheduleSpec(
  task: ScheduleMutationTaskDefinition,
  params: Record<string, unknown>,
  registry: { get(id: string): TaskTemplate | null },
): TaskSpec_P1 {
  if (task.trigger.type !== 'interval' && task.trigger.type !== 'cron') {
    throw new TypeError('Parameter updates require an existing recurring task');
  }
  const template = registry.get(task.templateId);
  if (!template) throw new TypeError(`Template ${task.templateId} is unavailable`);
  const keys = new Set([...Object.keys(task.params), ...Object.keys(params)]);
  for (const key of keys) {
    if (JSON.stringify(task.params[key]) !== JSON.stringify(params[key]) && !Object.hasOwn(template.paramSchema, key)) {
      throw new TypeError(`Parameter ${key} is not editable through this template`);
    }
  }
  for (const [key, schema] of Object.entries(template.paramSchema)) {
    const value = params[key];
    if (value === undefined) {
      if (schema.required) throw new TypeError(`Missing required parameter: ${key}`);
      continue;
    }
    if (typeof value !== schema.type || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new TypeError(`Parameter ${key} must be a ${schema.type}`);
    }
    if (schema.required && typeof value === 'string' && value.trim() === '') {
      throw new TypeError(`Parameter ${key} must not be empty`);
    }
    if (schema.enum && !schema.enum.some((allowed) => allowed === value)) {
      throw new TypeError(`Parameter ${key} must be one of: ${schema.enum.join(', ')}`);
    }
  }
  const spec = template.createSpec(task.id, {
    trigger: task.trigger,
    params,
    deliveryThreadId: task.deliveryThreadId,
    ...(task.entrustedWorkReevaluation ? { entrustedWorkReevaluation: task.entrustedWorkReevaluation } : {}),
  });
  if (spec.id !== task.id || JSON.stringify(spec.trigger) !== JSON.stringify(task.trigger)) {
    throw new TypeError('Parameter updates cannot change task identity or trigger');
  }
  spec.display = task.display;
  return spec;
}
