import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { audioProxyRoutes } from '../src/routes/audio-proxy.js';

for (const mode of ['status', 'stop'] as const)
  test(`legacy ${mode} cannot release a capture still finalizing`, async (t) => {
    const original = globalThis.fetch;
    const app = Fastify();
    const finalizing = { running: false, lifecycle_state: 'finalizing', controller_lease: { expired: false } };
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/start') return Response.json({ lease_token: 'private', status: { running: true } });
      if (path === '/status') return Response.json(finalizing);
      return Response.json({ ok: true, summary: { error: 'Not running' }, status: finalizing });
    };
    t.after(async () => {
      await app.close();
      globalThis.fetch = original;
    });
    await app.register(audioProxyRoutes);
    const headers = { 'x-cat-cafe-user': 'owner' };
    const start = () =>
      app.inject({ method: 'POST', url: '/api/audio/start', headers, payload: { thread_id: 'thread-1' } });
    assert.equal((await start()).statusCode, 200);
    await app.inject({
      method: mode === 'status' ? 'GET' : 'POST',
      url: `/api/audio/${mode}`,
      headers,
      ...(mode === 'stop' ? { payload: {} } : {}),
    });
    assert.equal((await start()).statusCode, 409, 'old finalizer must remain fenced from a new start');
  });
