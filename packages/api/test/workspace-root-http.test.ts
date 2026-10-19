import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import {
  linkedRootConfigPath,
  readLinkedRootState,
} from '../src/domains/workspace/roots/workspace-linked-root-store.js';
import { verifyRootConnectionProof } from '../src/domains/workspace/roots/workspace-root-proof.js';
import { workspaceRoutes } from '../src/routes/workspace.js';
import { rootStoreFixture } from './helpers/workspace-root-store-fixture.js';

for (const source of ['directory-selection', 'absolute-file'] as const) {
  test(`native HTTP ${source}: cold prepare, connect, lookup, open, restart and removed replay`, async (t) => {
    const root = await rootStoreFixture(t);
    const host = join(root, 'host');
    const selected = join(root, 'selected');
    await mkdir(host);
    await mkdir(selected);
    await promisify(execFile)('git', ['init', '-q', host]);
    process.chdir(host);
    process.env.CAT_CAFE_WORKSPACE_ROOT = host;
    const target = join(selected, 'notes.txt');
    await writeFile(target, 'workspace native HTTP contents');
    const start = async () => {
      const app = Fastify();
      await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(root, 'audit') }) });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      return { app, address };
    };
    let server = await start();
    t.after(() => server.app.close());
    const request = async (url: string, body?: unknown, method = body ? 'POST' : 'GET') => {
      const response = await fetch(`${server.address}${url}`, {
        method,
        headers: { 'x-cat-cafe-user': 'operator', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = await response.json();
      assert.equal(response.status, 200, `${method} ${url}: ${JSON.stringify(value)}`);
      return value;
    };
    const prepared = await request(
      '/api/workspace/resolve-file-source',
      source === 'directory-selection'
        ? { selectedRoot: selected, selectionEpoch: 0, path: 'notes.txt' }
        : { path: target },
    );
    assert.equal(prepared.kind, 'connection-required');
    assert.equal(verifyRootConnectionProof(prepared.connectionProof)?.source.kind, source);
    const payload = {
      root: prepared.root,
      operationId: 'native-http',
      expectedEpoch: 0,
      expectedUserId: 'operator',
      connectionProof: prepared.connectionProof,
      ...(source === 'absolute-file' ? { admission: prepared.admission } : {}),
    };
    const first = await request('/api/workspace/root-connections', payload);
    assert.equal(first.connected, true);
    assert.equal(first.currentEpoch, 1);
    const committed = readFileSync(linkedRootConfigPath(), 'utf8');
    assert.equal((await request('/api/workspace/root-connections', payload)).receiptRef, first.receiptRef);
    assert.equal(readFileSync(linkedRootConfigPath(), 'utf8'), committed);
    const lookup = '/api/workspace/root-connections?operationId=native-http';
    assert.equal((await request(lookup)).receiptRef, first.receiptRef);
    const resolved = await request('/api/workspace/resolve-file-source', { path: target });
    assert.equal(resolved.kind, 'file');
    const opened = await request(
      `/api/workspace/file?${new URLSearchParams({ worktreeId: first.linked.id, path: 'notes.txt' })}`,
    );
    assert.equal(opened.content, 'workspace native HTTP contents');
    await server.app.close();
    server = await start();
    assert.equal((await request(lookup)).receiptRef, first.receiptRef);
    await request(
      `/api/workspace/linked-roots?${new URLSearchParams({ id: first.linked.id, expectedEpoch: '1' })}`,
      undefined,
      'DELETE',
    );
    const removed = await request(lookup);
    assert.equal(removed.connected, false);
    assert.equal(removed.currentEpoch, 2);
    const replay = await request('/api/workspace/root-connections', payload);
    assert.equal(replay.connected, false);
    assert.equal(replay.receiptRef, first.receiptRef);
    assert.equal(readLinkedRootState().roots.length, 0);
    assert.equal(readLinkedRootState().operations.length, 1);
  });
}
