import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { PersistedQueueDelivery } from '../../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { createDeliverFn } from '../../dist/infrastructure/scheduler/delivery.js';
import { createAlphaBrowserTemplate } from '../../dist/infrastructure/scheduler/templates/alpha-browser.js';
import { fixture } from './alpha-browser-template-fixture.js';

export function incidentFixture(stores = {}) {
  const f = fixture();
  const tasks = stores.tasks ?? new TaskStore(),
    messages = stores.messages ?? new MessageStore(),
    queue = stores.queue ?? new InvocationQueue();
  f.options.tasks = tasks;
  f.options.messages = messages;
  f.options.queue = queue;
  let revision = 1;
  let key = 'd'.repeat(64);
  const draft = f.runtime.alphaBrowserFailureTasks;
  f.runtime.alphaBrowserFailureTasks = async () => [
    {
      ...(await draft())[0],
      subjectKey: `alpha-browser-failure:revision-${revision}`,
      incidentKey: `alpha-browser-incident:${key}`,
      failureSummary: 'known prototype connection refused',
      testedHeadSha: revision.toString(16).padStart(2, '0').repeat(20),
      jobId: `job-${revision}`,
    },
  ];
  f.context.deliver = createDeliverFn({
    messageStore: messages,
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
    persistedQueueDelivery: new PersistedQueueDelivery({ messages, queue, progress: async () => ({ kind: 'queued' }) }),
  });
  return {
    ...f,
    tasks,
    messages,
    queue,
    run: () =>
      createAlphaBrowserTemplate(f.options)
        .createSpec('alpha-subscription', f.params)
        .run.execute('alpha', 'alpha', f.context),
    next: () => {
      revision++;
    },
    differentFailure: () => {
      key = 'e'.repeat(64);
    },
  };
}
