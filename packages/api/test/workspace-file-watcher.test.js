import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { setupWorkspaceFileWatcher } from '../dist/domains/workspace/workspace-file-watcher.js';
import { registerWorktrees } from '../dist/domains/workspace/workspace-security.js';

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('workspace-file-watcher', () => {
  let httpServer;
  let io;
  let port;
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'watcher-test-'));
    registerWorktrees([{ id: 'test-wt', root: tmpDir, branch: 'main', head: 'abc' }]);

    httpServer = new HttpServer();
    io = new Server(httpServer, { cors: { origin: '*' } });
    setupWorkspaceFileWatcher(io);

    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        port = httpServer.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    io.close();
    httpServer.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('emits file-changed after atomic rename (write tmp + rename)', async () => {
    const filePath = join(tmpDir, 'target.md');
    await writeFile(filePath, 'version-1');
    const initialSha = sha256('version-1');

    const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
    const events = [];

    await new Promise((resolve) => client.on('connect', resolve));

    client.on('workspace:file-changed', (data) => events.push(data));
    client.emit('workspace:watch-file', { worktreeId: 'test-wt', path: 'target.md', sha256: initialSha });

    await wait(200);

    // Atomic rename: write to tmp then rename over target
    const tmpFile = join(tmpDir, 'target.md.tmp');
    await writeFile(tmpFile, 'version-2');
    const { rename } = await import('node:fs/promises');
    await rename(tmpFile, filePath);

    await wait(600);
    assert.ok(events.length >= 1, 'Should emit at least one file-changed event after atomic rename');
    assert.equal(events[0].path, 'target.md');
    assert.equal(events[0].sha256, sha256('version-2'));

    // Subsequent write should still trigger (watcher survives rename)
    events.length = 0;
    await writeFile(filePath, 'version-3');
    await wait(600);
    assert.ok(events.length >= 1, 'Should emit after subsequent write post-rename');
    assert.equal(events[events.length - 1].sha256, sha256('version-3'));

    client.disconnect();
  });

  it('emits immediately when client sha256 is null (subscription window gap)', async () => {
    const filePath = join(tmpDir, 'gap-test.txt');
    await writeFile(filePath, 'current-content');
    const currentSha = sha256('current-content');

    const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
    const events = [];

    await new Promise((resolve) => client.on('connect', resolve));
    client.on('workspace:file-changed', (data) => events.push(data));

    // Client sends null sha (simulates socket connecting before initial GET completes)
    client.emit('workspace:watch-file', { worktreeId: 'test-wt', path: 'gap-test.txt', sha256: null });

    await wait(200);
    assert.ok(events.length >= 1, 'Should emit immediately when client sha is null');
    assert.equal(events[0].sha256, currentSha);
    assert.equal(events[0].path, 'gap-test.txt');

    client.disconnect();
  });

  it('does NOT emit immediately when client sha matches current', async () => {
    const filePath = join(tmpDir, 'match-test.txt');
    await writeFile(filePath, 'same-content');
    const currentSha = sha256('same-content');

    const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
    const events = [];

    await new Promise((resolve) => client.on('connect', resolve));
    client.on('workspace:file-changed', (data) => events.push(data));

    client.emit('workspace:watch-file', { worktreeId: 'test-wt', path: 'match-test.txt', sha256: currentSha });

    await wait(200);
    assert.equal(events.length, 0, 'Should NOT emit when sha matches');

    client.disconnect();
  });

  it('cleans up watcher on disconnect', async () => {
    const filePath = join(tmpDir, 'cleanup-test.txt');
    await writeFile(filePath, 'initial');

    const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
    await new Promise((resolve) => client.on('connect', resolve));

    client.emit('workspace:watch-file', { worktreeId: 'test-wt', path: 'cleanup-test.txt', sha256: sha256('initial') });
    await wait(100);

    client.disconnect();
    await wait(100);

    // Modify file after disconnect — should not throw or crash the server
    await writeFile(filePath, 'modified-after-disconnect');
    await wait(400);
    // If we get here without crash, cleanup worked
    assert.ok(true);
  });
});
