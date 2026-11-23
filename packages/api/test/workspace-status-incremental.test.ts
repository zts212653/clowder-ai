import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createGitStatusParser, type GitStatusEntry, readGitStatus } from '../src/domains/workspace/git-status.ts';

let fixture: string;
let root: string;
const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const trackedCount = 640;
function command(args: string[], cwd = root): Buffer {
  return execFileSync(git, args, { cwd, maxBuffer: 4 * 1024 * 1024 });
}
async function file(path: string, content = 'fixture'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
function sorted(entries: GitStatusEntry[]): GitStatusEntry[] {
  return entries.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
}
async function actual(cwd = root): Promise<GitStatusEntry[]> {
  const entries: GitStatusEntry[] = [];
  await readGitStatus(cwd, (entry) => entries.push(entry));
  return sorted(entries);
}
function reference(cwd = root): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  const parser = createGitStatusParser((entry) => entries.push(entry));
  parser.write(command(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd).toString());
  parser.finish();
  return sorted(entries);
}

before(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'workspace-incremental-'));
  root = join(fixture, 'repo');
  await mkdir(root);
  command(['init', '-q']);
  command(['config', 'core.untrackedCache', 'true']);
  command(['config', 'core.longpaths', 'true']);
  for (let directory = 0; directory < 8; directory++) {
    await Promise.all(
      Array.from({ length: 80 }, (_, index) => file(join(root, `tracked-${directory}`, `${index}.txt`))),
    );
  }
  await file(join(root, '.gitignore'), '*.ignored\nignored-only/\n');
  command(['add', '.']);
  command(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  await file(join(root, 'new directory', 'nested', 'new.txt'));
});

after(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

test('warm reads keep every untracked file without re-enumerating hundreds of unchanged tracked names', async () => {
  const expected = reference();
  // Git deliberately distrusts directory mtimes from the same filesystem clock tick.
  await delay(1100);
  await actual();
  await actual();
  const trace = join(fixture, 'trace.jsonl');
  const previous = process.env.GIT_TRACE2_EVENT;
  const previousNesting = process.env.GIT_TRACE2_EVENT_NESTING;
  process.env.GIT_TRACE2_EVENT_NESTING = '20';
  process.env.GIT_TRACE2_EVENT = trace;
  try {
    assert.deepEqual(await actual(), expected);
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
    if (previousNesting === undefined) delete process.env.GIT_TRACE2_EVENT_NESTING;
    else process.env.GIT_TRACE2_EVENT_NESTING = previousNesting;
  }
  const events = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          event?: string;
          category?: string;
          key?: string;
          value?: string;
        },
    );
  const paths = events.filter(
    (e) => e.event === 'data' && e.category === 'read_directory' && e.key === 'paths-visited',
  );
  assert.ok(paths.length > 0, 'native Git must supply the measurement');
  const visited = paths.reduce((sum, e) => sum + Number(e.value), 0);
  assert.ok(visited < trackedCount / 2, `walked ${visited} paths for ${trackedCount} unchanged tracked files`);
});

test('new files, removals, renames, ignore changes and unusual paths stay visible immediately', async () => {
  await file(join(root, 'fresh [x]', 'deep', '中文 -> new\nfile.txt'));
  await file(join(root, 'fresh x', 'different.txt'));
  await file(join(root, 'ignored-only', 'hidden.txt'));
  await file(join(root, 'rules', '.gitignore'), '*\n!keep.txt\n');
  await file(join(root, 'rules', 'keep.txt'));
  await file(join(root, 'rules', 'hidden.txt'));
  await mkdir(join(root, 'empty'));
  await file(join(root, 'tracked-0', '0.txt'), 'changed');
  await unlink(join(root, 'tracked-0', '1.txt'));
  command(['mv', 'tracked-0/2.txt', 'renamed.txt']);
  if (process.platform !== 'win32') await symlink('../tracked-0', join(root, 'untracked-link'));
  const ignored = await actual();
  assert.deepEqual(ignored, reference());
  assert.equal(
    ignored.some(
      (entry) => entry.path.startsWith('ignored-only/') || entry.path === 'rules/hidden.txt' || entry.path === 'empty/',
    ),
    false,
  );
  await file(join(root, '.gitignore'), '*.ignored\n');
  const revealed = await actual();
  assert.deepEqual(revealed, reference());
  assert.ok(revealed.some((entry) => entry.path === 'ignored-only/hidden.txt'));
  await unlink(join(root, 'new directory', 'nested', 'new.txt'));
  assert.deepEqual(await actual(), reference());
});

