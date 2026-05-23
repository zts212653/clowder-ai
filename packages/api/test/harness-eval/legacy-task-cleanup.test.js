import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dryRunLegacyTaskCleanup,
  inventoryLegacyTasks,
} from '../../dist/infrastructure/harness-eval/legacy-task-cleanup.js';

const domain = {
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

const legacyTask = {
  id: 'harness-fit-digest',
  templateId: 'harness-fit-digest',
  enabled: true,
  trigger: { type: 'cron', expression: '0 9 * * *' },
  display: { label: 'Harness Fit Digest' },
};

describe('legacy scheduled-task cleanup dry-run', () => {
  it('identifies harness-fit-digest as eval:a2a legacy task', () => {
    const inventory = inventoryLegacyTasks(domain, [legacyTask]);

    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].id, 'harness-fit-digest');
  });

  it('returns redirect/disable action without mutating tasks', () => {
    const task = { ...legacyTask, enabled: true };
    const result = dryRunLegacyTaskCleanup(domain, [task], { newRuntimeEnabled: true });

    assert.equal(task.enabled, true);
    assert.equal(result.actions[0].taskId, 'harness-fit-digest');
    assert.equal(result.actions[0].mode, 'redirect');
    assert.equal(result.mutated, false);
    assert.ok(result.rollbackRecords.length > 0);
  });

  it('marks migration unsafe if legacy and new runtime would both fire', () => {
    const result = dryRunLegacyTaskCleanup(domain, [legacyTask], { newRuntimeEnabled: true, proposedAction: 'retain' });

    assert.equal(result.safeToApply, false);
    assert.match(result.risks.join('\n'), /double trigger/);
  });

  it('marks migration unsafe if cleanup would remove the only enabled eval runtime', () => {
    const result = dryRunLegacyTaskCleanup(domain, [legacyTask], { newRuntimeEnabled: false });

    assert.equal(result.actions[0].mode, 'redirect');
    assert.equal(result.safeToApply, false);
    assert.match(result.risks.join('\n'), /new eval runtime is disabled/);
  });

  it('keeps disabled new-runtime cleanup safe when legacy task is intentionally retained', () => {
    const result = dryRunLegacyTaskCleanup(domain, [legacyTask], {
      newRuntimeEnabled: false,
      proposedAction: 'retain',
    });

    assert.equal(result.actions[0].mode, 'none');
    assert.equal(result.safeToApply, true);
  });

  it('marks migration unsafe if no evaluator would remain active', () => {
    const result = dryRunLegacyTaskCleanup(domain, [{ ...legacyTask, enabled: false }], {
      newRuntimeEnabled: false,
    });

    assert.equal(result.actions[0].mode, 'none');
    assert.equal(result.safeToApply, false);
    assert.match(result.risks.join('\n'), /no active evaluator/);
  });

  it('is safe when legacy task is already disabled', () => {
    const result = dryRunLegacyTaskCleanup(domain, [{ ...legacyTask, enabled: false }], { newRuntimeEnabled: true });

    assert.equal(result.safeToApply, true);
    assert.equal(result.actions[0].mode, 'none');
  });
});
