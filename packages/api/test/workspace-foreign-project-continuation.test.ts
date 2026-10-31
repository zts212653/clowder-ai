import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import {
  linkedRootConfigPath,
  readLinkedRootState,
} from '../src/domains/workspace/roots/workspace-linked-root-store.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

test('a file selected from an external project tree can continue into the common content owner', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'f309-foreign-project-'));
  const root = join(temp, 'foreign');
  let app = Fastify();
  const cwd = process.cwd();
  const priorDataDir = process.env.CAT_CAFE_DATA_DIR;
  const priorWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
  try {
    const host = join(temp, 'host');
    await Promise.all([mkdir(root), mkdir(host)]);
    process.chdir(host);
    process.env.CAT_CAFE_DATA_DIR = join(temp, 'state');
    process.env.CAT_CAFE_WORKSPACE_ROOT = host;
    await promisify(execFile)('git', ['init', '-q', host]);
    await promisify(execFile)('git', ['init', '-q', root]);
    await writeFile(join(root, 'notes.txt'), 'original external project file');
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(root, 'audit') }) });
    const headers = { 'x-cat-cafe-user': 'operator' };
    const discovery = await app.inject({
      method: 'GET',
      url: `/api/workspace/worktrees?${new URLSearchParams({ repoRoot: root })}`,
      headers,
    });
    assert.equal(discovery.statusCode, 200, discovery.body);
    const worktree = discovery
      .json()
      .worktrees.find((entry: { root: string }) => basename(entry.root) === basename(root));
    assert.ok(worktree, discovery.body);
    const file = await app.inject({
      method: 'GET',
      url: `/api/workspace/file?${new URLSearchParams({ worktreeId: worktree.id, path: 'notes.txt' })}`,
      headers,
    });
    assert.equal(file.statusCode, 200, file.body);
    assert.equal(file.json().content, 'original external project file');
    const request = {
      worktreeId: worktree.id,
      path: 'notes.txt',
      selectedRoot: worktree.resolvedRoot,
      selectionEpoch: worktree.rootEpoch,
    };
    assert.ok(request.selectedRoot, 'the actual discovery captures the selected physical root');
    const before = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: request,
    });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().kind, 'connection-required');
    assert.equal(readLinkedRootState().roots.length, 0, 'preparing a signing key is not a directory grant');
    assert.equal(readLinkedRootState().operations.length, 0, 'opening is not an applied connection');
    await assert.rejects(
      readFile(linkedRootConfigPath()),
      { code: 'ENOENT' },
      'preparation does not write the connection registry',
    );
    const connect = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: {
        operationId: 'explicit-human-connect',
        root: before.json().root,
        expectedEpoch: before.json().expectedEpoch,
        expectedUserId: before.json().ownerUserId,
        connectionProof: before.json().connectionProof,
      },
    });
    assert.equal(connect.statusCode, 200, connect.body);
    const landing = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: request,
    });
    assert.equal(landing.statusCode, 200, `native tree/file is readable but common landing failed: ${landing.body}`);
    assert.equal(landing.json().kind, 'file');
    assert.match(landing.json().worktreeId, /^f063_root_v1_[a-f0-9]{64}$/);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: { ...request, path: 'missing.txt' },
    });
    assert.equal(missing.statusCode, 404, 'a missing file in a connected root is not a reconnection or service error');
    const changedHuman = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: { ...request, expectedUserId: 'someone-else' },
    });
    assert.equal(changedHuman.statusCode, 409, 'a location choice remains bound to the displayed human');
    await app.close();
    const restart = join(temp, 'restart');
    await mkdir(restart);
    process.chdir(restart);
    app = Fastify();
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(root, 'audit') }) });
    const fileUrl = `/api/workspace/file?${new URLSearchParams({ worktreeId: landing.json().worktreeId, path: 'notes.txt' })}`;
    const reopened = await app.inject({ method: 'GET', url: fileUrl, headers });
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal(reopened.json().content, 'original external project file');
    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/workspace/linked-roots?id=${connect.json().linked.id}&expectedEpoch=${connect.json().currentEpoch}`,
      headers,
    });
    assert.equal(remove.statusCode, 200, remove.body);
    assert.equal((await app.inject({ method: 'GET', url: fileUrl, headers })).statusCode, 404);
    const staleSelection = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: request,
    });
    assert.equal(
      staleSelection.statusCode,
      403,
      'restoring an old selection must not offer reconnection after removal',
    );
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
