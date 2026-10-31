import { createTypedWaitRegistration } from '../../dist/domains/ball-custody/TypedWaitRegistration.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';

export async function createTypedWaitCustodyFixture(options = {}) {
  const store = options.messageStore ?? new MessageStore();
  const taskStore = options.taskStore ?? new TaskStore();
  const message = await store.append({
    from: { kind: 'system', service: 'hold-ball' },
    threadId: 'thread-wait',
    userId: 'user-1',
    content: 'Command result',
    mentions: ['opus'],
    timestamp: Date.now(),
    source: {
      connector: 'hold-ball',
      label: 'command',
      icon: 'hold-ball',
      meta: {
        wakeWhen: true,
        managedHold: true,
        phase: 'wake',
        taskId: 'hold-1',
        threadId: 'thread-wait',
        catId: 'opus',
      },
    },
  });
  const task = await taskStore.create({
    kind: 'work',

    threadId: 'thread-wait',
    title: 'CI',
    userId: 'user-1',
    ownerCatId: 'opus',
    createdBy: 'opus',
  });
  const active = {
    v: 1,
    generation: 1,
    subjectRef: 'deployment:abc123def456:runtime',
    ownerFence: { kind: 'containing_task', generation: 1 },
    baseline: { capturedAt: Date.now(), bootSequence: 1, bootId: 'boot-1' },
    continuation: {
      when: [{ kind: 'new_ready_boot', services: ['api'] }],
      // biome-ignore lint/suspicious/noThenProperty: F280 frozen continuation field.
      then: 'Verify the new runtime.',
    },
    createdAt: Date.now(),
    autoRenew: false,
  };
  const receipt = createTypedWaitRegistration({
    task,
    active,
    invocationId: 'child-1',
    source: { kind: 'primary', sourceMessageId: message.id, holdTaskId: 'hold-1' },
  });
  await taskStore.replaceDeploymentWaitIfGeneration(task.id, {
    expectedGeneration: null,
    expectedDeploymentWait: undefined,
    deploymentWait: { await: active },
    waitRegistration: receipt,
  });
  return { store, taskStore, task, active, receipt, message };
}
