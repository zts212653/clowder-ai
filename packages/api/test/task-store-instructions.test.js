import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');

describe('F202 Phase 2C: issue-only trackingInstructions compatibility', () => {
  test('upsertBySubject stores trackingInstructions in automationState', () => {
    const store = new TaskStore();
    const task = store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:owner/repo#1',
      title: 'Issue tracking: owner/repo#1',
      why: 'Tracking issue',
      createdBy: 'cat1',
      automationState: { trackingInstructions: 'Fix CI then merge' },
    });
    assert.strictEqual(task.automationState?.trackingInstructions, 'Fix CI then merge');
  });

  test('upsertBySubject preserves trackingInstructions on re-upsert without it', () => {
    const store = new TaskStore();
    store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:owner/repo#2',
      title: 'Issue tracking',
      why: 'test',
      createdBy: 'cat1',
      automationState: { trackingInstructions: 'Original instructions' },
    });

    // Re-upsert without automationState — should preserve existing instructions
    const updated = store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:owner/repo#2',
      title: 'Issue tracking updated',
      why: 'test',
      createdBy: 'cat1',
    });
    assert.strictEqual(updated.automationState?.trackingInstructions, 'Original instructions');
  });

  test('patchAutomationState can update trackingInstructions', () => {
    const store = new TaskStore();
    const task = store.create({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:owner/repo#3',
      title: 'test',
      why: 'test',
      createdBy: 'cat1',
    });
    const patched = store.patchAutomationState(task.id, {
      trackingInstructions: 'New instructions',
    });
    assert.strictEqual(patched?.automationState?.trackingInstructions, 'New instructions');
  });
});
