import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../src/routes/workspace.js';
import { workspaceGitRoutes } from '../src/routes/workspace-git.js';

const logs: Array<Record<string, unknown>> = [];
const app = Fastify({
  logger: {
    level: 'warn',
    stream: {
      write(line: string) {
        logs.push(JSON.parse(line));
      },
    },
  },
});
const rootId = 'stream-status-fixture';
const total = 9001;
let fixture: string;
let root: string;
let modePath: string;
let callsPath: string;
let git: string;
const previousPath = process.env.PATH;

before(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'workspace-status-stream-'));
  root = join(fixture, 'repo');
  const bin = join(fixture, 'bin');
  await mkdir(root);
  await mkdir(bin);
  git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  execFileSync(git, ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'tracked.txt'), 'tracked source');
  execFileSync(git, ['add', 'tracked.txt'], { cwd: root });
  execFileSync(
    git,
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'],
    { cwd: root },
  );
  modePath = join(fixture, 'mode');
  callsPath = join(fixture, 'calls.jsonl');
  await writeFile(modePath, 'huge');
  await writeFile(callsPath, '');
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env node
const { readFileSync, appendFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2).filter(arg => arg !== '--no-optional-locks');
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + String.fromCharCode(10));
const mode = readFileSync(${JSON.stringify(modePath)}, 'utf8');
if (args[0] === 'status' && mode !== 'real') {
  const separator = String.fromCharCode(args.includes('-z') ? 0 : 10);
  if (mode.startsWith('expansion-')) {
    if (args.includes('--untracked-files=normal')) {
      setTimeout(() => process.stdout.write('?? expanded/' + separator), mode === 'expansion-timeout' ? 1800 : 0);
    } else {
      process.stdout.write('?? expanded/partial.ts' + separator);
      process.stderr.write(JSON.stringify({ event: 'region_enter', thread: 'main', category: 'dir', label: 'read_directory' }) + String.fromCharCode(10));
      if (mode === 'expansion-failed') process.exitCode = 2;
      else setInterval(() => {}, 1000);
    }
  } else if (mode === 'huge') {
    const paths = Array.from({ length: ${total - 1} }, (_, i) => '?? source/' + String(i).padStart(5, '0') + '-' + 'x'.repeat(150) + '.ts');
    paths.push('?? source/final-real-file.ts');
    process.stdout.write(paths.join(separator) + separator);
  } else if (mode === 'failed') {
    process.stdout.write('?? partial.ts' + separator);
    process.exitCode = 2;
  } else {
    process.stdout.write('?? partial.ts' + separator);
    setInterval(() => {}, 1000);
  }
} else {
  try { execFileSync(${JSON.stringify(git)}, args, { stdio: 'inherit' }); }
  catch (error) { process.exit(typeof error.status === 'number' ? error.status : 1); }
}
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${previousPath}`;
  registerWorktrees([{ id: rootId, root, branch: 'fixture', head: 'fixture' }]);
  await app.register(workspaceRoutes);
  await app.register(workspaceGitRoutes);
  await app.ready();
});

after(async () => {
  await app.close();
  process.env.PATH = previousPath;
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

async function request(view: string) {
  return app.inject({ method: 'GET', url: `/api/workspace/diff?worktreeId=${rootId}&view=${view}` });
}

test('large status output preserves the last file and the count does not return the full list or create patches', async () => {
  await writeFile(modePath, 'huge');
  await writeFile(callsPath, '');
  const files = await request('files');
  assert.equal(files.statusCode, 200, files.body);
  assert.equal(files.json().changedFiles.length, total);
  assert.equal(files.json().changedFiles.at(-1).path, 'source/final-real-file.ts');
  const count = await request('count');
  assert.equal(count.statusCode, 200, count.body);
  assert.equal(count.json().changedFileCount, total);
  assert.equal('changedFiles' in count.json(), false);
  const commands = (await readFile(callsPath, 'utf8'))
    .trim()
    .split(String.fromCharCode(10))
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(
    commands.some((args) => args[0] === 'diff'),
    false,
    'metadata reads never generate patches',
  );
});

test('both workspace readers preserve UTF-8, newline, arrow and renamed paths while keeping secrets filtered', async () => {
  await writeFile(modePath, 'real');
  const renamed = '新 名 -> renamed' + String.fromCharCode(10) + 'file.txt';
  const added = '中文 -> new' + String.fromCharCode(10) + 'file.txt';
  execFileSync(git, ['mv', 'tracked.txt', renamed], { cwd: root });
  await writeFile(join(root, added), 'untracked');
  await writeFile(join(root, '.env'), 'fixture secret');
  const files = await request('files');
  assert.equal(files.statusCode, 200, files.body);
  assert.deepEqual(
    files
      .json()
      .changedFiles.map((entry: { path: string }) => entry.path)
      .sort(),
    [added, renamed].sort(),
  );
  assert.equal((await request('count')).json().changedFileCount, 2);
  const status = await app.inject({ method: 'GET', url: `/api/workspace/git-status?worktreeId=${rootId}` });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().staged[0].path, renamed);
  assert.ok(status.json().untracked.some((entry: { path: string }) => entry.path === added));
});

test('a failed status process never publishes its partial file count', async () => {
  await writeFile(modePath, 'failed');
  const result = await request('count');
  assert.equal(result.statusCode, 500);
  assert.equal('changedFileCount' in result.json(), false);
});

test('the existing timeout stops the owned status process and does not publish a partial count', async () => {
  await writeFile(modePath, 'timeout');
  const result = await request('count');
  assert.equal(result.statusCode, 500);
  assert.equal('changedFileCount' in result.json(), false);
});

test('an expansion failure rejects the count and records its phase without exposing file contents', async () => {
  await writeFile(modePath, 'expansion-failed');
  logs.length = 0;
  const result = await request('count');
  assert.equal(result.statusCode, 500);
  assert.equal('changedFileCount' in result.json(), false);
  const diagnostic = logs.find((line) => line.gitStatus)?.gitStatus as Record<string, unknown>;
  assert.equal(diagnostic.phase, 'untracked-expansion');
  assert.equal(diagnostic.reason, 'exit');
  assert.equal(diagnostic.exitCode, 2);
  assert.equal(diagnostic.gitRegion, 'dir/read_directory');
  assert.ok(Number(diagnostic.stdoutBytes) > 0);
  assert.equal(JSON.stringify(diagnostic).includes('partial.ts'), false);
});

test('expansion uses the remainder of the original deadline, never a fresh five seconds', async () => {
  await writeFile(modePath, 'expansion-timeout');
  logs.length = 0;
  const startedAt = performance.now();
  const result = await request('count');
  const elapsed = performance.now() - startedAt;
  assert.equal(result.statusCode, 500);
  assert.equal('changedFileCount' in result.json(), false);
  const diagnostic = logs.find((line) => line.gitStatus)?.gitStatus as Record<string, unknown>;
  assert.equal(diagnostic.phase, 'untracked-expansion');
  assert.equal(diagnostic.reason, 'timeout');
  assert.ok(Number(diagnostic.phaseElapsedMs) < 4500, JSON.stringify(diagnostic));
  assert.ok(elapsed >= 4900 && elapsed < 6500, `total elapsed ${elapsed} ms`);
});
