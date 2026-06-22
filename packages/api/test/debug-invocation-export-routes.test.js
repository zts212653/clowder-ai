import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('Debug invocation export routes', () => {
  let app;
  let projectRoot;
  let savedOwnerId;

  beforeEach(async () => {
    savedOwnerId = process.env.DEFAULT_OWNER_USER_ID;
    delete process.env.DEFAULT_OWNER_USER_ID;
    projectRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-debug-export-'));
    const { debugInvocationExportRoutes } = await import('../dist/routes/debug-invocation-export.js');
    app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) {
        request.sessionUserId = raw.trim();
      }
    });
    await app.register(debugInvocationExportRoutes, { projectRoot });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (savedOwnerId === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = savedOwnerId;
  });

  it('exports debug events to docs/runtime JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/invocation-events/export',
      headers: { 'x-test-session-user': 'user-a', 'content-type': 'application/json' },
      payload: {
        kind: 'events',
        label: 'repro-thread-a',
        dump: {
          meta: {
            generatedAt: 123,
            count: 1,
            enabled: true,
            size: 200,
            rawThreadId: true,
            marker: 'RAW',
            expiresAt: null,
          },
          events: [{ event: 'queue_updated', threadId: 'thread-a', action: 'processing', timestamp: 123 }],
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.match(body.path, /^docs\/runtime\/invocation-events-\d+-repro-thread-a-[a-z0-9]{8}\.json$/);
    assert.equal(body.count, 1);

    const saved = JSON.parse(await readFile(join(projectRoot, body.path), 'utf-8'));
    assert.equal(saved.exportedBy, 'user-a');
    assert.equal(saved.kind, 'events');
    assert.deepEqual(saved.dump.events, [
      { event: 'queue_updated', threadId: 'thread-a', action: 'processing', timestamp: 123 },
    ]);
  });

  it('rejects header-only identity without a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/invocation-events/export',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {
        kind: 'events',
        dump: {
          meta: {
            generatedAt: 1,
            count: 0,
            enabled: true,
            size: 200,
            rawThreadId: false,
            marker: 'MASKED',
            expiresAt: null,
          },
          events: [],
        },
      },
    });

    assert.equal(res.statusCode, 401);
  });

  it('requires identity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/invocation-events/export',
      headers: { 'content-type': 'application/json' },
      payload: {
        kind: 'events',
        dump: {
          meta: {
            generatedAt: 1,
            count: 0,
            enabled: true,
            size: 200,
            rawThreadId: false,
            marker: 'MASKED',
            expiresAt: null,
          },
          events: [],
        },
      },
    });

    assert.equal(res.statusCode, 401);
  });

  it('rejects trusted-origin browser requests without a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/invocation-events/export',
      headers: {
        origin: 'http://localhost:3003',
        'content-type': 'application/json',
      },
      payload: {
        kind: 'events',
        dump: {
          meta: {
            generatedAt: 1,
            count: 0,
            enabled: true,
            size: 200,
            rawThreadId: false,
            marker: 'MASKED',
            expiresAt: null,
          },
          events: [],
        },
      },
    });

    assert.equal(res.statusCode, 401);
  });

  it('rejects non-loopback session writes when DEFAULT_OWNER_USER_ID is not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/invocation-events/export',
      headers: {
        'x-test-session-user': 'user-a',
        'content-type': 'application/json',
      },
      remoteAddress: '192.168.1.100',
      payload: {
        kind: 'events',
        dump: {
          meta: {
            generatedAt: 1,
            count: 0,
            enabled: true,
            size: 200,
            rawThreadId: false,
            marker: 'MASKED',
            expiresAt: null,
          },
          events: [],
        },
      },
    });

    assert.equal(res.statusCode, 403);
  });

  it('rejects non-loopback writes when configured owner is still default-user', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'default-user';

    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/invocation-events/export',
      headers: {
        'x-test-session-user': 'default-user',
        'content-type': 'application/json',
      },
      remoteAddress: '192.168.1.100',
      payload: {
        kind: 'events',
        dump: {
          meta: {
            generatedAt: 1,
            count: 0,
            enabled: true,
            size: 200,
            rawThreadId: false,
            marker: 'MASKED',
            expiresAt: null,
          },
          events: [],
        },
      },
    });

    assert.equal(res.statusCode, 403);
  });
});
