import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * F300 Task 1.6 -- the cat-facing read and the UI read the same route, so there
 * is only ever one answer to "where am I".
 */
describe('GET /api/home-state/self', () => {
  async function server() {
    const Fastify = (await import('fastify')).default;
    const { homeStateRoutes } = await import('../../dist/routes/home-state.js');
    const app = Fastify();
    await app.register(homeStateRoutes, { apiPort: 39002 });
    return app;
  }

  it('grounds the caller without being told a repo or log path', async () => {
    const app = await server();
    try {
      // A local caller may name the cat it wants to look at; identity for an
      // authenticated cat is proven instead, and is covered in
      // home-state-caller-binding.test.js.
      const response = await app.inject({ url: '/api/home-state/self?catId=opus-5' });
      assert.equal(response.statusCode, 200);

      const facet = response.json();
      assert.equal(facet.v, 1);
      assert.equal(facet.coordinates.catId, 'opus-5');
      assert.equal(facet.coordinates.threadId, undefined);
      assert.equal(facet.runtime.apiPid, process.pid);
      assert.equal(facet.runtime.apiPort, 39002);
      assert.ok(facet.installation.projectRoot);
      assert.ok(facet.platform.os);
      assert.ok(facet.runtime.sourceRef);
    } finally {
      await app.close();
    }
  });

  it('lists itself as a host dependency, so a stop assessment has something to match', async () => {
    const app = await server();
    try {
      const facet = (await app.inject({ url: '/api/home-state/self?catId=opus-5' })).json();
      const api = facet.hostDependencies.find((dependency) => dependency.kind === 'api');

      assert.equal(api.pid, process.pid);
      assert.ok(api.identityRef);
    } finally {
      await app.close();
    }
  });

  it('answers with a typed absent quota rather than an optimistic default', async () => {
    const app = await server();
    try {
      const facet = (await app.inject({ url: '/api/home-state/self?catId=opus-5' })).json();
      // No clientId given, so no pool can be attributed. That must read as
      // "unknown", never as "ok".
      assert.equal(facet.quota, 'unknown');
    } finally {
      await app.close();
    }
  });
});
