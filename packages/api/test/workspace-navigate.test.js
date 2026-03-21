import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerWorktrees } from '../dist/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../dist/routes/workspace.js';

describe('POST /api/workspace/navigate (F131)', () => {
  const app = Fastify();
  const emittedEvents = [];

  before(async () => {
    registerWorktrees([{ id: 'test-wt', root: process.cwd(), branch: 'main', head: 'abc123' }]);

    await app.register(workspaceRoutes, {
      socketEmit: (event, data, room) => {
        emittedEvents.push({ event, data, room });
      },
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('returns 400 when path is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: 'test-wt' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  });

  it('returns 400 when worktreeId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { path: 'package.json' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  });

  it('returns 404 for non-existent path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: 'test-wt', path: 'does-not-exist-xyzzy.ts' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 200 and emits dual-broadcast for valid path with worktreeId', async () => {
    emittedEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: 'test-wt', path: 'package.json' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.path, 'package.json');
    assert.equal(body.action, 'reveal');

    assert.equal(emittedEvents.length, 2);
    assert.equal(emittedEvents[0].event, 'workspace:navigate');
    assert.equal(emittedEvents[0].room, 'worktree:test-wt');
    assert.equal(emittedEvents[1].room, 'workspace:global');
  });

  it('accepts action=open and passes it through', async () => {
    emittedEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: 'test-wt', path: 'package.json', action: 'open' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.action, 'open');
    assert.equal(emittedEvents[0].data.action, 'open');
  });

  it('accepts optional line parameter', async () => {
    emittedEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: 'test-wt', path: 'package.json', action: 'open', line: 42 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(emittedEvents[0].data.line, 42);
  });

  it('passes threadId through to emitted events for session isolation', async () => {
    emittedEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: 'test-wt', path: 'package.json', threadId: 'thread-abc' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(emittedEvents[0].data.threadId, 'thread-abc');
    assert.equal(emittedEvents[1].data.threadId, 'thread-abc');
  });

  it('omits threadId from events when not provided', async () => {
    emittedEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: 'test-wt', path: 'package.json' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(emittedEvents[0].data.threadId, undefined);
  });

  it('works without socketEmit configured (graceful degradation)', async () => {
    const app2 = Fastify();
    registerWorktrees([{ id: 'test-wt', root: process.cwd(), branch: 'main', head: 'abc123' }]);
    await app2.register(workspaceRoutes);
    await app2.ready();

    const res = await app2.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: 'test-wt', path: 'package.json' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);

    await app2.close();
  });
});
