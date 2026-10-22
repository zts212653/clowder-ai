import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { verifyAcpBootstrap } from '../../src/domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-context.ts';
import { inspectAcpBootstrapDirectory } from '../../src/domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-inspect.ts';

// Windows cannot enforce Unix modes. Model only metadata/mode mutations there;
// the same integration cases use native uid/mode and chmod on POSIX CI.
function fixture(run: (root: string, setMode: (path: string, mode: number) => void) => void) {
  const root = fs.mkdtempSync(join(tmpdir(), 'acp-posix-preservation-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const uid = Object.getOwnPropertyDescriptor(process, 'getuid');
  const simulated = process.platform === 'win32';
  const modes = new Map<string, number>([[root, 0o700]]);
  const original = { lstat: fs.lstatSync, mkdir: fs.mkdirSync, chmod: fs.chmodSync };
  const chmodCalls: string[] = [];
  try {
    if (simulated) {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
      mock.method(fs, 'lstatSync', (path: fs.PathLike) => {
        const stat = original.lstat(path);
        if (typeof path === 'string') {
          const inFixture = path === root || path.startsWith(`${root}\\`);
          Object.defineProperties(stat, {
            uid: { value: inFixture ? 1000 : 0 },
            mode: { value: (stat.mode & ~0o7777) | (modes.get(path) ?? (inFixture ? 0o700 : 0o755)) },
          });
        }
        return stat;
      });
      mock.method(fs, 'mkdirSync', (path: fs.PathLike, options: fs.MakeDirectoryOptions) => {
        const result = original.mkdir(path, options);
        if (typeof path === 'string') modes.set(path, Number(options?.mode ?? 0o777));
        return result;
      });
    }
    mock.method(fs, 'chmodSync', (path: fs.PathLike, mode: fs.Mode) => {
      chmodCalls.push(String(path));
      if (simulated) modes.set(String(path), Number(mode));
      else original.chmod(path, mode);
    });
    syncBuiltinESMExports();
    run(root, (path, mode) => {
      if (simulated) modes.set(path, mode);
      else original.chmod(path, mode);
    });
    assert.deepEqual(chmodCalls, [], 'checking or launching must never repair existing permissions');
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
    if (uid) Object.defineProperty(process, 'getuid', uid);
    else Reflect.deleteProperty(process, 'getuid');
    fs.rmSync(root, { recursive: true });
  }
}

test('directory inspection rejects an existing 0755 root without changing its mode', () => {
  fixture((root, setMode) => {
    setMode(root, 0o755);
    const result = inspectAcpBootstrapDirectory(root);
    assert.equal(result.ok, false);
    assert.equal(fs.lstatSync(root).mode & 0o7777, 0o755);
  });
});

test('explicit roots are checked again on cold spawn without repairing an exposed cwd', () => {
  fixture((root, setMode) => {
    const base = {
      projectRoot: root,
      command: 'custom-agent',
      args: ['--acp'],
      poolKey: { projectPath: root, providerProfile: 'custom-client' },
    };
    const verified = verifyAcpBootstrap(base, 'custom-client', root, undefined, true);
    assert.equal(fs.lstatSync(verified.cwd).mode & 0o7777, 0o700);
    setMode(verified.cwd, 0o755);
    assert.throws(() => verified.verifyCwd(), /0700/);
    assert.equal(fs.lstatSync(verified.cwd).mode & 0o7777, 0o755);
  });
});

test('inspection creates a new private leaf under an existing parent and can reuse it', () => {
  fixture((parent) => {
    const root = join(parent, 'new-private-root');
    assert.equal(inspectAcpBootstrapDirectory(root).ok, true);
    assert.equal(inspectAcpBootstrapDirectory(root).ok, true);
    assert.equal(fs.lstatSync(root).mode & 0o7777, 0o700);
  });
});

test('a private root under a non-sticky shared parent is rejected without changing permissions', () => {
  fixture((parent, setMode) => {
    const root = join(parent, 'private-under-shared-parent');
    fs.mkdirSync(root, { mode: 0o700 });
    setMode(parent, 0o777);
    assert.equal(inspectAcpBootstrapDirectory(root).ok, false);
    assert.equal(fs.lstatSync(parent).mode & 0o7777, 0o777);
    assert.equal(fs.lstatSync(root).mode & 0o7777, 0o700);
  });
});

test('a trusted sticky shared parent protects the current-user private root', () => {
  fixture((parent, setMode) => {
    setMode(parent, 0o1777);
    assert.equal(inspectAcpBootstrapDirectory(join(parent, 'private-under-sticky-parent')).ok, true);
    assert.equal(fs.lstatSync(parent).mode & 0o7777, 0o1777);
  });
});