test('nested repositories remain opaque and a caller inside a repo gets repository-relative paths', async () => {
  const nested = join(root, 'embedded');
  await mkdir(nested);
  command(['init', '-q'], nested);
  await file(join(nested, 'inside.txt'));
  command(['add', '.'], nested);
  command(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'nested'], nested);
  const embeddedWorktree = join(root, 'embedded-worktree');
  command(['worktree', 'add', '-q', '--detach', embeddedWorktree, 'HEAD'], nested);
  assert.deepEqual(await actual(), reference());
  const fromChild = await actual(join(root, 'tracked-0'));
  assert.deepEqual(fromChild, reference(join(root, 'tracked-0')));
  assert.ok(fromChild.some((entry) => entry.path === 'embedded/'));
  assert.ok(fromChild.some((entry) => entry.path === 'embedded-worktree/'));
});

test('a file staged between discovery and expansion never disappears from the combined result', async () => {
  await file(join(root, 'arriving', 'a.txt'));
  const bin = join(fixture, 'bin');
  await mkdir(bin);
  const flag = join(fixture, 'transition-complete');
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const out = execFileSync(${JSON.stringify(git)}, args);
if (args.includes('--untracked-files=normal') && !existsSync(${JSON.stringify(flag)})) {
  execFileSync(${JSON.stringify(git)}, ['add', '--', 'arriving/a.txt']);
  writeFileSync(${JSON.stringify(flag)}, 'done');
}
process.stdout.write(out);
`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    const entries = await actual();
    assert.ok(
      entries.some((entry) => entry.path === 'arriving/a.txt'),
      'neither the old untracked state nor the new staged state may be lost',
    );
  } finally {
    process.env.PATH = previous;
  }
});

test('wide and space-containing directories expand completely within portable command-line limits', async () => {
  for (let i = 0; i < 320; i++) {
    await file(join(root, `wide-${String(i).padStart(4, '0')}-${'x'.repeat(120)}`, 'leaf.txt'));
  }
  for (let i = 0; i < 1451; i++) await file(join(root, `d ${String(i).padStart(4, '0')}`, 'leaf.txt'));
  const bin = join(fixture, 'budget-bin');
  const sizes = join(fixture, 'command-sizes.jsonl');
  await mkdir(bin);
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--untracked-files=all')) {
  // These fixture names contain spaces but no quotes/backslashes: this is their exact Windows encoding.
  const length = ['git', ...args].map(arg => arg.includes(' ') ? '"' + arg + '"' : arg).join(' ').length + 1;
  appendFileSync(${JSON.stringify(sizes)}, JSON.stringify(length) + String.fromCharCode(10));
  if (length > 32767) process.exit(2);
}
process.stdout.write(execFileSync(${JSON.stringify(git)}, args));
`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  let entries: GitStatusEntry[];
  try {
    entries = await actual();
  } finally {
    process.env.PATH = previous;
  }
  assert.deepEqual(entries, reference());
  assert.equal(entries.filter((entry) => entry.path.startsWith('wide-')).length, 320);
  assert.equal(entries.filter((entry) => entry.path.startsWith('d ')).length, 1451);
  assert.equal(new Set(entries.map((entry) => entry.path)).size, entries.length);
  const lengths = (await readFile(sizes, 'utf8')).trim().split('\n').map(Number);
  assert.ok(lengths.length > 1, 'large path sets must be split rather than truncated');
  assert.ok(
    lengths.every((length) => length <= 32767),
    JSON.stringify(lengths),
  );
});
