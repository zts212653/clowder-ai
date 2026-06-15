import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const HEADERS = { 'x-cat-cafe-user': 'test-user' };

describe('GET /api/system/status', () => {
  it('requires request identity before returning system status', async () => {
    const { systemStatusRoutes } = await import('../dist/routes/system-status.js');
    const app = Fastify({ logger: false });
    try {
      await app.register(systemStatusRoutes, { storageMode: 'redis' });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/system/status' });

      assert.equal(res.statusCode, 401);
      assert.deepStrictEqual(JSON.parse(res.payload), { error: 'Identity required' });
    } finally {
      await app.close();
    }
  });

  it('reports active Redis persistent mode without exposing connection details', async () => {
    const { systemStatusRoutes } = await import('../dist/routes/system-status.js');
    const app = Fastify({ logger: false });
    try {
      await app.register(systemStatusRoutes, { storageMode: 'redis' });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/system/status', headers: HEADERS });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.deepStrictEqual(body, {
        storageMode: 'redis',
        storage: {
          mode: 'redis',
          persistent: true,
          warning: null,
        },
      });
      assert.equal(JSON.stringify(body).includes('redis://'), false);
    } finally {
      await app.close();
    }
  });

  it('reports explicit memory mode with a data-loss warning', async () => {
    const { systemStatusRoutes } = await import('../dist/routes/system-status.js');
    const app = Fastify({ logger: false });
    try {
      await app.register(systemStatusRoutes, { storageMode: 'memory' });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/system/status', headers: HEADERS });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.storageMode, 'memory');
      assert.deepStrictEqual(body.storage, {
        mode: 'memory',
        persistent: false,
        warning: 'Memory mode: data will be lost on restart.',
      });
    } finally {
      await app.close();
    }
  });
});
