import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import {
  linkedRootConfigPath,
  mutateLinkedRootState,
  readLinkedRootState,
} from '../src/domains/workspace/roots/workspace-linked-root-store.js';
import { addLinkedRoot, removeLinkedRoot } from '../src/domains/workspace/roots/workspace-linked-roots.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

test('an unregistered absolute artifact offers its exact current directory without borrowing a current project', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'f309-absolute-unconnected-')));
  const cwd = process.cwd();
  const priorData = process.env.CAT_CAFE_DATA_DIR;
  const priorRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
  const priorLinked = process.env.WORKSPACE_LINKED_ROOTS;
  let app = Fastify();
  try {
    const host = join(temp, 'host');
    const fileDirectory = join(temp, 'external', 'documents');
    await Promise.all([mkdir(host), mkdir(fileDirectory, { recursive: true })]);
    await promisify(execFile)('git', ['init', '-q', host]);
    process.chdir(host);
    process.env.CAT_CAFE_DATA_DIR = join(temp, 'state');
    process.env.CAT_CAFE_WORKSPACE_ROOT = host;
    delete process.env.WORKSPACE_LINKED_ROOTS;
    const filePath = join(fileDirectory, 'notes.txt');
    await writeFile(filePath, 'absolute native source without recorded project root');
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(temp, 'audit') }) });
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: { path: filePath },
    });
    assert.equal(readLinkedRootState().roots.length, 0);
    assert.equal(readLinkedRootState().operations.length, 0);
    await assert.rejects(readFile(linkedRootConfigPath()), { code: 'ENOENT' });
    assert.equal(response.statusCode, 200, `known absolute file remains unusable: ${response.body}`);
    assert.equal(response.json().kind, 'connection-required');
    assert.equal(response.json().root, await realpath(fileDirectory));
    assert.equal(response.json().path, 'notes.txt');
    assert.equal(response.json().admission, 'absolute-file-directory');
    const headers = { 'x-cat-cafe-user': 'operator' };
    const operation = {
      root: response.json().root,
      expectedUserId: 'operator',
      expectedEpoch: response.json().expectedEpoch,
      admission: response.json().admission,
      connectionProof: response.json().connectionProof,
      operationId: 'absolute-confirmed',
    };
    const connected = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: operation,
    });
    assert.equal(connected.statusCode, 200, connected.body);
    const open = () =>
      app.inject({ method: 'POST', url: '/api/workspace/resolve-file-source', headers, payload: { path: filePath } });
    const landing = await open();
    assert.equal(landing.statusCode, 200, landing.body);
    assert.equal(landing.json().kind, 'file');
    await app.close();
    const restarted = join(temp, 'restarted');
    await mkdir(restarted);
    process.chdir(restarted);
    app = Fastify();
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(temp, 'audit') }) });
    assert.deepEqual((await open()).json(), landing.json());
    const file = await app.inject({
      method: 'GET',
      headers,
      url: `/api/workspace/file?${new URLSearchParams({ worktreeId: landing.json().worktreeId, path: landing.json().path })}`,
    });
    assert.equal(file.statusCode, 200, file.body);
    assert.equal(file.json().content, 'absolute native source without recorded project root');
    await removeLinkedRoot(connected.json().linked.id, connected.json().currentEpoch);
    assert.equal((await open()).statusCode, 403, 'removed directory is not offered as a new grant');

    for (const format of ['v2', 'legacy']) {
      const parent = join(temp, `previous-${format}`);
      const child = join(parent, 'documents');
      await mkdir(child, { recursive: true });
      await writeFile(join(child, 'file.txt'), 'retained original');
      let id: string;
      if (format === 'v2') id = (await addLinkedRoot(`prior-${format}`, parent)).id;
      else {
        mutateLinkedRootState((state) => {
          state.roots.push({ name: 'prior-legacy', path: parent });
          return { value: undefined, changed: true };
        });
        id = 'linked_prior-legacy';
      }
      await removeLinkedRoot(id);
      const revoked = await app.inject({
        method: 'POST',
        url: '/api/workspace/resolve-file-source',
        headers,
        payload: { path: join(child, 'file.txt') },
      });
      assert.equal(revoked.statusCode, 403, `${format} ancestor removal cannot suggest connecting a child`);
    }

    const changingParent = join(temp, 'changing');
    const changingChild = join(changingParent, 'documents');
    await mkdir(changingChild, { recursive: true });
    await writeFile(join(changingChild, 'file.txt'), 'new candidate');
    const prepare = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: { path: join(changingChild, 'file.txt') },
    });
    assert.equal(prepare.json().kind, 'connection-required');
    const parentGrant = await addLinkedRoot('changing-parent', changingParent);
    await removeLinkedRoot(parentGrant.id);
    const late = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: {
        ...operation,
        root: changingChild,
        connectionProof: prepare.json().connectionProof,
        operationId: 'late-absolute-confirmation',
      },
    });
    assert.equal(late.statusCode, 409, late.body);
    assert.equal(late.json().error.code, 'ancestor_connection_removed');

    const denied = join(temp, 'unregistered');
    await mkdir(denied);
    await writeFile(join(denied, '.env'), 'private');
    await writeFile(join(denied, 'real.txt'), 'source');
    await symlink(join(denied, 'real.txt'), join(denied, 'link.txt'));
    for (const name of ['.env', 'link.txt', 'missing.txt']) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/workspace/resolve-file-source',
        headers,
        payload: { path: join(denied, name) },
      });
      assert.equal(result.statusCode, name === 'missing.txt' ? 404 : 403, result.body);
    }
  } finally {
    await app.close();
    process.chdir(cwd);
    if (priorData === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorData;
    if (priorRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    else process.env.CAT_CAFE_WORKSPACE_ROOT = priorRoot;
    if (priorLinked === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = priorLinked;
    await rm(temp, { recursive: true, force: true });
  }
});
