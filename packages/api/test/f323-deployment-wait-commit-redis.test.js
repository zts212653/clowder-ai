import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createTypedWaitRegistration } from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { RedisWaitLifecycleEventLog } from '../dist/domains/ball-custody/WaitLifecycleEventLog.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { DeploymentWaitLifecycleService } from '../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { DeploymentWaitRecoverySweep } from '../dist/domains/runtime-deployment/DeploymentWaitRecoverySweep.js';
import { tasksRoutes } from '../dist/routes/tasks.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const fixture = ownedRedisFixture('task738-wait-commit');

test('Redis native and governed Task writes retain resumed status and recover one wait audit after event failure', async (t) => {
  for (const governed of [false, true]) {
    const redis = fixture.client(`task738-wait-${randomUUID()}:`);
    const tasks = new RedisTaskStore(redis),
      messages = new RedisMessageStore(redis);
    const task = await tasks.create({
      threadId: 'home',
      title: 'Original wait work',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      userId: 'user-1',
      ...(governed ? { subjectKey: 'eval-case:wait-commit' } : {}),
    });
    const active = {
      v: 1,
      generation: 1,
      subjectRef: 'deployment:abc123def456:runtime',
      ownerFence: { kind: 'containing_task', generation: 1 },
      baseline: { bootSequence: 1, bootId: 'boot-1', capturedAt: 100 },
      continuation: {
        when: [{ kind: 'new_ready_boot', services: ['api'] }],
        // biome-ignore lint/suspicious/noThenProperty: Existing frozen continuation field.
        then: 'Verify original work',
      },
      autoRenew: false,
      createdAt: 100,
    };
    const receipt = createTypedWaitRegistration({
      task,
      active,
      invocationId: 'old-invocation',
      source: { kind: 'primary', sourceMessageId: 'original-source' },
    });
    assert.ok(
      await tasks.replaceDeploymentWaitIfGeneration(task.id, {
        expectedGeneration: null,
        expectedDeploymentWait: undefined,
        deploymentWait: { await: active },
        waitRegistration: receipt,
        status: 'blocked',
      }),
    );
    const events = new RedisWaitLifecycleEventLog(redis);
    const options = {
      taskStore: tasks,
      messageStore: messages,
      eventLog: events,
      deliveryDeps: {},
      currentObservation: async () => {
        throw new Error('audit must not request deployment evidence or publish a wake');
      },
      log: { info() {}, warn() {}, error() {} },
    };
    const lifecycle = new DeploymentWaitLifecycleService(options);
    const app = Fastify();
    t.after(() => app.close());
    await app.register(tasksRoutes, {
      taskStore: tasks,
      messageStore: messages,
      socketManager: { broadcastToRoom() {} },
      deploymentWaitLifecycleHolder: { current: lifecycle },
    });
    const append = events.append.bind(events);
    events.append = async () => {
      throw new Error('fixture event log unavailable after Task commit');
    };
    const result = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { ownerCatId: 'sonnet', expectedOwnerRevision: 0 },
    });
    assert.equal(result.statusCode, 200, result.body);
    const loaded = await new RedisTaskStore(redis).get(task.id);
    assert.equal(loaded.status, 'doing');
    assert.equal(loaded.ownerCatId, 'sonnet');
    assert.equal(loaded.deploymentWait.waitOutcome.reason, 'owner_changed');
    assert.equal(loaded.deploymentWait.await, undefined);
    assert.deepEqual(await events.read(task.id), []);
    const coldEvents = new RedisWaitLifecycleEventLog(redis);
    const restarted = new DeploymentWaitLifecycleService({
      ...options,
      taskStore: new RedisTaskStore(redis),
      eventLog: coldEvents,
    });
    const sweep = new DeploymentWaitRecoverySweep(
      new RedisTaskStore(redis),
      {
        observe: async () => {
          throw new Error('terminal audit must not wake or observe');
        },
      },
      restarted,
    );
    await sweep.run();
    const recorded = await coldEvents.read(task.id);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].ownerCatId, 'codex-sol');
    assert.equal(recorded[0].ownerUserId, 'user-1');
    assert.equal(recorded[0].reason, 'owner_changed');
    await sweep.run();
    assert.deepEqual(await coldEvents.read(task.id), recorded);
    events.append = append;
  }
});
