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
  mutateLinkedRootState,
  readLinkedRootState,
} from '../src/domains/workspace/roots/workspace-linked-root-store.js';
import { addLinkedRoot } from '../src/domains/workspace/roots/workspace-linked-roots.js';
import { connectWorkspaceRoot } from '../src/domains/workspace/roots/workspace-root-connection.js';
import { workspaceRoutes } from '../src/routes/workspace.js';
import { withRootProof } from './helpers/root-connection-request.js';

for (const format of ['v2', 'legacy'] as const) {
  test(`a missing unrelated ${format} root cannot block explicit connections through either writer or file admission`, async () => {
    const temp = await mkdtemp(join(tmpdir(), 'f309-missing-linked-'));
    const cwd = process.cwd();
    const prior = {
      data: process.env.CAT_CAFE_DATA_DIR,
      root: process.env.CAT_CAFE_WORKSPACE_ROOT,
      linked: process.env.WORKSPACE_LINKED_ROOTS,
    };
    const app = Fastify();
    try {
      const host = join(temp, 'host');
      const old = join(temp, 'gone');
      const next = join(temp, 'new');
      const manual = join(temp, 'manual');
      await Promise.all([host, old, next, manual].map((path) => mkdir(path)));
      await promisify(execFile)('git', ['init', '-q', host]);
      process.chdir(host);
      process.env.CAT_CAFE_DATA_DIR = join(temp, 'state');
      process.env.CAT_CAFE_WORKSPACE_ROOT = host;
      delete process.env.WORKSPACE_LINKED_ROOTS;
      if (format === 'v2') await connectWorkspaceRoot('operator', 'old-connection', await realpath(old), 0);
      else
        mutateLinkedRootState((state) => {
          state.roots.push({ name: 'old', path: old });
          return { value: undefined, changed: true };
        });
      await rm(old, { recursive: true });
      await writeFile(join(next, 'notes.txt'), 'new root remains usable');
      await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(temp, 'audit') }) });
      const headers = { 'x-cat-cafe-user': 'operator' };
      const connect = await app.inject({
        method: 'POST',
        url: '/api/workspace/root-connections',
        headers,
        payload: withRootProof({
          root: await realpath(next),
          operationId: 'connect-good',
          expectedEpoch: 0,
          expectedUserId: 'operator',
        }),
      });
      assert.equal(connect.statusCode, 200, connect.body);
      await addLinkedRoot('manual', manual);
      const unseen = join(temp, 'unseen');
      await mkdir(unseen);
      await writeFile(join(unseen, 'notes.txt'), 'future connection');
      const prepared = await app.inject({
        method: 'POST',
        url: '/api/workspace/resolve-file-source',
        headers,
        payload: { selectedRoot: await realpath(unseen), selectionEpoch: 0, path: 'notes.txt' },
      });
      assert.equal(prepared.statusCode, 409, prepared.body);
      assert.equal(prepared.json().error.code, 'directory_inventory_unavailable');
      assert.equal(
        prepared.json().error.locations[0].label,
        'gone',
        'incomplete inventory is actionable, not a false absence proof',
      );
      assert.equal(
        readLinkedRootState().roots.length,
        3,
        'missing rows are preserved; metadata reads never register roots',
      );
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
}
