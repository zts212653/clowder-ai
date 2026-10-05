import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import {
  type RootConnectionSource,
  readLinkedRootState,
} from '../src/domains/workspace/roots/workspace-linked-root-store.js';
import { addLinkedRoot, removeLinkedRoot } from '../src/domains/workspace/roots/workspace-linked-roots.js';
import {
  issueRootConnectionProof,
  verifyRootConnectionProof,
} from '../src/domains/workspace/roots/workspace-root-proof.js';
import { workspaceRoutes } from '../src/routes/workspace.js';
import { issueReconnectionProofForChangedConnection } from '../src/routes/workspace-root-connection-routes.js';

test('ancestor removal cannot be bypassed by omitting the admission label on the same prepared file connection', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'f309-connection-origin-')));
  const cwd = process.cwd();
  const prior = {
    data: process.env.CAT_CAFE_DATA_DIR,
    root: process.env.CAT_CAFE_WORKSPACE_ROOT,
    linked: process.env.WORKSPACE_LINKED_ROOTS,
  };
  const app = Fastify();
  try {
    const host = join(temp, 'host');
    const parent = join(temp, 'A');
    const child = join(parent, 'sub');
    await Promise.all([mkdir(host), mkdir(child, { recursive: true })]);
    await promisify(execFile)('git', ['init', '-q', host]);
    process.chdir(host);
    process.env.CAT_CAFE_DATA_DIR = join(temp, 'state');
    process.env.CAT_CAFE_WORKSPACE_ROOT = host;
    delete process.env.WORKSPACE_LINKED_ROOTS;
    const path = join(child, 'file.txt');
    await writeFile(path, 'file source');
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(temp, 'audit') }) });
    const headers = { 'x-cat-cafe-user': 'operator' };
    const prepared = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: { path },
    });
    assert.equal(prepared.statusCode, 200, prepared.body);
    const ancestor = await addLinkedRoot('A', parent);
    await removeLinkedRoot(ancestor.id);
    const refused = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: { path },
    });
    assert.equal(refused.statusCode, 403);
    for (const supplied of [false, true]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/workspace/root-connections',
        headers,
        payload: {
          root: child,
          expectedUserId: 'operator',
          expectedEpoch: 0,
          operationId: `same-file-${supplied}`,
          ...(prepared.json().connectionProof ? { connectionProof: prepared.json().connectionProof } : {}),
          ...(supplied ? { admission: 'absolute-file-directory' } : {}),
        },
      });
      assert.equal(response.statusCode, 409, `supplied=${supplied}: ${response.body}`);
      assert.equal(response.json().error.code, 'ancestor_connection_removed');
      assert.equal(readLinkedRootState().roots.length, 0);
    }
    const common = { root: child, expectedUserId: 'operator', expectedEpoch: 0, operationId: 'forged-source' };
    const unsigned = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: common,
    });
    assert.equal(unsigned.statusCode, 400, 'a raw root is not a server-verified selection');
    const proof: string = prepared.json().connectionProof;
    const [encoded, signature] = proof.split('.');
    const forged = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
    forged.source = { kind: 'directory-selection' };
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: { ...common, connectionProof: tampered },
    });
    assert.equal(invalid.statusCode, 409);
    assert.equal(invalid.json().error.code, 'invalid_connection_proof');
    const otherUser = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers: { 'x-cat-cafe-user': 'other' },
      payload: { ...common, expectedUserId: 'other', connectionProof: proof },
    });
    assert.equal(otherUser.statusCode, 409);
    const selected = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: { selectedRoot: child, selectionEpoch: 0, path: 'file.txt' },
    });
    assert.equal(selected.statusCode, 200, selected.body);
    const explicit = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: { ...common, operationId: 'new-explicit-selection', connectionProof: selected.json().connectionProof },
    });
    assert.equal(explicit.statusCode, 200, explicit.body);
    assert.equal(
      explicit.json().source.kind,
      'directory-selection',
      'fresh explicit selection is a different server-certified source',
    );
    const changedSource = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: { ...common, operationId: 'new-explicit-selection', connectionProof: proof },
    });
    assert.equal(changedSource.statusCode, 409, 'an applied operation cannot change its certified source');
  } finally {
    await app.close();
    process.chdir(cwd);
    for (const [key, value] of Object.entries({
      CAT_CAFE_DATA_DIR: prior.data,
      CAT_CAFE_WORKSPACE_ROOT: prior.root,
      WORKSPACE_LINKED_ROOTS: prior.linked,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});

test('changed-connection proof renewal is limited to directory selections', () => {
  const absolute = verifyRootConnectionProof(
    issueRootConnectionProof({
      userId: 'operator',
      root: '/workspace/absolute',
      expectedEpoch: 0,
      source: { kind: 'absolute-file', path: '/workspace/absolute/notes.txt' },
    }),
  );
  assert.equal(issueReconnectionProofForChangedConnection(absolute, 1), undefined);

  const directory = verifyRootConnectionProof(
    issueRootConnectionProof({
      userId: 'operator',
      root: '/workspace/selected',
      expectedEpoch: 0,
      source: { kind: 'directory-selection' },
    }),
  );
  assert.equal(typeof issueReconnectionProofForChangedConnection(directory, 1), 'string');
});

test('connection changes do not renew an absolute-file proof in the POST error response', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'f309-connection-proof-')));
  const cwd = process.cwd();
  const prior = {
    data: process.env.CAT_CAFE_DATA_DIR,
    root: process.env.CAT_CAFE_WORKSPACE_ROOT,
    linked: process.env.WORKSPACE_LINKED_ROOTS,
  };
  const app = Fastify();
  try {
    const absoluteRoot = join(temp, 'absolute');
    const selectedRoot = join(temp, 'selected');
    await Promise.all([mkdir(absoluteRoot), mkdir(selectedRoot)]);
    process.chdir(absoluteRoot);
    process.env.CAT_CAFE_DATA_DIR = join(temp, 'state');
    process.env.CAT_CAFE_WORKSPACE_ROOT = absoluteRoot;
    delete process.env.WORKSPACE_LINKED_ROOTS;
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(temp, 'audit') }) });
    const headers = { 'x-cat-cafe-user': 'operator' };

    const connect = async (root: string, operationId: string, source: RootConnectionSource) => {
      const proof = issueRootConnectionProof({ userId: 'operator', root, expectedEpoch: 0, source });
      return app.inject({
        method: 'POST',
        url: '/api/workspace/root-connections',
        headers,
        payload: {
          root,
          operationId,
          expectedEpoch: 0,
          expectedUserId: 'operator',
          ...(source.kind === 'absolute-file' ? { admission: 'absolute-file-directory' } : {}),
          connectionProof: proof,
        },
      });
    };

    const absoluteProof = issueRootConnectionProof({
      userId: 'operator',
      root: absoluteRoot,
      expectedEpoch: 0,
      source: { kind: 'absolute-file', path: join(absoluteRoot, 'notes.txt') },
    });
    const absoluteFirst = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: {
        root: absoluteRoot,
        operationId: 'absolute-first',
        expectedEpoch: 0,
        expectedUserId: 'operator',
        admission: 'absolute-file-directory',
        connectionProof: absoluteProof,
      },
    });
    assert.equal(absoluteFirst.statusCode, 200, absoluteFirst.body);
    assert.equal(await removeLinkedRoot(absoluteFirst.json().linked.id), true);

    const absoluteRetry = await app.inject({
      method: 'POST',
      url: '/api/workspace/root-connections',
      headers,
      payload: {
        root: absoluteRoot,
        operationId: 'absolute-retry',
        expectedEpoch: 0,
        expectedUserId: 'operator',
        admission: 'absolute-file-directory',
        connectionProof: absoluteProof,
      },
    });
    assert.equal(absoluteRetry.statusCode, 409, absoluteRetry.body);
    assert.equal(absoluteRetry.json().error.code, 'ancestor_connection_removed');
    assert.equal('connectionProof' in absoluteRetry.json().error, false);

    const directoryFirst = await connect(selectedRoot, 'directory-first', { kind: 'directory-selection' });
    assert.equal(directoryFirst.statusCode, 200, directoryFirst.body);
    assert.equal(await removeLinkedRoot(directoryFirst.json().linked.id), true);
    const directoryRetry = await connect(selectedRoot, 'directory-retry', { kind: 'directory-selection' });
    assert.equal(directoryRetry.statusCode, 409, directoryRetry.body);
    assert.equal(directoryRetry.json().error.code, 'connection_changed');
    assert.equal(typeof directoryRetry.json().error.connectionProof, 'string');
  } finally {
    await app.close();
    process.chdir(cwd);
    for (const [key, value] of Object.entries({
      CAT_CAFE_DATA_DIR: prior.data,
      CAT_CAFE_WORKSPACE_ROOT: prior.root,
      WORKSPACE_LINKED_ROOTS: prior.linked,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});
