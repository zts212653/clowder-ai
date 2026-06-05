import assert from 'node:assert/strict';
import { basename, dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { EventAuditLog } from '../dist/domains/cats/services/orchestration/EventAuditLog.js';
import { registerWorktrees } from '../dist/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../dist/routes/workspace.js';

describe('POST /api/workspace/navigate (F131)', () => {
  const app = Fastify();
  const emittedEvents = [];
  const appendedAuditEvents = [];
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const canonicalWorktreeId = basename(repoRoot).replace(/[^a-zA-Z0-9_-]/g, '_');

  before(async () => {
    registerWorktrees([{ id: 'test-wt', root: repoRoot, branch: 'main', head: 'abc123' }]);
    const auditLog = new EventAuditLog({ auditDir: '/tmp/cat-cafe-workspace-navigate-audit-test' });
    auditLog.append = async (input) => {
      appendedAuditEvents.push(input);
      return {
        id: 'audit-1',
        timestamp: Date.now(),
        ...input,
      };
    };

    await app.register(workspaceRoutes, {
      socketEmit: (event, data, room) => {
        emittedEvents.push({ event, data, room });
      },
      auditLog,
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
    appendedAuditEvents.length = 0;
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
    assert.equal(body.worktreeId, canonicalWorktreeId);
    assert.equal(emittedEvents[0].data.worktreeId, canonicalWorktreeId);
    assert.equal(emittedEvents[0].room, `worktree:${canonicalWorktreeId}`);
    assert.equal(emittedEvents[1].room, 'workspace:global');
    assert.equal(appendedAuditEvents.length, 1);
    assert.equal(appendedAuditEvents[0].type, 'workspace_navigate');
    assert.equal(appendedAuditEvents[0].threadId, undefined);
    assert.deepEqual(appendedAuditEvents[0].data, {
      worktreeId: canonicalWorktreeId,
      requestedWorktreeId: 'test-wt',
      worktreeIdCanonicalized: true,
      path: 'package.json',
      action: 'reveal',
      line: undefined,
      catId: undefined,
    });
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

  it('canonicalizes registry alias worktreeId before emitting navigation events', async () => {
    emittedEvents.length = 0;
    registerWorktrees([{ id: 'alias-wt', root: repoRoot, branch: 'main', head: 'abc123' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: 'alias-wt', path: 'package.json', action: 'open' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.worktreeId, canonicalWorktreeId);
    assert.equal(emittedEvents[0].data.worktreeId, canonicalWorktreeId);
    assert.equal(emittedEvents[0].room, `worktree:${canonicalWorktreeId}`);
  });

  it('surfaces canonicalization fallback in response and audit when reverse lookup fails', async () => {
    const appFallback = Fastify();
    const fallbackEvents = [];
    const fallbackAuditEvents = [];
    const fallbackWorktreeId = 'fallback-wt';
    registerWorktrees([{ id: fallbackWorktreeId, root: repoRoot, branch: 'main', head: 'abc123' }]);
    const auditLog = new EventAuditLog({ auditDir: '/tmp/cat-cafe-workspace-navigate-fallback-audit-test' });
    auditLog.append = async (input) => {
      fallbackAuditEvents.push(input);
      return {
        id: 'audit-fallback-1',
        timestamp: Date.now(),
        ...input,
      };
    };

    await appFallback.register(workspaceRoutes, {
      socketEmit: (event, data, room) => {
        fallbackEvents.push({ event, data, room });
      },
      auditLog,
      resolveWorktreeIdByPathForNavigate: async () => {
        const error = new Error('registry reverse lookup race');
        error.code = 'NOT_FOUND';
        throw error;
      },
    });
    await appFallback.ready();

    const res = await appFallback.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: fallbackWorktreeId, path: 'package.json', action: 'open' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.worktreeId, fallbackWorktreeId);
    assert.equal(body.worktreeIdCanonicalized, false);
    assert.equal(body.canonicalizeFallback, true);
    assert.equal(fallbackEvents[0].room, `worktree:${fallbackWorktreeId}`);
    assert.equal(fallbackAuditEvents.length, 1);
    assert.equal(fallbackAuditEvents[0].data.worktreeId, fallbackWorktreeId);
    assert.equal(fallbackAuditEvents[0].data.requestedWorktreeId, fallbackWorktreeId);
    assert.equal(fallbackAuditEvents[0].data.worktreeIdCanonicalized, false);
    assert.equal(fallbackAuditEvents[0].data.canonicalizeFallback.reason, 'resolve_failed');
    assert.equal(fallbackAuditEvents[0].data.canonicalizeFallback.errorCode, 'NOT_FOUND');

    await appFallback.close();
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
    appendedAuditEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: 'test-wt', path: 'package.json', threadId: 'thread-abc', catId: 'gpt52' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(emittedEvents[0].data.threadId, 'thread-abc');
    assert.equal(emittedEvents[1].data.threadId, 'thread-abc');
    assert.equal(appendedAuditEvents.length, 1);
    assert.equal(appendedAuditEvents[0].threadId, 'thread-abc');
    assert.equal(appendedAuditEvents[0].data.catId, 'gpt52');
  });

  it('records audit events for knowledge-feed navigation', async () => {
    emittedEvents.length = 0;
    appendedAuditEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: { worktreeId: 'test-wt', action: 'knowledge-feed', threadId: 'thread-knowledge', catId: 'gpt52' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.action, 'knowledge-feed');
    assert.equal(emittedEvents.length, 1);
    assert.equal(emittedEvents[0].room, 'workspace:global');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(appendedAuditEvents.length, 1);
    assert.equal(appendedAuditEvents[0].type, 'workspace_navigate');
    assert.equal(appendedAuditEvents[0].threadId, 'thread-knowledge');
    assert.deepEqual(appendedAuditEvents[0].data, {
      worktreeId: 'test-wt',
      path: '',
      action: 'knowledge-feed',
      line: undefined,
      catId: 'gpt52',
    });
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
