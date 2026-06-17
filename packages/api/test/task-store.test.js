import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');

describe('TaskStore', () => {
  /** @type {InstanceType<typeof TaskStore>} */
  let store;

  beforeEach(() => {
    store = new TaskStore({ maxTasks: 5 });
  });

  const makeInput = (overrides = {}) => ({
    threadId: 'thread-1',
    title: '重构 AgentRouter',
    why: '超过 200 行了',
    createdBy: 'opus',
    ...overrides,
  });

  describe('create + get', () => {
    it('creates a task with correct defaults', () => {
      const task = store.create(makeInput());
      assert.ok(task.id);
      assert.equal(task.threadId, 'thread-1');
      assert.equal(task.title, '重构 AgentRouter');
      assert.equal(task.why, '超过 200 行了');
      assert.equal(task.createdBy, 'opus');
      assert.equal(task.status, 'todo');
      assert.equal(task.ownerCatId, null);
      assert.ok(task.createdAt > 0);
      assert.ok(task.updatedAt > 0);
    });

    it('retrieves a created task by id', () => {
      const task = store.create(makeInput());
      const retrieved = store.get(task.id);
      assert.deepEqual(retrieved, task);
    });

    it('returns null for nonexistent id', () => {
      assert.equal(store.get('nonexistent'), null);
    });

    it('creates task with explicit ownerCatId', () => {
      const task = store.create(makeInput({ ownerCatId: 'codex' }));
      assert.equal(task.ownerCatId, 'codex');
    });
  });

  describe('update', () => {
    it('updates status', () => {
      const task = store.create(makeInput());
      const updated = store.update(task.id, { status: 'doing' });
      assert.equal(updated.status, 'doing');
    });

    it('updates ownerCatId', () => {
      const task = store.create(makeInput());
      const updated = store.update(task.id, { ownerCatId: 'gemini' });
      assert.equal(updated.ownerCatId, 'gemini');
    });

    it('updates title and why', () => {
      const task = store.create(makeInput());
      const updated = store.update(task.id, { title: '新标题', why: '新原因' });
      assert.equal(updated.title, '新标题');
      assert.equal(updated.why, '新原因');
    });

    it('updates updatedAt automatically', async () => {
      const task = store.create(makeInput());
      const originalUpdatedAt = task.updatedAt;
      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 5));
      const updated = store.update(task.id, { status: 'done' });
      assert.ok(updated.updatedAt > originalUpdatedAt);
    });

    it('returns null for nonexistent task', () => {
      assert.equal(store.update('nonexistent', { status: 'done' }), null);
    });

    it('preserves unchanged fields', () => {
      const task = store.create(makeInput({ ownerCatId: 'opus' }));
      const updated = store.update(task.id, { status: 'doing' });
      assert.equal(updated.ownerCatId, 'opus');
      assert.equal(updated.title, '重构 AgentRouter');
    });
  });

  describe('listByThread', () => {
    it('returns tasks for a specific thread', () => {
      store.create(makeInput({ threadId: 'thread-1' }));
      store.create(makeInput({ threadId: 'thread-2' }));
      store.create(makeInput({ threadId: 'thread-1', title: '第二个任务' }));

      const list = store.listByThread('thread-1');
      assert.equal(list.length, 2);
      assert.ok(list.every((t) => t.threadId === 'thread-1'));
    });

    it('returns empty array for unknown thread', () => {
      const list = store.listByThread('nonexistent');
      assert.deepEqual(list, []);
    });

    it('returns tasks in sortable ID order (ascending)', () => {
      const t1 = store.create(makeInput({ title: 'First' }));
      const t2 = store.create(makeInput({ title: 'Second' }));
      const list = store.listByThread('thread-1');
      assert.equal(list[0].id, t1.id);
      assert.equal(list[1].id, t2.id);
    });
  });

  describe('upsertBySubject', () => {
    it('re-registering a done pr_tracking task resets it back to todo', () => {
      const original = store.upsertBySubject(
        makeInput({
          kind: 'pr_tracking',
          subjectKey: 'pr:owner/repo#42',
          title: 'PR tracking: owner/repo#42',
        }),
      );
      store.update(original.id, { status: 'done' });

      const reopened = store.upsertBySubject(
        makeInput({
          kind: 'pr_tracking',
          subjectKey: 'pr:owner/repo#42',
          threadId: 'thread-2',
          title: 'PR tracking: owner/repo#42 (reopened)',
        }),
      );

      assert.equal(reopened.id, original.id);
      assert.equal(reopened.threadId, 'thread-2');
      assert.equal(reopened.status, 'todo');
    });

    it('rejects cross-thread claims of legacy subject tasks when caller has a userId', () => {
      const original = store.create(
        makeInput({
          kind: 'pr_tracking',
          subjectKey: 'pr:owner/repo#43',
          threadId: 'thread-owner',
          title: 'Legacy PR tracking',
          ownerCatId: 'opus',
        }),
      );

      assert.throws(
        () =>
          store.upsertBySubject(
            makeInput({
              kind: 'pr_tracking',
              subjectKey: 'pr:owner/repo#43',
              threadId: 'thread-attacker',
              title: 'Hijacked PR tracking',
              ownerCatId: 'codex',
              userId: 'user-attacker',
            }),
          ),
        /already owned by another user/,
      );

      const entry = store.getBySubject('pr:owner/repo#43');
      assert.equal(entry.id, original.id);
      assert.equal(entry.threadId, 'thread-owner');
      assert.equal(entry.ownerCatId, 'opus');
      assert.equal(entry.userId, undefined);
    });
  });

  describe('delete', () => {
    it('deletes an existing task', () => {
      const task = store.create(makeInput());
      assert.equal(store.delete(task.id), true);
      assert.equal(store.get(task.id), null);
    });

    it('returns false for nonexistent task', () => {
      assert.equal(store.delete('nonexistent'), false);
    });
  });

  describe('capacity limit', () => {
    it('evicts done tasks when at capacity', () => {
      // Fill to capacity (maxTasks=5)
      const tasks = [];
      for (let i = 0; i < 5; i++) {
        tasks.push(store.create(makeInput({ title: `task-${i}` })));
      }
      // Mark first two as done
      store.update(tasks[0].id, { status: 'done' });
      store.update(tasks[1].id, { status: 'done' });

      // Creating a new task should evict a done task
      store.create(makeInput({ title: 'new-task' }));
      assert.equal(store.size, 5);
      // First done task should be evicted
      assert.equal(store.get(tasks[0].id), null);
    });

    it('does not evict active pr_tracking tasks during fallback oldest-task eviction', () => {
      const tracker = store.upsertBySubject(
        makeInput({
          kind: 'pr_tracking',
          subjectKey: 'pr:owner/repo#99',
          title: 'Track owner/repo#99',
        }),
      );
      const workTasks = [];
      for (let i = 0; i < 4; i++) {
        workTasks.push(store.create(makeInput({ title: `task-${i}` })));
      }

      store.create(makeInput({ title: 'new-task' }));

      assert.equal(store.size, 5);
      assert.equal(store.get(tracker.id)?.id, tracker.id);
      assert.equal(store.getBySubject('pr:owner/repo#99')?.id, tracker.id);
      assert.equal(store.get(workTasks[0].id), null);
    });

    it('preserves the task cap when every stored task is an active pr_tracking task', () => {
      const trackers = [];
      for (let i = 0; i < 5; i++) {
        trackers.push(
          store.upsertBySubject(
            makeInput({
              kind: 'pr_tracking',
              subjectKey: `pr:owner/repo#${i}`,
              title: `Track owner/repo#${i}`,
            }),
          ),
        );
      }

      const replacement = store.upsertBySubject(
        makeInput({
          kind: 'pr_tracking',
          subjectKey: 'pr:owner/repo#999',
          title: 'Track owner/repo#999',
        }),
      );

      assert.equal(store.size, 5);
      assert.equal(store.get(trackers[0].id), null);
      assert.equal(store.getBySubject('pr:owner/repo#0'), null);
      assert.equal(store.get(replacement.id)?.id, replacement.id);
      assert.equal(store.getBySubject('pr:owner/repo#999')?.id, replacement.id);
    });

    it('evicts oldest task if no done tasks available', () => {
      // Fill to capacity (all todo)
      const tasks = [];
      for (let i = 0; i < 5; i++) {
        tasks.push(store.create(makeInput({ title: `task-${i}` })));
      }

      // Creating a new task should evict the oldest
      store.create(makeInput({ title: 'new-task' }));
      assert.equal(store.size, 5);
      assert.equal(store.get(tasks[0].id), null);
    });
  });

  // --- F193 Phase E: dispatch gate ---

  describe('dispatch gate (F193-E1)', () => {
    it('persists relatedFeatureId when provided', () => {
      const task = store.create(makeInput({ relatedFeatureId: 'F193' }));
      assert.equal(task.relatedFeatureId, 'F193');
      const retrieved = store.get(task.id);
      assert.equal(retrieved.relatedFeatureId, 'F193');
    });

    it('persists detectedFeatureIds when provided', () => {
      const task = store.create(makeInput({ detectedFeatureIds: ['F128', 'F193'] }));
      assert.deepStrictEqual(task.detectedFeatureIds, ['F128', 'F193']);
    });

    it('persists dispatchGate with status missing', () => {
      const gate = {
        status: 'missing',
        suggestedAction: {
          type: 'cross_post',
          featureId: 'F193',
          reason: 'Task references F193',
          source: 'dispatch_gate',
        },
      };
      const task = store.create(makeInput({ dispatchGate: gate }));
      assert.equal(task.dispatchGate.status, 'missing');
      assert.equal(task.dispatchGate.suggestedAction.featureId, 'F193');
      assert.equal(task.dispatchGate.suggestedAction.source, 'dispatch_gate');
    });

    it('persists dispatchGate with status dispatched', () => {
      const gate = {
        status: 'dispatched',
        dispatchedThreadId: 'thread_f193',
        dispatchedMessageId: 'msg-123',
        decidedAt: Date.now(),
      };
      const task = store.create(makeInput({ dispatchGate: gate }));
      assert.equal(task.dispatchGate.status, 'dispatched');
      assert.equal(task.dispatchGate.dispatchedThreadId, 'thread_f193');
    });

    it('persists dispatchGate with status not_dispatched + reason', () => {
      const gate = {
        status: 'not_dispatched',
        reason: 'Will fix in this thread as part of current scope',
        decidedAt: Date.now(),
      };
      const task = store.create(makeInput({ dispatchGate: gate }));
      assert.equal(task.dispatchGate.status, 'not_dispatched');
      assert.equal(task.dispatchGate.reason, 'Will fix in this thread as part of current scope');
    });

    it('omits dispatch gate fields when not provided', () => {
      const task = store.create(makeInput());
      assert.equal(task.relatedFeatureId, undefined);
      assert.equal(task.detectedFeatureIds, undefined);
      assert.equal(task.dispatchGate, undefined);
    });
  });

  describe('patchAutomationState: issue cursor anti-regression (Cloud R19 P2)', () => {
    it('re-patching with stale cursor seeds does NOT lower existing issue lastCommentCursor or lastDeliveredCursor', () => {
      // Simulate: task seeded with high cursors (normal operation, 100 comments processed)
      const task = store.create(
        makeInput({
          kind: 'issue_tracking',
          subjectKey: 'issue:owner/repo#10',
          title: 'Track owner/repo#10',
        }),
      );
      // First patch: set cursors to high values (as if 100 comments processed)
      store.patchAutomationState(task.id, {
        issue: { lastCommentCursor: 100, lastDeliveredCursor: 90 },
      });

      // Second patch: re-route with stale seed (lastCommentCursor=0, lastDeliveredCursor=0)
      // This simulates duplicate case routing in dev/test with no-Redis fallback
      store.patchAutomationState(task.id, {
        issue: { lastCommentCursor: 0, lastDeliveredCursor: 0 },
      });

      const updated = store.get(task.id);
      // Cursors must NOT be lowered — shallow spread `{ ...existing, ...patch }` would lower them to 0
      assert.equal(
        updated.automationState?.issue?.lastCommentCursor,
        100,
        'lastCommentCursor must not be lowered by stale re-patch',
      );
      assert.equal(
        updated.automationState?.issue?.lastDeliveredCursor,
        90,
        'lastDeliveredCursor must not be lowered by stale re-patch',
      );
    });
  });
});
