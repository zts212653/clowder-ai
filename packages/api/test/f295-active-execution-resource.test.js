import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { registerActiveExecutionRoutes } = await import('../dist/routes/active-execution-routes.js');

const USER_ID = 'user-a';

function buildDeps() {
  const threads = [
    { id: 'thread-a', title: 'A', projectPath: '/project/cafe', createdBy: USER_ID },
    { id: 'thread-b', title: 'B', projectPath: '/project/cafe', createdBy: USER_ID },
    { id: 'thread-c', title: 'C', projectPath: '/project/other', createdBy: USER_ID },
  ];
  const executions = new Map([
    ['thread-a', { catId: 'codex-sol', executionId: 'inv-a', startedAt: 100 }],
    ['thread-b', { catId: 'opus5', executionId: 'inv-b', startedAt: 200 }],
    ['thread-c', { catId: 'codex-terra', executionId: 'inv-c', startedAt: 300 }],
  ]);
  return {
    threadStore: {
      get: mock.fn(async (threadId) => threads.find((thread) => thread.id === threadId) ?? null),
      listByProject: mock.fn(async (userId, projectPath) =>
        userId === USER_ID ? threads.filter((thread) => thread.projectPath === projectPath) : [],
      ),
    },
    invocationTracker: {
      getUserId: (threadId) => (executions.has(threadId) ? USER_ID : null),
      getExecutionId: (threadId) => executions.get(threadId)?.executionId,
    },
    dynamicTaskStore: { getAll: () => [] },
    resolveLiveExecutions: mock.fn(async (threadId, userId) => {
      const execution = executions.get(threadId);
      if (!execution || userId !== USER_ID) return [];
      return [{ ...execution, ownerUserId: USER_ID, controlSource: 'tracker' }];
    }),
    cancelExactLiveInvocation: mock.fn(async () => ({ cancelled: true })),
  };
}

function inject(app, projectPath, userId = USER_ID) {
  return new Promise((resolve, reject) => {
    app.inject(
      {
        method: 'GET',
        url: `/api/executions/active?projectPath=${encodeURIComponent(projectPath)}`,
        headers: { 'x-cat-cafe-user': userId },
      },
      (error, response) => {
        if (error) reject(error);
        else resolve(response);
      },
    );
  });
}

describe('F295 user/project active execution resource', () => {
  let app;
  let deps;

  beforeEach(async () => {
    deps = buildDeps();
    app = Fastify();
    registerActiveExecutionRoutes(app, deps);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('emits queryable stage traces without encoding a latency threshold', async () => {
    await app.close();
    const records = [];
    app = Fastify({
      logger: {
        level: 'info',
        stream: { write: (line) => records.push(JSON.parse(line)) },
      },
    });
    registerActiveExecutionRoutes(app, deps);
    await app.ready();

    const response = await inject(app, '/project/cafe');

    assert.equal(response.statusCode, 200);
    const stages = records
      .filter((record) => record.measurement === 'active_execution_projection')
      .map((record) => record.stage);
    assert.deepEqual(stages, ['candidate_enumeration', 'owner_truth', 'classification_assembly', 'total']);
  });

  it('single-flights concurrent callers for the same user and project', async () => {
    let activeBuilders = 0;
    let maxBuildersPerKey = 0;
    let signalBuilderEntered;
    let releaseProjectRead;
    const builderEntered = new Promise((resolve) => {
      signalBuilderEntered = resolve;
    });
    const projectReadGate = new Promise((resolve) => {
      releaseProjectRead = resolve;
    });
    const listByProject = deps.threadStore.listByProject;
    deps.threadStore.listByProject = mock.fn(async (...args) => {
      activeBuilders += 1;
      maxBuildersPerKey = Math.max(maxBuildersPerKey, activeBuilders);
      signalBuilderEntered();
      await projectReadGate;
      activeBuilders -= 1;
      return listByProject(...args);
    });

    const first = inject(app, '/project/cafe');
    await builderEntered;
    const second = inject(app, '/project/cafe');
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseProjectRead();
    const responses = await Promise.all([first, second]);

    assert.deepEqual(
      responses.map((response) => response.statusCode),
      [200, 200],
    );
    assert.equal(maxBuildersPerKey, 1);
    assert.equal(deps.threadStore.listByProject.mock.callCount(), 1);
  });

  it('isolates overlapping project resources and rejects a foreign user scope', async () => {
    const listByProject = deps.threadStore.listByProject;
    let activeBuilders = 0;
    let maxBuildersAcrossKeys = 0;
    let releaseCafe;
    let signalCafeEntered;
    const cafeGate = new Promise((resolve) => {
      releaseCafe = resolve;
    });
    const cafeEntered = new Promise((resolve) => {
      signalCafeEntered = resolve;
    });
    deps.threadStore.listByProject = mock.fn(async (userId, projectPath) => {
      activeBuilders += 1;
      maxBuildersAcrossKeys = Math.max(maxBuildersAcrossKeys, activeBuilders);
      if (projectPath === '/project/cafe') {
        signalCafeEntered();
        await cafeGate;
      }
      activeBuilders -= 1;
      return listByProject(userId, projectPath);
    });

    const cafe = inject(app, '/project/cafe');
    await cafeEntered;
    const other = inject(app, '/project/other');
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseCafe();
    const [cafeResponse, otherResponse] = await Promise.all([cafe, other]);

    assert.equal(maxBuildersAcrossKeys, 2);
    assert.equal(cafeResponse.json().projectPath, '/project/cafe');
    assert.equal(
      cafeResponse.json().executions.some((execution) => execution.executionId === 'inv-c'),
      false,
    );
    assert.equal(otherResponse.json().projectPath, '/project/other');
    assert.equal(
      otherResponse.json().executions.some((execution) => execution.executionId === 'inv-c'),
      true,
    );

    const foreignUser = await inject(app, '/project/other', 'user-b');
    assert.equal(foreignUser.statusCode, 404);
    assert.equal(foreignUser.json().code, 'PROJECT_NOT_FOUND');
  });
});
