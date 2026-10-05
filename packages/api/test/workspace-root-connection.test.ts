import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import { linkedRootConfigPath } from '../src/domains/workspace/roots/workspace-linked-root-store.js';
import { removeLinkedRoot } from '../src/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../src/routes/workspace.js';
import { withRootProof } from './helpers/root-connection-request.js';

test('human connection receipts survive response loss and removal without reactivating an old request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'f309-root-connection-'));
  const cwd = process.cwd();
  const priorDataDir = process.env.CAT_CAFE_DATA_DIR;
  const app = Fastify();
  const headers = { 'x-cat-cafe-user': 'operator' };
  try {
    process.chdir(dir);
    process.env.CAT_CAFE_DATA_DIR = join(dir, 'state');
    const root = join(dir, 'selected');
    await mkdir(root);
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(dir, 'audit') }) });
    const payload = {
      root: await realpath(root),
      operationId: 'connection-1',
      expectedEpoch: 0,
      expectedUserId: 'operator',
    };
    const connect = (requestHeaders: Record<string, string> = headers) =>
      app.inject({
        method: 'POST',
        url: '/api/workspace/root-connections',
        headers: requestHeaders,
        payload: withRootProof(payload),
      });
    assert.equal((await connect({})).statusCode, 401);
    assert.equal((await connect({ ...headers, 'x-invocation-id': 'cat' })).statusCode, 401);
    assert.equal((await connect({ 'x-cat-cafe-user': 'another-human' })).statusCode, 409);
    const nonCanonical = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: withRootProof({ ...payload, root: `${payload.root}/`, operationId: 'noncanonical' }),
    });
    assert.equal(nonCanonical.statusCode, 409);
    assert.equal(nonCanonical.json().error.code, 'root_not_canonical');
    const first = await connect();
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().connected, true);
    const before = await readFile(linkedRootConfigPath(), 'utf8');
    assert.equal((await connect()).json().receiptRef, first.json().receiptRef);
    assert.equal(await readFile(linkedRootConfigPath(), 'utf8'), before);
    assert.equal(await removeLinkedRoot(first.json().linked.id), true);
    const replay = await connect();
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().connected, false);
    assert.equal(replay.json().receiptRef, first.json().receiptRef);
    assert.equal(typeof replay.json().connectionProof, 'string');
    const stale = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: withRootProof({ ...payload, operationId: 'old-uncommitted-choice' }),
    });
    assert.equal(stale.statusCode, 409, 'a previously prepared but uncommitted intent cannot revive a removed root');
    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: withRootProof({ ...payload, root: dir }),
    });
    assert.equal(mismatch.statusCode, 409, mismatch.body);
    const fresh = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: {
        ...payload,
        operationId: 'explicit-reconnect',
        expectedEpoch: replay.json().currentEpoch,
        connectionProof: replay.json().connectionProof,
      },
    });
    assert.equal(fresh.statusCode, 200, fresh.body);
    const staleRemoval = await app.inject({
      method: 'DELETE',
      headers,
      url: `/api/workspace/linked-roots?${new URLSearchParams({ id: first.json().linked.id, expectedEpoch: String(first.json().currentEpoch) })}`,
    });
    assert.equal(staleRemoval.statusCode, 409, 'a stale removal cannot delete a newer explicit connection');
    assert.equal((await connect()).json().connected, true);
    await removeLinkedRoot(first.json().linked.id);
    await rename(root, `${root}-old`);
    await symlink(dir, root);
    const moved = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: withRootProof({ ...payload, operationId: 'root-drift', expectedEpoch: fresh.json().currentEpoch + 1 }),
    });
    assert.equal(moved.statusCode, 409, 'replaced directory cannot silently connect the symlink target');
    assert.equal(moved.json().error.code, 'root_changed');
  } finally {
    await app.close();
    process.chdir(cwd);
    if (priorDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorDataDir;
    await rm(dir, { recursive: true, force: true });
  }
});
