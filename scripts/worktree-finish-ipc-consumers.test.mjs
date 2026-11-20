import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { connectedClient, fixture, git, observeFixtureUnixPeers } from './lib/worktree-finish-fixture.mjs';
import { processRefs } from './lib/worktree-reaper-probes.mjs';

async function waitForNativePeer(path, gitDir, clientPid) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const refs = processRefs({ excludePids: [process.pid], observerPid: process.pid });
    if (refs?.openFilesComplete) {
      const daemon = refs.argvProcesses.find(
        (row) =>
          /git fsmonitor--daemon run /.test(row.command) &&
          [path, gitDir].every((location) =>
            refs.openFileProcesses.some((file) => file.pid === row.pid && file.path === location),
          ),
      );
      const peers = new Set(refs.unixFiles.filter((file) => file.pid === clientPid).map((file) => file.path));
      if (
        daemon &&
        refs.unixFiles.some(
          (file) =>
            file.pid === daemon.pid && file.path?.endsWith('fsmonitor--daemon.ipc') && peers.has(`->${file.pcb}`),
        )
      )
        return { refs, daemonPid: daemon.pid };
    }
    assert.ok(Date.now() < deadline, 'the independent native Git process must accept this exact client');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe(
  'finish preserves established Unix IPC consumers',
  { skip: process.platform !== 'darwin', timeout: 60000 },
  () => {
    let fx;
    let path;
    let child;
    let socket;
    let pausedPid;
    let independentPath;
    let externalSocketDir;
    const stableProcesses = () => {
      const refs = processRefs({ excludePids: [process.pid], observerPid: process.pid });
      assert.ok(refs?.openFilesComplete);
      return () => refs;
    };
    beforeEach(() => {
      fx = fixture({ tempDirectory: '/tmp' });
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
      if (independentPath) spawnSync('git', ['-C', independentPath, 'fsmonitor--daemon', 'stop']);
      independentPath = undefined;
      if (externalSocketDir) rmSync(externalSocketDir, { recursive: true, force: true });
      externalSocketDir = undefined;
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
        assert.throws(() => fx.finish(path, { cwdProbe: stableProcesses() }), /detached Unix IPC endpoint/);
        await checkConnection();
        assert.equal(lstatSync(socket).ino, inode);
        assert.equal(existsSync(path), true);
      });
    }

    it('protects a moved socket after another listener takes its original absolute address', async () => {
      externalSocketDir = mkdtempSync('/tmp/worktree-socket-');
      await startClient(`import os,socket,sys
root=os.path.dirname(open('gitdir').read().strip())
alias=${JSON.stringify(join(externalSocketDir, 'listener.sock'))}
listener=socket.socket(socket.AF_UNIX); listener.bind(alias); os.rename(alias,'fsmonitor--daemon.ipc'); listener.listen(1)
other=socket.socket(socket.AF_UNIX); other.bind(alias); other.listen(1)
client=socket.socket(socket.AF_UNIX); client.connect('fsmonitor--daemon.ipc'); server,_=listener.accept()
listener.close(); os.chdir('/')
print('ready',flush=True); sys.stdin.readline()
server.sendall(b'pong'); assert client.recv(4)==b'pong'
assert open(os.path.join(root,'README.md')).read().strip()=='original'
print('open',flush=True); sys.stdin.readline()
`);
      const inode = lstatSync(socket).ino;
      assert.throws(() => fx.finish(path, { cwdProbe: stableProcesses() }), /cold IPC placement changed/);
      await checkConnection();
      assert.equal(lstatSync(socket).ino, inode);
      assert.equal(existsSync(path), true);
    });

    it('protects a communicating endpoint when its Git directory is renamed beside a replacement listener', async () => {
      const renamedGitDir = `${dirname(socket)}-m`;
      await startClient(`import os,socket,sys
old=os.getcwd()
renamed=old+'-m'
root=os.path.dirname(open('gitdir').read().strip())
name='fsmonitor--daemon.ipc'
listener=socket.socket(socket.AF_UNIX); listener.bind(os.path.join(old,name)); listener.listen(1)
os.rename(old,renamed)
with open(os.path.join(root,'.git'),'w') as git_link: git_link.write('gitdir: '+renamed+'\\n')
os.mkdir(old)
other=socket.socket(socket.AF_UNIX); other.bind(os.path.join(old,name)); other.listen(1)
client=socket.socket(socket.AF_UNIX); client.connect(name); server,_=listener.accept()
listener.close(); os.chdir('/')
print('ready',flush=True); sys.stdin.readline()
server.sendall(b'pong'); assert client.recv(4)==b'pong'
assert open(os.path.join(root,'README.md')).read().strip()=='original'
print('open',flush=True); sys.stdin.readline()
`);
      const renamedSocket = join(renamedGitDir, 'fsmonitor--daemon.ipc');
      const inode = lstatSync(renamedSocket).ino;
      assert.throws(() => fx.finish(path, { cwdProbe: undefined }), /cold IPC placement changed/);
      await checkConnection();
      assert.equal(lstatSync(renamedSocket).ino, inode);
      assert.equal(existsSync(path), true);
    });

    for (const renameSocket of [false, true]) {
      it(`protects a communicating endpoint after its absolute alias is rebound, renamed=${renameSocket}`, async () => {
        externalSocketDir = mkdtempSync('/tmp/worktree-socket-');
        await startClient(`import os,socket,sys
root=os.path.dirname(open('gitdir').read().strip())
outside=${JSON.stringify(externalSocketDir)}
alias=os.path.join(outside,'alias')
alternate=os.path.join(outside,'alternate')
os.mkdir(alternate); os.symlink(os.getcwd(),alias)
name='fsmonitor--daemon.ipc'
original=os.path.join(alias,${renameSocket ? "'first.sock'" : 'name'})
listener=socket.socket(socket.AF_UNIX); listener.bind(original)
${renameSocket ? "os.rename('first.sock',name)" : ''}
listener.listen(1)
os.unlink(alias); os.symlink(alternate,alias)
other=socket.socket(socket.AF_UNIX); other.bind(original); other.listen(1)
client=socket.socket(socket.AF_UNIX); client.connect(name); server,_=listener.accept()
listener.close(); os.chdir('/')
print('ready',flush=True); sys.stdin.readline()
server.sendall(b'pong'); assert client.recv(4)==b'pong'
assert open(os.path.join(root,'README.md')).read().strip()=='original'
print('open',flush=True); sys.stdin.readline()
`);
        const inode = lstatSync(socket).ino;
        assert.throws(() => fx.finish(path, { cwdProbe: stableProcesses() }), /detached Unix IPC endpoint/);
        await checkConnection();
        assert.equal(lstatSync(socket).ino, inode);
        assert.equal(existsSync(path), true);
      });
    }

    for (const swapDirectory of [false, true]) {
      it(`protects an older listener's alias rebound to the target, directory swapped=${swapDirectory}`, async () => {
        externalSocketDir = mkdtempSync('/tmp/worktree-socket-');
        const switchAddress = swapDirectory
          ? `
current=os.path.join(outside,'current')
saved=os.path.join(outside,'saved')
staged=os.path.join(outside,'staged')
inner=os.path.join(current,'inner')
alias=os.path.join(inner,'peer.sock')
os.makedirs(inner)
other=socket.socket(socket.AF_UNIX); other.bind(alias); other.listen(1)
os.rename(current,saved); os.makedirs(inner)
os.symlink(os.path.join(os.getcwd(),name),alias)
listener=socket.socket(socket.AF_UNIX); listener.bind(alias); listener.listen(1)
os.rename(current,staged); os.rename(saved,current)
os.mkdir(os.path.join(current,'unrelated'))
`
          : `
alias=os.path.join(outside,'alias.sock')
alternate=os.path.join(outside,'alternate')
os.mkdir(alternate)
other_path=os.path.join(alternate,'other.sock')
os.symlink(other_path,alias)
other=socket.socket(socket.AF_UNIX); other.bind(alias); other.listen(1)
os.unlink(alias); os.symlink(os.path.join(os.getcwd(),name),alias)
listener=socket.socket(socket.AF_UNIX); listener.bind(alias); listener.listen(1)
os.unlink(alias); os.symlink(other_path,alias)
`;
        await startClient(`import os,socket,sys
root=os.path.dirname(open('gitdir').read().strip())
outside=${JSON.stringify(externalSocketDir)}
name='fsmonitor--daemon.ipc'
${switchAddress}
client=socket.socket(socket.AF_UNIX); client.connect(name); server,_=listener.accept()
listener.close(); os.chdir('/')
print('ready',flush=True); sys.stdin.readline()
server.sendall(b'pong'); assert client.recv(4)==b'pong'
assert open(os.path.join(root,'README.md')).read().strip()=='original'
print('open',flush=True); sys.stdin.readline()
`);
        const inode = lstatSync(socket).ino;
        assert.throws(() => fx.finish(path, { cwdProbe: undefined }), /detached Unix IPC endpoint/);
        await checkConnection();
        assert.equal(lstatSync(socket).ino, inode);
        assert.equal(existsSync(path), true);
      });
    }

    it('archives a retained checkout with cold IPC beside an independent native Git connection', async (t) => {
      git(path, 'config', '--worktree', 'core.fsmonitor', 'true');
      child = spawn('git', ['-C', path, 'fsmonitor--daemon', 'run'], { cwd: fx.repo, stdio: 'ignore' });
      const deadline = Date.now() + 5000;
      while (spawnSync('git', ['-C', path, 'fsmonitor--daemon', 'status']).status !== 0) {
        assert.equal(child.exitCode, null, 'daemon exited before becoming ready');
        assert.ok(Date.now() < deadline, 'native daemon readiness deadline');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const exited = once(child, 'exit');
      child.kill('SIGKILL'); // Only this fixture's foreground child; leave a real Git-created stale UDS.
      await exited;
      assert.equal(lstatSync(socket).isSocket(), true);
      const inode = lstatSync(socket).ino;
      const head = git(path, 'rev-parse', 'HEAD').trim();
      independentPath = fx.make('cat-cafe-independent-monitor');
      git(independentPath, 'fsmonitor--daemon', 'start');
      const independentGitDir = git(independentPath, 'rev-parse', '--absolute-git-dir').trim();
      await startClient(connectedClient(), independentGitDir);
      const { refs, daemonPid } = await waitForNativePeer(independentPath, independentGitDir, child.pid);
      observeFixtureUnixPeers(t, [daemonPid, child.pid]);
      mkdirSync(join(path, '.cat-cafe'));
      writeFileSync(join(path, '.cat-cafe/private.txt'), 'preserved output\n');
      const until = new Date(Date.now() + 86_400_000).toISOString();
      fx.finish(path, { mode: 'retain', reason: 'original cold socket', until });
      assert.equal(fx.finish(path, { mode: 'check' }).state, 'retained');
      assert.throws(() => fx.finish(path, { sourceRef: 'task:other' }), /retention source mismatch/);
      assert.throws(
        () => fx.finish(path, { cwdProbe: () => ({ ...refs, openFilesComplete: false }) }),
        /socket holder observations unknown/,
      );

      const archiveRoot = join(fx.root, '.worktree-release-archives');
      writeFileSync(archiveRoot, 'cannot create an archive directory');
      assert.throws(() => fx.finish(path, { cwdProbe: () => refs }), /worktree release incomplete.*EEXIST.*mkdir/);
      assert.equal(lstatSync(socket).ino, inode);
      assert.equal(existsSync(`${socket}.lock`), false);
      assert.equal(fx.finish(path, { mode: 'check' }).state, 'retained');
      rmSync(archiveRoot);

      // Keep the fixture's actual process snapshot while finish rechecks the live kernel connections.
      const receipt = fx.finish(path, { cwdProbe: () => refs });
      assert.equal(receipt.storageDisposition, 'removed');
      assert.equal(existsSync(path), false);
      assert.equal(existsSync(socket), false);
      assert.deepEqual(fx.finish(path, { mode: 'check' }), receipt);
      assert.equal(
        readFileSync(join(receipt.archivePath, 'files/.cat-cafe/private.txt'), 'utf8'),
        'preserved output\n',
      );
      execFileSync('/bin/sh', ['-c', receipt.restore], { cwd: fx.repo, stdio: 'pipe' });
      assert.equal(git(path, 'rev-parse', 'HEAD').trim(), head);
      assert.equal(git(path, 'config', '--worktree', 'core.fsmonitor').trim(), 'true');
      assert.equal(readFileSync(join(path, '.cat-cafe/private.txt'), 'utf8'), 'preserved output\n');
      await checkConnection();
    });
  },
);
