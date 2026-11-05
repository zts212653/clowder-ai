import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';

let app;
let fixture;
let callsPath;
let previousPath;
const worktreeId = 'task229-files-fixture';
async function commands() {
  return (await readFile(callsPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function request(query = '') {
  return app.inject({ method: 'GET', url: `/api/workspace/diff?worktreeId=${worktreeId}${query}` });
}

before(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'task229-diff-files-'));
  const root = join(fixture, 'repo');
  const bin = join(fixture, 'bin');
  await mkdir(root);
  await mkdir(bin);
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const gitArgs = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
  execFileSync(git, [...gitArgs, 'init', '-q'], { cwd: root });
  await writeFile(join(root, 'tracked.txt'), 'before\n');
  execFileSync(git, [...gitArgs, 'add', 'tracked.txt'], { cwd: root });
  execFileSync(git, [...gitArgs, 'commit', '-qm', 'fixture'], { cwd: root });
  await writeFile(join(root, 'tracked.txt'), 'after\n');
  await writeFile(join(root, 'new.txt'), 'untracked patch body\n');
  await writeFile(join(root, '.env'), 'PRIVATE_FIXTURE_SECRET\n');
  callsPath = join(fixture, 'git-calls.jsonl');
  await writeFile(callsPath, '');
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env node
const {appendFileSync} = require('node:fs');
const {execFileSync} = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
try { execFileSync(${JSON.stringify(git)}, args, {stdio: 'inherit'}); }
catch (error) { process.exit(typeof error.status === 'number' ? error.status : 1); }
`,
    { mode: 0o755 },
  );
  previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  const { registerWorktrees } = await import('../dist/domains/workspace/workspace-security.js');
  registerWorktrees([{ id: worktreeId, root, branch: 'fixture', head: 'fixture' }]);
  const { workspaceRoutes } = await import('../dist/routes/workspace.js');
  app = Fastify();
  await app.register(workspaceRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (previousPath !== undefined) process.env.PATH = previousPath;
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

test('files view uses the full view file list without spawning any patch commands', async () => {
  const full = await request();
  assert.equal(full.statusCode, 200);
  assert.match(full.json().diff, /untracked patch body/);
  await writeFile(callsPath, '');
  const files = await request('&view=files');
  assert.equal(files.statusCode, 200);
  const calls = await commands();
  assert.ok(calls.some((args) => args[0] === 'status'));
  assert.equal(calls.filter((args) => args[0] === 'diff').length, 0, 'count-only reads must never create patches');
  assert.deepEqual(files.json().changedFiles, full.json().changedFiles);
  assert.deepEqual(
    files
      .json()
      .changedFiles.map((file) => file.path)
      .sort(),
    ['new.txt', 'tracked.txt'],
  );
  assert.equal(files.json().diff, '');
  assert.ok(!files.body.includes('PRIVATE_FIXTURE_SECRET'));
});

test('files view retains root, traversal and denylist validation', async () => {
  assert.equal((await request('&view=files&path=../outside.txt')).statusCode, 403);
  assert.equal((await request('&view=files&path=.env')).statusCode, 403);
  const missing = await app.inject({
    method: 'GET',
    url: '/api/workspace/diff?worktreeId=missing-task229-root&view=files',
  });
  assert.equal(missing.statusCode, 404);
});
