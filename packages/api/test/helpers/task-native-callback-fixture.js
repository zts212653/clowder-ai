import Fastify from 'fastify';
import { InMemoryDispatchProposalStore } from '../../dist/domains/approval-hub/stores/InMemoryDispatchProposalStore.js';
import { OrdinaryTaskHandoffService } from '../../dist/domains/ball-custody/OrdinaryTaskHandoffService.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisQueueLedgerStore } from '../../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { RedisInvocationRecordStore } from '../../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js';
import { RedisMessageStore } from '../../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisTaskStore } from '../../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { RedisThreadStore } from '../../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { RedisTurnExecutionStore } from '../../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { callbacksRoutes } from '../../dist/routes/callbacks.js';
import { taskHandoffDispatchAuthority } from '../../dist/routes/task-handoff-dispatch-authority.js';
export async function taskNativeCallbackFixture(t, redis, existing) {
  const tasks = redis ? new RedisTaskStore(redis) : new TaskStore();
  const messages = redis ? new RedisMessageStore(redis) : new MessageStore();
  const threads = redis ? new RedisThreadStore(redis) : new ThreadStore();
  const turns = redis ? new RedisTurnExecutionStore(redis) : new InMemoryTurnExecutionStore();
  const registry = new InvocationRegistry();
  const queue = new InvocationQueue(redis ? new RedisQueueLedgerStore(redis) : undefined);
  const invocationRecords = redis ? new RedisInvocationRecordStore(redis) : new InvocationRecordStore();
  const home = existing
    ? await threads.get(existing.homeId)
    : await threads.create('native-user', 'Canonical home', process.cwd());
  const child = existing
    ? await threads.get(existing.childId)
    : await threads.create('native-user', 'Approved child', process.cwd());
  await threads.addParticipants(home.id, ['codex']);
  await threads.addParticipants(child.id, ['sonnet']);
  const task = existing
    ? await tasks.get(existing.taskId)
    : await tasks.create({
        threadId: home.id,
        title: 'Deliver accepted work',
        why: 'Keep original WIP',
        ownerCatId: 'codex',
        createdBy: 'codex',
        userId: 'native-user',
      });
  const delegates = {
    async getForTask() {
      return [{ catId: 'sonnet', threadId: child.id, evidenceRef: 'approved-contract' }];
    },
  };
  const proposals = new InMemoryDispatchProposalStore();
  const handoffs = new OrdinaryTaskHandoffService({ tasks, messages, threads, turns, delegates });
  let proposalCreates = 0,
    cards = 0,
    leaseCalls = 0;
  const originalCreate = proposals.create.bind(proposals);
  proposals.create = async (...args) => {
    proposalCreates++;
    return originalCreate(...args);
  };
  const app = Fastify();
  handoffs.deps.dispatchAuthority = taskHandoffDispatchAuthority(proposals, app.log);
  t.after(() => app.close());
  await app.register(callbacksRoutes, {
    registry,
    messageStore: messages,
    threadStore: threads,
    taskStore: tasks,
    socketManager: { broadcastToRoom() {}, broadcastAgentMessage() {}, emitToUser() {} },
    invocationQueue: queue,
    invocationRecordStore: invocationRecords,
    turnExecutionStore: turns,
    router: {
      async *routeExecution() {},
      getExecutions() {
        return [];
      },
    },
    queueProcessor: { async tryAutoExecute() {} },
    ordinaryTaskHandoffs: handoffs,
    actionSuccessorAdmissionService: {
      async admit() {
        leaseCalls++;
        throw new Error('ordinary lease admission is forbidden');
      },
      async preflightStructuredTransferStanding() {},
    },
    dispatchProposalStore: proposals,
    approvalIngress: {
      async publish() {
        cards++;
      },
    },
  });
  const auth = await registry.create('native-user', 'codex', home.id);
  await turns.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: auth.invocationId,
    threadId: home.id,
    userId: 'native-user',
    catId: 'codex',
    executionKind: 'ordinary',
    startedAt: Date.now(),
  });
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const action = {
    subjectRef: `subject:task:${task.id}`,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    terminalPredicate: { kind: 'task_done' },
    expectedOwnerRevision: 0,
  };
  const send = (payload = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers,
      payload: {
        content: 'Implement the accepted Task',
        targetCats: ['sonnet'],
        clientMessageId: 'native-handoff',
        action,
        ...payload,
      },
    });
  return {
    app,
    tasks,
    messages,
    threads,
    turns,
    registry,
    queue,
    handoffs,
    task,
    home,
    child,
    send,
    action,
    invocationRecords,
    proposals,
    counts: () => ({ proposalCreates, cards, leaseCalls }),
  };
}
