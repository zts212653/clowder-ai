import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { readLinkedRootState } from '../src/domains/workspace/roots/workspace-linked-root-store.js';
import { addLinkedRoot } from '../src/domains/workspace/roots/workspace-linked-roots.js';
import type { SocketManager } from '../src/infrastructure/websocket/SocketManager.js';
import { type SidebarPresence, type SidebarPresenceSource } from '../src/routes/sidebar-presence-projection.js';
import { threadsRoutes } from '../src/routes/threads.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

type Emitted = { userId: string; event: string; data: unknown };

const EVENT = 'entrusted_work_projection_invalidated';

test('linked root removal notifies only after a real removal and never with a threadId', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'issue1864-revoke-root-'));
  const cwd = process.cwd();
  const priorDataDir = process.env.CAT_CAFE_DATA_DIR;
  const priorWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
  const app = Fastify();
  try {
    const root = join(temp, 'selected');
    await mkdir(root);
    process.chdir(temp);
    process.env.CAT_CAFE_DATA_DIR = join(temp, 'state');
    const entry = await addLinkedRoot('revocation-root', root);
    const epoch = readLinkedRootState().rootEpochs[entry.id] ?? 0;
    const emitted: Emitted[] = [];
    await app.register(workspaceRoutes, {
      auditLog: new EventAuditLog({ auditDir: join(temp, 'audit') }),
      socketEmitToUser: (userId, event, data) => emitted.push({ userId, event, data }),
    });
    const remove = (
      id: string,
      expectedEpoch: number,
      headers: Record<string, string> = { 'x-cat-cafe-user': 'operator' },
    ) =>
      app.inject({
        method: 'DELETE',
        url: `/api/workspace/linked-roots?${new URLSearchParams({ id, expectedEpoch: String(expectedEpoch) })}`,
        headers,
      });

    const unauthenticated = await remove(entry.id, epoch, {});
    assert.equal(unauthenticated.statusCode, 401);
    assert.deepEqual(emitted, []);

    const stale = await remove(entry.id, epoch - 1);
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(emitted, [], 'a failed removal must not notify');

    const missing = await remove('missing-root', 0);
    assert.equal(missing.statusCode, 200);
    assert.deepEqual(missing.json(), { ok: true, removed: false });
    assert.deepEqual(emitted, [], 'a no-op removal must not notify');

    const removed = await remove(entry.id, epoch);
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json(), { ok: true, removed: true });
    assert.deepEqual(emitted, [
      {
        userId: 'operator',
        event: EVENT,
        data: { ownerUserId: 'operator', reason: 'access_revoked' },
      },
    ]);
  } finally {
    await app.close();
    process.chdir(cwd);
    if (priorDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorDataDir;
    if (priorWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    else process.env.CAT_CAFE_WORKSPACE_ROOT = priorWorkspaceRoot;
    await rm(temp, { recursive: true, force: true });
  }
});

test('thread soft-delete notifies with its threadId once, and a no-op delete does not notify', async () => {
  const app = Fastify();
  const threadStore = new ThreadStore();
  const emitted: Emitted[] = [];
  const socketManager = {
    emitToUser: (userId: string, event: string, data: unknown) => emitted.push({ userId, event, data }),
  } as unknown as SocketManager;
  const presenceSource: SidebarPresenceSource = {
    async getPresence() {
      return new Map<string, SidebarPresence>();
    },
  };
  try {
    await app.register(threadsRoutes, { threadStore, presenceSource, socketManager });
    const thread = threadStore.create('operator', 'revocation-thread');
    const remove = () =>
      app.inject({
        method: 'DELETE',
        url: `/api/threads/${thread.id}`,
        headers: { 'x-cat-cafe-user': 'operator' },
      });

    const deleted = await remove();
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.deepEqual(emitted, [
      {
        userId: 'operator',
        event: EVENT,
        data: { ownerUserId: 'operator', threadId: thread.id, reason: 'access_revoked' },
      },
    ]);

    const again = await remove();
    assert.equal(again.statusCode, 400);
    assert.equal(emitted.length, 1, 'a failed second delete must not notify again');
  } finally {
    await app.close();
  }
});
