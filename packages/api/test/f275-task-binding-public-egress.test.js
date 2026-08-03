import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const PRIVATE_BINDING = Object.freeze({
  workId: 'work-must-stay-private',
  attemptId: 'attempt-must-stay-private',
});

function assertNoPrivateIdentity(value) {
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(encoded.includes(PRIVATE_BINDING.workId), false);
  assert.equal(encoded.includes(PRIVATE_BINDING.attemptId), false);
}

function createCommunityIssueStore() {
  return {
    listByRepo: async () => [],
    listAll: async () => [],
    get: async () => null,
    getByRepoAndNumber: async () => null,
    create: async () => null,
    update: async () => null,
    delete: async () => false,
  };
}

describe('F275 private PR task binding public egress', () => {
  let taskStore;
  let task;

  beforeEach(async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    taskStore = new TaskStore();
    task = taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#275',
      threadId: 'thread-f275-private-egress',
      title: 'PR tracking: owner/repo#275',
      why: 'verify private identity egress boundary',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      automationState: { intent: 'review', ci: { headSha: 'head-275' } },
    });
    taskStore.bindManagedWorkBinding(task.id, PRIVATE_BINDING);
  });

  test('task get/list/update responses and socket events omit the private binding', async () => {
    const events = [];
    const socketManager = {
      broadcastToRoom(room, event, data) {
        events.push({ room, event, data });
      },
    };
    const { tasksRoutes } = await import('../dist/routes/tasks.js');
    const app = Fastify();
    await app.register(tasksRoutes, { taskStore, socketManager });

    const list = await app.inject({
      method: 'GET',
      url: `/api/tasks?threadId=${task.threadId}`,
    });
    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` });
    const update = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { status: 'doing' },
    });

    assert.equal(list.statusCode, 200);
    assert.equal(detail.statusCode, 200);
    assert.equal(update.statusCode, 200);
    assertNoPrivateIdentity(list.body);
    assertNoPrivateIdentity(detail.body);
    assertNoPrivateIdentity(update.body);
    assertNoPrivateIdentity(events);
    assert.deepEqual(taskStore.getManagedWorkBinding(task.id), PRIVATE_BINDING);
    await app.close();
  });

  test('community board projection omits the private binding', async () => {
    const { communityIssueRoutes } = await import('../dist/routes/community-issues.js');
    const app = Fastify();
    await app.register(communityIssueRoutes, {
      communityIssueStore: createCommunityIssueStore(),
      taskStore,
      socketManager: { broadcastToRoom() {}, emitToUser() {} },
    });

    const response = await app.inject({ method: 'GET', url: '/api/community-board?repo=owner/repo' });

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().prItems.some((item) => item.taskId === task.id),
      true,
    );
    assertNoPrivateIdentity(response.body);
    assert.deepEqual(taskStore.getManagedWorkBinding(task.id), PRIVATE_BINDING);
    await app.close();
  });
});
