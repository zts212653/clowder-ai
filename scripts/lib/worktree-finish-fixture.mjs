/** Real Git fixtures shared by worktree-finish regressions. */
import childProcess, { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishWorktree } from '../worktree-finish.mjs';
import { createWorktree } from '../worktree-new.mjs';

export const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
export const NOW = Date.now();
export const SOURCE = 'task:work:finish-fixture';
export const idle = () => ({ cwds: [], argv: [] });

/** Keep the real, live Unix observations for the private processes in a fixture. */
export function observeFixtureUnixPeers(t, pids) {
  const { spawnSync } = childProcess;
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    const result = spawnSync(command, args, options);
    if (command !== '/usr/sbin/netstat' || result.status !== 0 || typeof result.stdout !== 'string') return result;
    const lines = result.stdout.trimEnd().split('\n');
    const observed = lines.slice(2).filter((line) => {
      const pid = line.match(/:(\d+)\s+[\da-f]+\s+[\da-f]+\s+[\da-f]+/i)?.[1];
      return pids.includes(Number(pid));
    });
    return { ...result, stdout: [...lines.slice(0, 2), ...observed].join('\n') + '\n' };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

export const connectedClient = (address = 'fsmonitor--daemon.ipc', bound = false) => `import os,socket,sys
s=socket.socket(socket.AF_UNIX); ${bound ? "s.bind('client.sock');" : ''} s.connect(${JSON.stringify(address)}); os.chdir('/')
print('ready',flush=True); sys.stdin.readline(); s.setblocking(False)
try:
 data=s.recv(1); print('eof' if not data else 'data',flush=True)
except BlockingIOError: print('open',flush=True)
sys.stdin.readline()
`;

export function fixture({ checkoutOptions, tempDirectory = tmpdir() } = {}) {
  const root = realpathSync(mkdtempSync(join(tempDirectory, 'worktree-finish-')));
  const repo = join(root, 'cat-cafe');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  writeFileSync(join(repo, 'README.md'), 'original\n');
  writeFileSync(join(repo, '.gitignore'), readFileSync(new URL('../../.gitignore', import.meta.url)));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const make = (name = 'cat-cafe-finish', policy = 'merged') => {
    const path = join(root, name);
    createWorktree({
      repo,
      path,
      branch: `test/${name}`,
      owner: 'codex61-sol',
      policy,
      ttlDays: policy === 'ttl' ? 1 : undefined,
      now: NOW,
      checkoutOptions,
    });
    return path;
  };
  const finish = (path, overrides = {}) =>
    finishWorktree({
      repo,
      path,
      owner: 'codex61-sol',
      sourceRef: SOURCE,
      now: NOW,
      cwdProbe: idle,
      dataRoot: join(root, 'data'),
      ...overrides,
    });
  return { root, repo, make, finish };
}
