import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { registerWorktrees } from '../dist/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../dist/routes/workspace.js';

const NAVIGATE_HEADERS = { 'x-cat-cafe-user': 'default-user' };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('POST /api/workspace/navigate delivery receipts', () => {
  it('reports applied when any acknowledged Hub client applied the event', async () => {
    const app = Fastify();
    registerWorktrees([{ id: 'ack-wt', root: repoRoot, branch: 'main', head: 'abc123' }]);
    await app.register(workspaceRoutes, {
      socketEmitWithAck: async (_event, data, room) => {
        assert.equal(room, 'workspace:navigate:ack');
        return [
          { status: 'queued', eventId: data.eventId, reason: 'thread_inactive' },
          { status: 'applied', eventId: data.eventId },
        ];
      },
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/workspace/navigate',
        headers: NAVIGATE_HEADERS,
        payload: { worktreeId: 'ack-wt', path: 'package.json', action: 'open', threadId: 'thread-ack' },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.deliveryStatus, 'applied');
      assert.equal(body.deliveryReason, undefined);
    } finally {
      await app.close();
    }
  });

  it('reports blocked ahead of queued, and unconfirmed when no client acknowledges', async () => {
    const app = Fastify();
    let receipts = [];
    registerWorktrees([{ id: 'ack-priority-wt', root: repoRoot, branch: 'main', head: 'abc123' }]);
    await app.register(workspaceRoutes, {
      socketEmitWithAck: async (_event, data) =>
        receipts.map((receipt) => ({
          ...receipt,
          eventId: data.eventId,
        })),
    });
    await app.ready();

    try {
      receipts = [
        { status: 'queued', reason: 'thread_inactive' },
        { status: 'blocked', reason: 'presentation_lock' },
      ];
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/workspace/navigate',
        headers: NAVIGATE_HEADERS,
        payload: { worktreeId: 'ack-priority-wt', path: 'package.json', action: 'open' },
      });
      assert.equal(JSON.parse(blocked.body).deliveryStatus, 'blocked');
      assert.equal(JSON.parse(blocked.body).deliveryReason, 'presentation_lock');

      receipts = [];
      const unconfirmed = await app.inject({
        method: 'POST',
        url: '/api/workspace/navigate',
        headers: NAVIGATE_HEADERS,
        payload: { worktreeId: 'ack-priority-wt', path: 'package.json', action: 'open' },
      });
      assert.equal(JSON.parse(unconfirmed.body).deliveryStatus, 'unconfirmed');
      assert.equal(JSON.parse(unconfirmed.body).deliveryReason, 'no_client_ack');
    } finally {
      await app.close();
    }
  });
});
