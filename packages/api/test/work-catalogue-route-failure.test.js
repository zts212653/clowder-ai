import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { WorkCatalogue } from '../dist/domains/collaborative-content/works/catalogue.js';
import { threadsRoutes } from '../dist/routes/threads.js';
import { workCatalogueFixture } from './helpers/work-catalogue-fixture.js';

test(
  'failed global Works waits for admitted readers before closing its scope; the next HTTP gets a fresh scope',
  { timeout: 30000 },
  async (t) => {
    const f = await workCatalogueFixture(t);
    const threads = Array.from({ length: 7 }, (_, i) => ({ id: `T${i}`, createdBy: 'owner', title: `Thread ${i}` }));
    const expected = [];
    for (const thread of threads) expected.push((await f.create(`film-${thread.id}`, thread.id)).reference.contentRef);
    const catalogue = new WorkCatalogue(f.service);
    const allEntered = Promise.withResolvers();
    const failureStarted = Promise.withResolvers();
    const releaseDelayed = Promise.withResolvers();
    const firstReadersSettled = Promise.withResolvers();
    const scopes = [];
    const independent = {
      readThread: () => assert.fail('global HTTP must use its request-scoped reader'),
      async withRead(ownerUserId, consume) {
        const scope = { generation: scopes.length + 1, active: true, inFlight: 0, started: [], delayedCompleted: [] };
        scopes.push(scope);
        try {
          return await catalogue.withRead(ownerUserId, (reader) =>
            consume({
              async readThread(input) {
                assert.equal(scope.active, true, 'every new read starts in its active request');
                scope.inFlight++;
                scope.started.push(input.threadId);
                try {
                  if (scope.generation === 1) {
                    if (scope.started.length === 4) allEntered.resolve();
                    if (input.threadId === 'T0') {
                      await allEntered.promise;
                      failureStarted.resolve();
                      throw new Error('synthetic Work reader failure');
                    }
                    await releaseDelayed.promise;
                  }
                  const page = await reader.readThread(input);
                  if (scope.generation === 1)
                    scope.delayedCompleted.push({ threadId: input.threadId, active: scope.active });
                  return page;
                } finally {
                  scope.inFlight--;
                  if (scope.generation === 1 && scope.inFlight === 0) firstReadersSettled.resolve();
                }
              },
            }),
          );
        } finally {
          scope.inFlightAtClose = scope.inFlight;
          scope.active = false;
        }
      },
    };
    const app = Fastify();
    t.after(async () => {
      allEntered.resolve();
      releaseDelayed.resolve();
      if (scopes.length) await firstReadersSettled.promise;
      await app.close();
    });
    await app.register(threadsRoutes, {
      threadStore: { list: async () => threads, getThreadMemory: async () => null },
      messageStore: new MessageStore(),
      taskStore: new TaskStore(),
      artifactWorkLineage: {
        independent,
        current: { resolve: async ({ artifacts }) => artifacts.map((item) => item.work) },
      },
    });
    const headers = { 'x-cat-cafe-user': 'owner' };
    const pending = app.inject({ url: '/api/artifacts?view=works', headers });
    await allEntered.promise;
    await failureStarted.promise;
    // Let the failure reach the route's worker join before releasing the other three readers.
    await setImmediate();
    const closedBeforeRelease = !scopes[0].active;
    releaseDelayed.resolve();
    const failed = await pending;
    await firstReadersSettled.promise;
    assert.equal(failed.statusCode, 500);
    assert.equal(scopes[0].inFlightAtClose, 0, 'scope closes only after all in-flight readers settle');
    assert.equal(closedBeforeRelease, false, 'scope remains active while admitted readers are delayed');
    assert.deepEqual(scopes[0].started.sort(), ['T0', 'T1', 'T2', 'T3'], 'failure admits no further threads');
    assert.deepEqual(
      scopes[0].delayedCompleted.sort((a, b) => a.threadId.localeCompare(b.threadId)),
      [
        { threadId: 'T1', active: true },
        { threadId: 'T2', active: true },
        { threadId: 'T3', active: true },
      ],
    );
    const next = await app.inject({ url: '/api/artifacts?view=works', headers });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().complete, true);
    assert.deepEqual(
      next
        .json()
        .artifacts.map((item) => item.ref)
        .sort(),
      expected.sort(),
    );
    assert.equal(scopes.length, 2);
    assert.equal(scopes[1].generation, 2);
    assert.deepEqual(
      scopes[1].started.sort(),
      threads.map((thread) => thread.id),
    );
    assert.equal(scopes[1].inFlightAtClose, 0);
    assert.equal(scopes[1].active, false);
    t.diagnostic(JSON.stringify(scopes));
  },
);
