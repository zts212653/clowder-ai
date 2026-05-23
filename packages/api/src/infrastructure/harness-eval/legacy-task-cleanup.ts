import { type EvalDomainRegistryEntry, parseEvalDomainRegistryEntry } from './eval-domain-registry.js';

export interface LegacyScheduledTaskLike {
  id: string;
  templateId: string;
  enabled: boolean;
  trigger?: unknown;
  display?: { label?: string };
}

export interface CleanupOptions {
  newRuntimeEnabled: boolean;
  proposedAction?: 'redirect' | 'disable' | 'retain';
}

export interface LegacyCleanupAction {
  taskId: string;
  mode: 'redirect' | 'disable' | 'none';
  reason: string;
}

export interface LegacyCleanupDryRun {
  domainId: EvalDomainRegistryEntry['domainId'];
  foundTasks: LegacyScheduledTaskLike[];
  actions: LegacyCleanupAction[];
  rollbackRecords: string[];
  risks: string[];
  safeToApply: boolean;
  mutated: false;
}

export function inventoryLegacyTasks(
  domainInput: EvalDomainRegistryEntry,
  tasks: LegacyScheduledTaskLike[],
): LegacyScheduledTaskLike[] {
  const domain = parseEvalDomainRegistryEntry(domainInput);
  const legacyIds = new Set(domain.legacyScheduledTaskIds);
  return tasks.filter((task) => legacyIds.has(task.id) || legacyIds.has(task.templateId));
}

export function dryRunLegacyTaskCleanup(
  domainInput: EvalDomainRegistryEntry,
  tasks: LegacyScheduledTaskLike[],
  options: CleanupOptions,
): LegacyCleanupDryRun {
  const domain = parseEvalDomainRegistryEntry(domainInput);
  const foundTasks = inventoryLegacyTasks(domain, tasks);
  const preferredAction = options.proposedAction ?? 'redirect';
  const actions: LegacyCleanupAction[] = foundTasks.map((task) => {
    if (!task.enabled) {
      return { taskId: task.id, mode: 'none', reason: 'legacy task is already disabled' };
    }
    if (preferredAction === 'disable') {
      return { taskId: task.id, mode: 'disable', reason: 'new eval runtime replaces the legacy task' };
    }
    if (preferredAction === 'retain') {
      return { taskId: task.id, mode: 'none', reason: 'legacy task intentionally retained by dry-run request' };
    }
    return { taskId: task.id, mode: 'redirect', reason: 'legacy task should route through unified eval runtime' };
  });

  const risks: string[] = [];
  if (
    options.newRuntimeEnabled &&
    foundTasks.some((task) => task.enabled) &&
    actions.every((action) => action.mode === 'none')
  ) {
    risks.push('double trigger risk: enabled legacy task and new eval runtime would both fire');
  }
  if (!options.newRuntimeEnabled && actions.some((action) => action.mode !== 'none')) {
    risks.push('no evaluator risk: new eval runtime is disabled and legacy task cleanup would remove the fallback');
  }
  if (!options.newRuntimeEnabled && !foundTasks.some((task) => task.enabled)) {
    risks.push('no active evaluator risk: new eval runtime is disabled and no enabled legacy task exists');
  }

  return {
    domainId: domain.domainId,
    foundTasks,
    actions,
    rollbackRecords: foundTasks.map((task) => `restore ${task.id} enabled=${task.enabled}`),
    risks,
    safeToApply: risks.length === 0,
    mutated: false,
  };
}
