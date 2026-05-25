import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dryRunLegacyTaskCleanup,
  inventoryLegacyTasks,
} from '../../dist/infrastructure/harness-eval/legacy-task-cleanup.js';

const a2aDomain = {
  domainId: 'eval:a2a',
  displayName: 'A2A Harness Eval',
  systemThreadId: 'thread_eval_a2a',
  evalCat: { catId: 'codex', handle: '@codex', model: 'gpt-5.5' },
  frequency: 'daily',
  sourceAdapter: 'f167-runtime-eval',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: ['harness-fit-digest'],
  handoffTargetResolver: { featureId: 'F167', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 24, reevalWithinHours: 72 },
};

const memoryDomain = {
  domainId: 'eval:memory',
  displayName: 'Memory Recall & Library Health Eval',
  systemThreadId: 'thread_eval_memory',
  evalCat: { catId: 'opus47', handle: '@opus47', model: 'claude-opus-4-7' },
  frequency: 'daily',
  sourceAdapter: 'f200-f188-memory-eval',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: ['memory-recall-digest'],
  handoffTargetResolver: { featureId: 'F200', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
};

const legacyTask = {
  id: 'harness-fit-digest',
  templateId: 'harness-fit-digest',
  enabled: true,
  trigger: { type: 'cron', expression: '0 9 * * *' },
  display: { label: 'Harness Fit Digest' },
};

describe('legacy scheduled-task cleanup dry-run', () => {
  it('identifies harness-fit-digest as eval:a2a legacy task', () => {
    const inventory = inventoryLegacyTasks(a2aDomain, [legacyTask]);

    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].id, 'harness-fit-digest');
  });

  it('returns redirect/disable action without mutating tasks', () => {
    const task = { ...legacyTask, enabled: true };
    const result = dryRunLegacyTaskCleanup(a2aDomain, [task], { newRuntimeEnabled: true });

    assert.equal(task.enabled, true);
    assert.equal(result.actions[0].taskId, 'harness-fit-digest');
    assert.equal(result.actions[0].mode, 'redirect');
    assert.equal(result.mutated, false);
    assert.ok(result.rollbackRecords.length > 0);
  });

  it('marks migration unsafe if legacy and new runtime would both fire', () => {
    const result = dryRunLegacyTaskCleanup(a2aDomain, [legacyTask], {
      newRuntimeEnabled: true,
      proposedAction: 'retain',
    });

    assert.equal(result.safeToApply, false);
    assert.match(result.risks.join('\n'), /double trigger/);
  });

  it('marks migration unsafe if cleanup would remove the only enabled eval runtime', () => {
    const result = dryRunLegacyTaskCleanup(a2aDomain, [legacyTask], { newRuntimeEnabled: false });

    assert.equal(result.actions[0].mode, 'redirect');
    assert.equal(result.safeToApply, false);
    assert.match(result.risks.join('\n'), /new eval runtime is disabled/);
  });

  it('keeps disabled new-runtime cleanup safe when legacy task is intentionally retained', () => {
    const result = dryRunLegacyTaskCleanup(a2aDomain, [legacyTask], {
      newRuntimeEnabled: false,
      proposedAction: 'retain',
    });

    assert.equal(result.actions[0].mode, 'none');
    assert.equal(result.safeToApply, true);
  });

  it('marks migration unsafe if no evaluator would remain active', () => {
    const result = dryRunLegacyTaskCleanup(a2aDomain, [{ ...legacyTask, enabled: false }], {
      newRuntimeEnabled: false,
    });

    assert.equal(result.actions[0].mode, 'none');
    assert.equal(result.safeToApply, false);
    assert.match(result.risks.join('\n'), /no active evaluator/);
  });

  it('is safe when legacy task is already disabled', () => {
    const result = dryRunLegacyTaskCleanup(a2aDomain, [{ ...legacyTask, enabled: false }], { newRuntimeEnabled: true });

    assert.equal(result.safeToApply, true);
    assert.equal(result.actions[0].mode, 'none');
  });

  it('identifies memory-recall-digest as eval:memory legacy task', () => {
    const memoryTask = {
      id: 'memory-recall-digest',
      templateId: 'memory-recall-digest',
      enabled: true,
      trigger: { type: 'cron', expression: '0 6 * * 1' },
      display: { label: 'Memory Recall Digest' },
    };
    const unrelatedTask = {
      id: 'daily-backup',
      templateId: 'daily-backup',
      enabled: true,
      trigger: { type: 'cron', expression: '0 2 * * *' },
      display: { label: 'Daily Backup' },
    };

    const inventory = inventoryLegacyTasks(memoryDomain, [memoryTask, unrelatedTask]);
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].id, 'memory-recall-digest');
  });

  it('proposes redirect for eval:memory legacy tasks when new runtime is enabled', () => {
    const memoryTask = {
      id: 'memory-recall-digest',
      templateId: 'memory-recall-digest',
      enabled: true,
      trigger: { type: 'cron', expression: '0 6 * * 1' },
      display: { label: 'Memory Recall Digest' },
    };
    const result = dryRunLegacyTaskCleanup(memoryDomain, [memoryTask], { newRuntimeEnabled: true });

    assert.equal(result.actions[0].taskId, 'memory-recall-digest');
    assert.equal(result.actions[0].mode, 'redirect');
    assert.equal(result.mutated, false);
    assert.ok(result.safeToApply);
  });

  it('detects double-trigger risk for eval:memory when retain + new runtime both active', () => {
    const memoryTask = {
      id: 'memory-recall-digest',
      templateId: 'memory-recall-digest',
      enabled: true,
      trigger: { type: 'cron', expression: '0 6 * * 1' },
      display: { label: 'Memory Recall Digest' },
    };
    const result = dryRunLegacyTaskCleanup(memoryDomain, [memoryTask], {
      newRuntimeEnabled: true,
      proposedAction: 'retain',
    });

    assert.equal(result.safeToApply, false);
    assert.match(result.risks.join('\n'), /double trigger/);
  });
});
