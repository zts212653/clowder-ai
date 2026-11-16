import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fixture, git } from './lib/worktree-finish-fixture.mjs';
import { processRefs } from './lib/worktree-reaper-probes.mjs';

const connectedClient = (address = 'fsmonitor--daemon.ipc', bound = false) => `import os,socket,sys
s=socket.socket(socket.AF_UNIX); ${bound ? "s.bind('client.sock');" : ''} s.connect(${JSON.stringify(address)}); os.chdir('/')
print('ready',flush=True); sys.stdin.readline(); s.setblocking(False)
try:
 data=s.recv(1); print('eof' if not data else 'data',flush=True)
except BlockingIOError: print('open',flush=True)
sys.stdin.readline()
`;

describe(
  'finish preserves established Unix IPC consumers',
  { skip: process.platform !== 'darwin', timeout: 60000 },
  () => {
    let fx;
    let path;
    let child;
    let socket;
    let pausedPid;
    beforeEach(() => {
      fx = fixture();
      git(fx.repo, 'config', 'core.fsmonitor', 'false');
      path = fx.make();
      socket = join(git(path, 'rev-parse', '--absolute-git-dir').trim(), 'fsmonitor--daemon.ipc');
    });
    afterEach(async () => {
      if (pausedPid) process.kill(pausedPid, 'SIGCONT');
      pausedPid = undefined;
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      child = undefined;
      spawnSync('git', ['-C', path, 'fsmonitor--daemon', 'stop']);
      rmSync(fx.root, { recursive: true, force: true });
    });
    const startClient = async (code, cwd = git(path, 'rev-parse', '--absolute-git-dir').trim()) => {
      child = spawn('python3', ['-I', '-S', '-c', code], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const [ready] = await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(([code]) => {
          throw new Error(`fixture client exited before ready: ${code}`);
        }),
      ]);
      assert.equal(ready.toString().trim(), 'ready');
    };
    const checkConnection = async () => {
      const read = once(child.stdout, 'data');
      child.stdin.write('check\n');
      const [reply] = await read;
      assert.equal(reply.toString().trim(), 'open');
      assert.equal(child.exitCode, null);
    };

    for (const bound of [false, true]) {
      it(`does not stop a native Git monitor with a connected client outside its cwd, client bound=${bound}`, async () => {
        git(path, 'config', '--worktree', 'core.fsmonitor', 'true');
        git(path, 'fsmonitor--daemon', 'start');
        await startClient(connectedClient('fsmonitor--daemon.ipc', bound));
        assert.throws(() => fx.finish(path, { cwdProbe: undefined }), /active Unix IPC consumer/);
        assert.equal(spawnSync('git', ['-C', path, 'fsmonitor--daemon', 'status']).status, 0);
        await checkConnection();
        assert.equal(existsSync(path), true);
      });
    }

    it('protects a queued native connection before the server has an accepted descriptor', async () => {
      git(path, 'fsmonitor--daemon', 'start');
      const refs = processRefs({ excludePids: [process.pid], observerPid: process.pid });
      assert.ok(refs);
      const owned = refs.argvProcesses.filter(
        (row) =>
          /git fsmonitor--daemon run /.test(row.command) &&
          refs.openFileProcesses.some((file) => file.pid === row.pid && file.path === path),
      );
      assert.equal(owned.length, 1, 'exact fixture root must identify its own newly started daemon');
      pausedPid = owned[0].pid;
      process.kill(pausedPid, 'SIGSTOP'); // Only the daemon just started for this exact temporary checkout.
      assert.match(
        spawnSync('ps', ['-p', String(pausedPid), '-o', 'state='], { encoding: 'utf8' }).stdout.trim(),
        /^T/,
      );
      await startClient(connectedClient());
      assert.throws(() => fx.finish(path, { cwdProbe: undefined }), /active Unix IPC consumer/);
      await checkConnection();
      assert.equal(existsSync(path), true);
    });

    it('preserves the monitor when its Unix descriptor identity cannot be resolved', () => {
      git(path, 'fsmonitor--daemon', 'start');
      const refs = processRefs({ excludePids: [process.pid], observerPid: process.pid });
      assert.ok(refs);
      assert.throws(
        () => fx.finish(path, { cwdProbe: () => ({ ...refs, unixFiles: [] }) }),
        /target Unix descriptors unknown/,
      );
      assert.equal(spawnSync('git', ['-C', path, 'fsmonitor--daemon', 'status']).status, 0);
    });

    it('finishes while an independent repository has its own communicating consumer', async () => {
      const independent = fixture();
      try {
        git(independent.repo, 'fsmonitor--daemon', 'start');
        // Darwin sockaddr_un is bounded; use the actual relative native address, as Git does.
        await startClient(connectedClient(), join(independent.repo, '.git'));
        git(path, 'fsmonitor--daemon', 'start');
        assert.equal(fx.finish(path, { cwdProbe: undefined }).storageDisposition, 'removed');
        assert.equal(fx.finish(path, { mode: 'check' }).state, 'released');
        assert.equal(spawnSync('git', ['-C', independent.repo, 'fsmonitor--daemon', 'status']).status, 0);
        await checkConnection();
      } finally {
        spawnSync('git', ['-C', independent.repo, 'fsmonitor--daemon', 'stop']);
        rmSync(independent.root, { recursive: true, force: true });
      }
    });

    for (const renamed of [false, true]) {
      it(`preserves communicating endpoints after the listener closed, renamed=${renamed}`, async () => {
        await startClient(`import os,socket,sys
root=os.path.dirname(open('gitdir').read().strip())
listener=socket.socket(socket.AF_UNIX); listener.bind('${renamed ? 'original.sock' : 'fsmonitor--daemon.ipc'}')
${renamed ? "os.rename('original.sock','fsmonitor--daemon.ipc')" : ''}
listener.listen(1); client=socket.socket(socket.AF_UNIX); client.connect('fsmonitor--daemon.ipc')
server,_=listener.accept(); listener.close(); os.chdir('/')
client.sendall(b'ping'); assert server.recv(4)==b'ping'
print('ready',flush=True); sys.stdin.readline()
server.sendall(b'pong'); assert client.recv(4)==b'pong'
assert open(os.path.join(root,'README.md')).read().strip()=='original'
print('open',flush=True); sys.stdin.readline()
`);
        const inode = lstatSync(socket).ino;
        assert.equal(spawnSync('git', ['-C', path, 'fsmonitor--daemon', 'status']).status, 1);
        assert.throws(() => fx.finish(path, { cwdProbe: undefined }), /unbound IPC lifetime unknown/);
        await checkConnection();
        assert.equal(lstatSync(socket).ino, inode);
        assert.equal(existsSync(path), true);
      });
    }
  },
);
