import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-api-sync-calls.mjs', import.meta.url));
const path = 'packages/api/src/routes/with space.ts';
const safe = 'export const ready = true;\n';
const blocked = "import {spawnSync as run} from 'node:child_process'; export function read(){run('git');}\n";

async function repo(t, initial = safe) {
  const root = await mkdtemp(join(tmpdir(), 'api-sync-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Guard fixture');
  git('config', 'user.email', 'guard@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  await mkdir(join(root, 'packages/api/src/routes'), { recursive: true });
  await writeFile(join(root, path), initial);
  git('add', '.');
  git('-c', `core.hooksPath=${join(root, '.git/hooks')}`, 'commit', '-m', 'baseline');
  const base = git('rev-parse', 'HEAD').trim();
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  return { root, git, base, run };
}

test('the commit guard reads staged bytes even if the working source was reverted', async (t) => {
  const r = await repo(t);
  await writeFile(join(r.root, path), blocked);
  r.git('add', path);
  await writeFile(join(r.root, path), safe);
  const staged = r.run('--staged');
  assert.equal(staged.status, 1, staged.stderr);
  assert.match(staged.stderr, /with space\.ts:1:.*spawnSync/);
  const working = r.run();
  assert.equal(working.status, 0, working.stderr);
});

test('CI compares the committed head with its frozen base rather than unstaged content', async (t) => {
  const r = await repo(t);
  await writeFile(join(r.root, path), blocked);
  r.git('add', path);
  r.git('-c', `core.hooksPath=${join(r.root, '.git/hooks')}`, 'commit', '-m', 'new synchronous call');
  await writeFile(join(r.root, path), safe);
  const result = r.run('--base', r.base);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /spawnSync/);
});

test('existing debt and a missing comparison revision have distinct results', async (t) => {
  const r = await repo(t, blocked);
  await writeFile(join(r.root, path), `${blocked}\nexport const unchanged = true;\n`);
  r.git('add', path);
  assert.equal(r.run('--staged').status, 0);
  assert.equal(r.run('--base', 'does-not-exist').status, 2);
});

test('a staged symbolic source is refused without following its target', async (t) => {
  const r = await repo(t);
  const blob = r.git('rev-parse', `HEAD:${path}`).trim();
  r.git('update-index', '--cacheinfo', `120000,${blob},${path}`);
  const result = r.run('--staged');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Unsupported index source/);
});
