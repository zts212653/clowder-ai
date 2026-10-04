import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import { connectWorkspaceRoot } from '../src/domains/workspace/roots/workspace-root-connection.js';
import { issueRootConnectionProof } from '../src/domains/workspace/roots/workspace-root-proof.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

test('connection proof survives another process and its signing key is not available through Workspace', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'f309-root-proof-')));
  const priorData = process.env.CAT_CAFE_DATA_DIR;
  const priorLinked = process.env.WORKSPACE_LINKED_ROOTS;
  const cwd = process.cwd();
  const app = Fastify();
  try {
    process.env.CAT_CAFE_DATA_DIR = join(root, 'state');
    delete process.env.WORKSPACE_LINKED_ROOTS;
    process.chdir(root);
    const claims = { userId: 'operator', root, expectedEpoch: 0, source: { kind: 'directory-selection' as const } };
    const proof = issueRootConnectionProof(claims);
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./helpers/workspace-root-proof-child.ts', import.meta.url)),
      ],
      { cwd: elsewhere, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      error += String(chunk);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    child.stdin.end(proof);
    assert.equal(await exited, 0, error);
    assert.deepEqual(JSON.parse(output), claims);
    const connection = await connectWorkspaceRoot('operator', 'explicit-root', root, 0);
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(root, 'audit') }) });
    const denied = await app.inject({
      method: 'GET',
      headers: { 'x-cat-cafe-user': 'operator' },
      url: `/api/workspace/file?${new URLSearchParams({ worktreeId: connection.linked.id, path: 'state/workspace/secrets/root-preparation.key' })}`,
    });
    assert.equal(denied.statusCode, 403, 'a connection must never expose the signing key');
  } finally {
    await app.close();
    process.chdir(cwd);
    if (priorData === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorData;
    if (priorLinked === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = priorLinked;
    await rm(root, { recursive: true, force: true });
  }
});
