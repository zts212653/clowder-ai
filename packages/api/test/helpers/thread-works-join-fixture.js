import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { WorkCatalogue } from '../../dist/domains/collaborative-content/works/catalogue.js';
import { threadsRoutes } from '../../dist/routes/threads.js';
import { workCatalogueFixture } from './work-catalogue-fixture.js';

const headers = { 'x-cat-cafe-user': 'owner' };
const url = '/api/threads/T0/artifacts?view=works';

export async function threadWorksJoinFixture(t, options = {}) {
  const cleanup = [];
  const f = await workCatalogueFixture({ after: (callback) => cleanup.push(callback) });
  const work = await f.create('saved-film', 'T0');
  const catalogue = new WorkCatalogue(f.service);
  const titleEntered = Promise.withResolvers();
  const releaseTitle = Promise.withResolvers();
  const workEntered = Promise.withResolvers();
  const workReadComplete = Promise.withResolvers();
  const workScopeClosed = Promise.withResolvers();
  const releaseWork = Promise.withResolvers();
  const state = { titleActive: false, titleCalls: 0, workCalls: 0, scopes: [], lineageCalls: 0, failWork: false };
  const app = Fastify();
  const requests = [];
  t.after(async () => {
    releaseTitle.resolve();
    releaseWork.resolve();
    await Promise.allSettled(requests);
    await app.close();
    for (const close of cleanup) await close();
  });
  await app.register(threadsRoutes, {
    threadStore: {
      get: async (id) => (id === 'T0' ? { id, createdBy: 'owner', title: 'Current thread' } : null),
      getThreadMemory: async () => null,
    },
    messageStore: { getByThread: async () => [], getByThreadBefore: async () => [] },
    taskStore: {
      listByThread: async () => [
        {
          kind: 'pr_tracking',
          subjectKey: 'pr:org/repo#7',
          title: 'PR tracking: org/repo#7',
          userId: 'owner',
          ownerCatId: 'codex61-sol',
          updatedAt: 200,
        },
      ],
    },
    prTitleReader: async (ref) => {
      assert.equal(ref, 'org/repo#7');
      state.titleCalls++;
      state.titleActive = true;
      titleEntered.resolve();
      try {
        await releaseTitle.promise;
        return 'Original PR title';
      } finally {
        state.titleActive = false;
      }
    },
    artifactWorkLineage: {
      independent: {
        readThread: () => assert.fail('must use the admitted request scope'),
        async withRead(ownerUserId, consume, observer) {
          if (options.requireTimingObserver) state.timingObserverProvided = typeof observer === 'function';
          assert.equal(ownerUserId, 'owner');
          const scope = { active: true, complete: false, consumerFinished: false };
          state.scopes.push(scope);
          try {
            return await catalogue.withRead(
              ownerUserId,
              async (reader) => {
                try {
                  return await consume({
                    async readThread(input) {
                      state.workCalls++;
                      workEntered.resolve();
                      await releaseWork.promise;
                      assert.equal(scope.active, true);
                      if (state.failWork) throw new Error('synthetic independent Work failure');
                      const page = await reader.readThread(input);
                      scope.complete = true;
                      workReadComplete.resolve();
                      return page;
                    },
                  });
                } finally {
                  scope.consumerFinished = true;
                }
              },
              (report) => {
                options.onWorkTiming?.(report);
                observer?.(report);
              },
            );
          } finally {
            scope.active = false;
            workScopeClosed.resolve();
          }
        },
      },
      current: {
        resolve: async ({ artifacts }) => {
          state.lineageCalls++;
          assert.equal(state.titleActive, false, 'lineage waits for title reads');
          assert.ok(state.scopes.every((scope) => !scope.active));
          if (state.scopes.length) assert.equal(state.scopes.at(-1).complete, true);
          return artifacts.map((item) => item.work);
        },
      },
    },
  });
  return {
    app,
    f,
    work,
    state,
    titleEntered,
    workEntered,
    workReadComplete,
    workScopeClosed,
    releaseTitle,
    releaseWork,
    request(options = {}) {
      const request = app.inject({ url, headers, ...options });
      requests.push(request);
      return request;
    },
  };
}
