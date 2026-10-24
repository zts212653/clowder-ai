import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';

test('registered directory reveal uses the same local-human action fence and reauthorizes its path', async (t) => {
  const calls: Array<{ command: string; args: string[] }> = [];
  // Replace only the final process boundary before the route module captures it. No desktop app is launched.
  const original = childProcess.execFile;
  const runOriginal = promisify(original);
  const boundary = (() => {
    throw new Error('Only the asynchronous desktop boundary is expected');
  }) as typeof original;
  Object.defineProperty(boundary, promisify.custom, {
    value: async (command: string, args: string[], options: { timeout?: number; maxBuffer?: number }) => {
      if (command !== 'open') return runOriginal(command, args, options);
      calls.push({ command, args });
      return { stdout: '', stderr: '' };
    },
  });
  childProcess.execFile = boundary;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  });
  const { registerWorkspaceFileActions } = await import('../src/routes/workspace-file-actions.js');
  const { registerWorktrees } = await import('../src/domains/workspace/workspace-security.js');
  const root = await mkdtemp(join(tmpdir(), 'workspace-directory-action-'));
  await writeFile(join(root, 'file.md'), 'File');
  registerWorktrees([{ id: 'directory-action-fixture', root, head: '', branch: '' }]);
  const app = Fastify();
  registerWorkspaceFileActions(app, (request) => (request.headers['x-cat-cafe-user'] === 'owner' ? 'owner' : null));
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = '/api/workspace/file/actions/reveal?worktreeId=directory-action-fixture&path=.';
  const human = { host: 'localhost', 'x-cat-cafe-user': 'owner' };
  for (const headers of [
    { ...human, 'x-invocation-id': 'agent' },
    { ...human, 'x-callback-token': 'callback' },
    { ...human, 'x-agent-key-secret': 'agent' },
    { ...human, 'x-forwarded-for': '192.0.2.1' },
  ]) {
    const denied = await app.inject({ method: 'POST', url, headers });
    assert.equal(denied.statusCode, 403, denied.body);
  }
  assert.equal(calls.length, 0);
  const reveal = await app.inject({ method: 'POST', url, headers: human });
  assert.equal(reveal.statusCode, process.platform === 'darwin' ? 200 : 422, reveal.body);
  if (process.platform === 'darwin') {
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'open');
    assert.equal(calls[0]?.args[0], '-R');
  }
  const count = calls.length;
  const forged = await app.inject({ method: 'POST', url, headers: human, payload: { path: '/etc' } });
  assert.equal(forged.statusCode, 400);
  const directoryOpen = await app.inject({ method: 'POST', url: url.replace('/reveal?', '/open?'), headers: human });
  assert.equal(directoryOpen.statusCode, 404, 'Directories have no default-app open action');
  await rm(root, { recursive: true, force: true });
  const gone = await app.inject({ method: 'POST', url, headers: human });
  assert.equal(gone.statusCode, 404, 'The path is resolved again after the menu read');
  assert.equal(calls.length, count);
});
