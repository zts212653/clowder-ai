import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { EntrustedWorkLifecycleService } from '../src/domains/growing/EntrustedWorkLifecycleService.js';

test('permission lost during completion-artifact reading prevents the canonical Task close write', async () => {
  const store = new TaskStore();
  let current = true;
  const lifecycle = new EntrustedWorkLifecycleService(store, {
    artifactReader: {
      readPreparedArtifact: async () => {
        current = false;
        return null;
      },
    },
  });
  const admission = await lifecycle.admitOrResume({
    task: {
      userId: 'owner',
      threadId: 'home',
      title: 'Owned comparison',
      why: 'Explicit request',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:owner-request'],
      intendedOutcome: 'Reviewable comparison',
      idempotencyKey: 'owner-request',
    },
    closure: { condition: 'Reviewable comparison', expectedSignal: 'artifact:result' },
    artifactRefs: ['artifact:result'],
  });
  assert.notEqual(admission.result, 'needs_clarification');
  if (admission.result === 'needs_clarification') return;
  const taskId = admission.ownerRef.slice('task:item:'.length);
  await assert.rejects(
    lifecycle.close(
      {
        taskId,
        expectedRevision: 1,
        closure: {
          state: 'satisfied',
          condition: 'Reviewable comparison',
          expectedSignal: 'artifact:result',
          evidenceRefs: ['artifact:result'],
        },
      },
      async () => {
        if (!current) throw new Error('Live revoked');
      },
    ),
    /Live revoked/,
  );
  assert.notEqual(store.get(taskId)?.status, 'done');
});
