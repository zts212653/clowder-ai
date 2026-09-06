import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('../.claude/hooks/user-level/session-start-recall.sh', import.meta.url));
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'clowder-start-advisory-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '--initial-branch=main');
  return {
    cwd,
    git,
    write(path, content = 'fixture') {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    },
  };
}
function run(cwd, env = {}) {
  return execFileSync('bash', [hook], {
    cwd,
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('startup preserves artifacts and does not turn ordinary research paths into cleanup work', (t) => {
  const f = fixture(t);
  f.write('project-research/topic/prompt.md');
  f.write('docs/research.md');
  f.write('scratch.txt');
  f.write('image.png');
  const before = f.git('status', '--porcelain');
  const out = run(f.cwd);
  assert.equal(f.git('status', '--porcelain'), before);
  assert.equal(readFileSync(join(f.cwd, 'image.png'), 'utf8'), 'fixture');
  assert.doesNotMatch(out, /project-research\/topic\/prompt\.md/);
  assert.doesNotMatch(out, /某只猫生成了但忘记|首个发现者直接处置|不该在这里/);
  assert.match(out, /scratch\.txt/);
  assert.match(out, /docs\/research\.md/);
});

test('startup points to canonical task-specific stopping rules without a blanket search quota', (t) => {
  const f = fixture(t);
  const out = run(f.cwd);
  assert.match(out, /memory-search-best-practices/);
  assert.match(out, /何时停下来/);
  assert.doesNotMatch(out, /搜索铁律：≥3/);
});

test('upstream divergence is a local observation and does not fetch or prescribe synchronization', (t) => {
  const f = fixture(t);
  f.write('tracked.txt');
  f.git('add', 'tracked.txt');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base');
  const base = f.git('rev-parse', 'HEAD');
  f.write('tracked.txt', 'changed');
  f.git('add', 'tracked.txt');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'remote snapshot');
  const ahead = f.git('rev-parse', 'HEAD');
  // Create a local branch behind a known local upstream snapshot without a server.
  f.git('branch', 'local', base);
  f.git('switch', 'local');
  f.git('remote', 'add', 'origin', 'https://example.invalid/never-contacted.git');
  f.git('update-ref', 'refs/remotes/origin/main', ahead);
  f.git('branch', '--set-upstream-to=origin/main');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(f.cwd, 'test-bin');
  const fetchLog = join(f.cwd, 'fetch-attempts');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nif [ "$1" = fetch ]; then printf fetch >> '${fetchLog}'; exit 99; fi\nexec '${realGit}' "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  const headBefore = f.git('rev-parse', 'HEAD');
  const out = run(f.cwd, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(existsSync(fetchLog), false, 'startup must not attempt a remote fetch');
  assert.equal(f.git('rev-parse', 'HEAD'), headBefore);
  assert.equal(f.git('rev-parse', 'main'), ahead);
  assert.match(out, /本地.*upstream|upstream.*本地/);
  assert.doesNotMatch(out, /建议先 git pull|确认是否需要 push/);
});
