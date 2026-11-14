import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { readGlobalWorksPage } from '../src/domains/cats/services/agents/routing/global-works-page.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { EntrustedWorkLifecycleService } from '../src/domains/growing/EntrustedWorkLifecycleService.js';
import type { SocketManager } from '../src/infrastructure/websocket/SocketManager.js';
import { callbacksRoutes } from '../src/routes/callbacks.js';

const now = 1_788_170_000_000;
const threadId = 'thread-f310';
const owner = 'owner-1';
const prUrl = 'https://github.com/example/project/pull/12';

function admissionCommand() {
  return {
    task: {
      threadId,
      title: 'Deliver the reviewed PR',
      why: 'The source conversation explicitly entrusted this delivery',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      userId: owner,
    },
    admission: {
      basis: 'explicit_entrustment' as const,
      sourceRefs: ['message:source-1'],
      intendedOutcome: 'The PR is attached to the entrusted work',
      idempotencyKey: 'entrusted:source-1',
    },
    closure: {
      condition: 'The PR is reviewable',
      expectedSignal: 'pr:example/project#12',
    },
  };
}

test('entrusted-work PR attachment emits works_changed through the real callback route', async () => {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  threadStore.ensureThread(threadId, 'F310 entrusted-work test');
  const seed = new EntrustedWorkLifecycleService(taskStore, { now: () => now });
  const admitted = await seed.admitOrResume(admissionCommand());
  const taskId = admitted.ownerRef.replace('task:item:', '');

  const emitted: Array<{ userId: string; event: string; data: unknown }> = [];
  const socketManager = {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser: (userId: string, event: string, data: unknown) => emitted.push({ userId, event, data }),
  } as unknown as SocketManager;
  const registry = new InvocationRegistry();
  const credentials = await registry.create(owner, 'codex-sol', threadId);
  const app = Fastify();
  try {
    await app.register(callbacksRoutes, { registry, messageStore, socketManager, taskStore, threadStore });
    const updated = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-entrusted-work',
      headers: {
        'x-invocation-id': credentials.invocationId,
        'x-callback-token': credentials.callbackToken,
      },
      payload: { taskId, expectedRevision: 1, artifactRefs: [prUrl] },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json().task.entrustedWork.artifactRefs, [prUrl]);

    const invalidation = emitted.find((event) => event.event === 'entrusted_work_projection_invalidated');
    assert.deepEqual(invalidation?.data, { ownerUserId: owner, reason: 'works_changed' });

    const emittedBeforeRead = emitted.length;
    const page = await readGlobalWorksPage({
      userId: owner,
      threads: [{ id: threadId, title: 'F310 entrusted-work test', createdBy: owner }],
      tasks: taskStore,
      messages: messageStore,
      accepted: async () => [],
    });
    assert.ok(page.artifacts.some((artifact) => artifact.type === 'pr' && artifact.ref === 'example/project#12'));
    assert.equal(emitted.length, emittedBeforeRead, 'reading the server page must not emit another invalidation');
  } finally {
    await app.close();
  }
});

test('entrusted-work admission with a PR attachment is material', async () => {
  const taskStore = new TaskStore();
  const changes: Array<{ userId: string; reason?: string }> = [];
  const lifecycle = new EntrustedWorkLifecycleService(taskStore, {
    now: () => now,
    onChanged: (userId, reason) => changes.push({ userId, ...(reason ? { reason } : {}) }),
  });

  await lifecycle.admitOrResume({ ...admissionCommand(), artifactRefs: [prUrl] });
  assert.deepEqual(changes.at(-1), { userId: owner, reason: 'works_changed' });
});

test('ordinary entrusted-work status changes stay ordinary and unchanged artifact refs do not notify materially', async () => {
  const taskStore = new TaskStore();
  const seed = new EntrustedWorkLifecycleService(taskStore, { now: () => now });
  const admitted = await seed.admitOrResume(admissionCommand());
  const taskId = admitted.ownerRef.replace('task:item:', '');
  const changes: Array<{ userId: string; reason?: string }> = [];
  const lifecycle = new EntrustedWorkLifecycleService(taskStore, {
    now: () => now,
    onChanged: (userId, reason) => changes.push({ userId, ...(reason ? { reason } : {}) }),
  });

  await lifecycle.update({ taskId, expectedRevision: 1, artifactRefs: [prUrl] });
  assert.deepEqual(changes.at(-1), { userId: owner, reason: 'works_changed' });

  await lifecycle.update({ taskId, expectedRevision: 2, status: 'doing' });
  assert.deepEqual(changes.at(-1), { userId: owner });

  await lifecycle.update({ taskId, expectedRevision: 3, status: 'blocked', artifactRefs: [prUrl] });
  assert.deepEqual(changes.at(-1), { userId: owner });

  await lifecycle.update({ taskId, expectedRevision: 4, artifactRefs: [] });
  assert.deepEqual(changes.at(-1), { userId: owner, reason: 'works_changed' });
});
