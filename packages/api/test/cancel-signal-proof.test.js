import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { createCliExecutionOwnerService } from '../dist/utils/cli-process-ownership.js';

for (const mode of [
  'live',
  'gone',
  'pid-reused',
  'late-exit',
  'snapshot-unknown',
  'missing-owner',
  'sibling',
  'root-live',
  'late-sibling',
])
  test(`real recovery distinguishes signal acknowledgement and stop proof: ${mode}`, async (t) => {
    const scope = {
      invocationId: 'signal-child',
      parentInvocationId: 'signal-parent',
      threadId: 'signal-thread',
      userId: 'signal-user',
      catId: 'codex',
      executionKind: 'ordinary',
      startedAt: 0,
      providerLifecycleTracked: true,
    };
    const execution = {
      executionId: scope.parentInvocationId,
      invocationId: scope.invocationId,
      threadId: scope.threadId,
      userId: scope.userId,
      catId: scope.catId,
    };
    const parentDir = resolve('artifacts/role-agent-refactor/signal-proof');
    await mkdir(parentDir, { recursive: true });
    const dataDir = await mkdtemp(join(parentDir, 'owned-'));
    const ownerDir = join(dataDir, 'cli-process-owners');
    await mkdir(ownerDir);
    // Controlled process-table boundary only: no OS process or real signal is used.
    const identity = { pid: 424242, ppid: 1, pgid: 424242, startedAt: 'Wed Aug 13 01:00:00 2026' };
    const nativeRoot = { ...identity, pid: identity.pid + 2, ppid: identity.pid };
    const ownerId = '12345678-1234-4234-8234-123456789abc';
    await writeFile(
      join(ownerDir, `${ownerId}.json`),
      JSON.stringify({
        v: 1,
        ownerId,
        createdAt: 1000,
        supervisor: identity,
        execution,
        ...(mode === 'root-live' ? { root: nativeRoot } : {}),
      }),
    );
    const signals = [];
    let moved = false;
    let published = false;
    const sibling = { ...identity, pid: identity.pid + 1, pgid: identity.pid + 1 };
    const owners = createCliExecutionOwnerService({
      dataDir,
      readProcessSnapshot: async ({ pids }) => {
        if (signals.length === 0) return new Map([[identity.pid, identity]]);
        if (mode === 'late-sibling') {
          if (!published) {
            published = true;
            turns.createRunning({ ...scope, invocationId: 'late-sibling' });
            turns.markProviderStarted('late-sibling', 0);
            const siblingId = '22345678-1234-4234-8234-123456789abc';
            await writeFile(
              join(ownerDir, `${siblingId}.json`),
              JSON.stringify({
                v: 1,
                ownerId: siblingId,
                createdAt: 1001,
                supervisor: sibling,
                execution: { ...execution, invocationId: 'late-sibling' },
              }),
            );
          }
          return new Map(pids.includes(sibling.pid) ? [[sibling.pid, sibling]] : []);
        }
        if (mode === 'snapshot-unknown') return null;
        if (mode === 'root-live') return new Map([[nativeRoot.pid, nativeRoot]]);
        if (mode === 'gone' || (mode === 'late-exit' && signals.length > 1)) return new Map();
        if (mode === 'pid-reused')
          return new Map([[identity.pid, { ...identity, startedAt: 'Thu Aug 14 01:00:00 2026' }]]);
        if (mode === 'sibling') return new Map([[sibling.pid, sibling]]);
        return new Map([[identity.pid, identity]]);
      },
      kill: (pid, signal) => {
        signals.push({ pid, signal });
        if (mode === 'missing-owner' && !moved) {
          moved = true;
          renameSync(join(ownerDir, ownerId + '.json'), join(ownerDir, ownerId + '.retained'));
        }
        if (mode === 'sibling')
          writeFileSync(
            join(ownerDir, '22345678-1234-4234-8234-123456789abc.json'),
            JSON.stringify({
              v: 1,
              ownerId: '22345678-1234-4234-8234-123456789abc',
              createdAt: 1001,
              supervisor: sibling,
              execution: { ...execution, invocationId: 'new-child' },
            }),
          );
      },
    });
    const turns = new InMemoryTurnExecutionStore();
    turns.createRunning(scope);
    turns.markProviderStarted(scope.invocationId, 0);
    const parent = {
      id: scope.parentInvocationId,
      threadId: scope.threadId,
      userId: scope.userId,
      targetCats: [scope.catId],
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    };
    const messages = [],
      releases = [];
    const app = Fastify({ logger: false });
    t.after(() => app.close());
    await app.register(queueRoutes, {
      threadStore: { get: async (id) => ({ id, title: 'owned', createdBy: scope.userId }) },
      invocationQueue: new InvocationQueue(),
      invocationTracker: {
        has: () => false,
        getUserId: () => null,
        getExecutionId: () => undefined,
        getSlotState: () => 'absent',
        getCanceledSlotIdentity: () => undefined,
        getActiveSlots: () => [],
      },
      queueProcessor: {
        canReleaseSlotForUser: () => true,
        hasProcessingSlotReservation: () => false,
        releaseSlot: () => releases.push('slot'),
        hasActiveExecution: () => false,
        isCatBusy: () => false,
      },
      invocationRecordStore: {
        get: async (id) => (id === parent.id ? parent : null),
        listRunningByThread: async () => (parent.status === 'running' ? [parent] : []),
        update: async (_id, patch) => Object.assign(parent, patch),
      },
      turnExecutionStore: turns,
      cliExecutionOwnerService: owners,
      socketManager: {
        broadcastAgentMessage: (message) => messages.push(message),
        broadcastToRoom() {},
        emitToUser() {},
      },
      agentSessionMutex: {
        forceReleaseByScope: () => {
          releases.push('lock');
          return { releasedHolders: 1, rejectedWaiters: 0, catIds: [scope.catId] };
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${scope.threadId}/executions/live/${parent.id}/cancel`,
      headers: { 'x-cat-cafe-user': scope.userId },
      payload: { catId: scope.catId },
    });
    const liveAfter = await owners.listLive();
    const evidence = {
      mode,
      responseStatus: response.statusCode,
      response: response.json(),
      signals,
      liveAfter,
      turn: turns.get(scope.invocationId),
      siblingTurn: turns.get('late-sibling'),
      messages,
      releases,
      noOsProcessCreated: true,
      retainedDataDir: dataDir,
    };
    await writeFile(join(dataDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
    assert.ok(signals.length >= 1 && signals.length <= 3);
    if (['gone', 'pid-reused', 'late-exit'].includes(mode)) {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(turns.get(scope.invocationId).status, 'canceled');
      assert.ok(turns.get(scope.invocationId).providerTeardownAt >= 0);
      assert.equal(messages.filter((m) => m.type === 'done').length, 1);
    } else {
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(turns.get(scope.invocationId).status, 'running');
      assert.equal(turns.get(scope.invocationId).providerTeardownAt, undefined);
      assert.equal(parent.status, 'running');
      if (mode === 'late-sibling') assert.equal(turns.get('late-sibling').status, 'running');
      assert.deepEqual(releases, []);
      assert.equal(
        messages.some((m) => m.type === 'done'),
        false,
      );
    }
  });
