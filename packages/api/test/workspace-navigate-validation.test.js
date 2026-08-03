import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { EventAuditLog } from '../dist/domains/cats/services/orchestration/EventAuditLog.js';
import { registerWorktrees } from '../dist/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../dist/routes/workspace.js';

const NAVIGATE_HEADERS = { 'x-cat-cafe-user': 'default-user' };

describe('POST /api/workspace/navigate body validation', () => {
  const app = Fastify();
  const emittedEvents = [];
  const auditEvents = [];
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

  before(async () => {
    registerWorktrees([{ id: 'validation-wt', root: repoRoot, branch: 'main', head: 'abc123' }]);
    const auditLog = new EventAuditLog({ auditDir: '/tmp/cat-cafe-workspace-navigate-validation-test' });
    auditLog.append = async (input) => {
      auditEvents.push(input);
      return { id: 'audit-validation', timestamp: Date.now(), ...input };
    };
    await app.register(workspaceRoutes, {
      socketEmit: (event, data, room) => emittedEvents.push({ event, data, room }),
      auditLog,
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('rejects malformed typed fields before filesystem, Socket, or audit work', async () => {
    const malformedBodies = [
      { worktreeId: 'validation-wt', path: 42 },
      { worktreeId: 'validation-wt', path: 'package.json', action: 'launch' },
      { worktreeId: 'validation-wt', path: 'package.json', line: '7' },
      { worktreeId: 'validation-wt', path: 'package.json', line: 0 },
      { worktreeId: 7, path: 'package.json' },
      { action: 'knowledge-feed', threadId: 9 },
      { action: 'knowledge-feed', threadId: 'thread-validation', catId: 9 },
    ];

    for (const payload of malformedBodies) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/workspace/navigate',
        headers: NAVIGATE_HEADERS,
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emittedEvents.length, 0);
    assert.equal(auditEvents.length, 0);
  });

  it('rejects non-string document hrefs before path resolution', async () => {
    for (const href of [123, {}, []]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/workspace/resolve-document-link',
        headers: NAVIGATE_HEADERS,
        payload: { href },
      });
      assert.equal(response.statusCode, 400, JSON.stringify({ href }));
    }
  });
});
