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

function waitForSocketEvent(client, eventName, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);
    const onEvent = (data) => {
      clearTimeout(timer);
      resolve(data);
    };
    client.once(eventName, onEvent);
  });
}

const FS_WATCH_EVENT_TIMEOUT_MS = 10000;

async function connectClient(port) {
  const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
  await new Promise((resolve) => client.on('connect', resolve));
  return client;
}

async function disconnectClient(client) {
  if (!client) return;
  if (!client.connected) {
    client.close();
    return;
  }
  await new Promise((resolve) => {
    client.once('disconnect', resolve);
    client.close();
  });
}

async function closeIoServer(io) {
  if (!io) return;
  await new Promise((resolve) => io.close(resolve));
}

async function closeHttpServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe('workspace-file-watcher', () => {
  let httpServer;
  let io;
  let port;
  let tmpDir;
  let watcher;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'watcher-test-'));
    registerWorktrees([{ id: 'test-wt', root: tmpDir, branch: 'main', head: 'abc' }]);

    httpServer = new HttpServer();
    io = new Server(httpServer, { cors: { origin: '*' } });
    watcher = setupWorkspaceFileWatcher(io);

    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        port = httpServer.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await closeIoServer(io);
    await closeHttpServer(httpServer);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('emits file-changed after atomic rename (write tmp + rename)', async () => {
    const filePath = join(tmpDir, 'target.md');
    await writeFile(filePath, 'version-1');
    const initialSha = sha256('version-1');

    const client = await connectClient(port);

    try {
      const ready = waitForSocketEvent(client, 'workspace:file-changed', FS_WATCH_EVENT_TIMEOUT_MS);
      client.emit('workspace:watch-file', { worktreeId: 'test-wt', path: 'target.md', sha256: null });
      const readyEvent = await ready;
      assert.equal(readyEvent.path, 'target.md');
      assert.equal(readyEvent.sha256, initialSha);

      // Atomic rename: write to tmp then rename over target
      const firstChange = waitForSocketEvent(client, 'workspace:file-changed', FS_WATCH_EVENT_TIMEOUT_MS);
      const tmpFile = join(tmpDir, 'target.md.tmp');
      await writeFile(tmpFile, 'version-2');
      const { rename } = await import('node:fs/promises');
      await rename(tmpFile, filePath);

      const firstEvent = await firstChange;
      assert.equal(firstEvent.path, 'target.md');
      assert.equal(firstEvent.sha256, sha256('version-2'));

      // Subsequent write should still trigger (watcher survives rename)
      const secondChange = waitForSocketEvent(client, 'workspace:file-changed', FS_WATCH_EVENT_TIMEOUT_MS);
      await writeFile(filePath, 'version-3');
      const secondEvent = await secondChange;
      assert.equal(secondEvent.sha256, sha256('version-3'));
    } finally {
      await disconnectClient(client);
    }
  });

  it('emits immediately when client sha256 is null (subscription window gap)', async () => {
    const filePath = join(tmpDir, 'gap-test.txt');
    await writeFile(filePath, 'current-content');
    const currentSha = sha256('current-content');

    const client = await connectClient(port);

    try {
      const changed = waitForSocketEvent(client, 'workspace:file-changed');

      // Client sends null sha (simulates socket connecting before initial GET completes)
      client.emit('workspace:watch-file', { worktreeId: 'test-wt', path: 'gap-test.txt', sha256: null });

      const event = await changed;
      assert.equal(event.sha256, currentSha);
      assert.equal(event.path, 'gap-test.txt');
    } finally {
      await disconnectClient(client);
    }
  });

  it('does NOT emit immediately when client sha matches current', async () => {
    const filePath = join(tmpDir, 'match-test.txt');
    await writeFile(filePath, 'same-content');
    const currentSha = sha256('same-content');

    const client = await connectClient(port);
    const events = [];

    try {
      client.on('workspace:file-changed', (data) => events.push(data));

      client.emit('workspace:watch-file', { worktreeId: 'test-wt', path: 'match-test.txt', sha256: currentSha });

      await wait(200);
      assert.equal(events.length, 0, 'Should NOT emit when sha matches');
    } finally {
      await disconnectClient(client);
    }
  });

  it('watches the native percent path instead of an encoded-looking sibling', async () => {
    await writeFile(join(tmpDir, 'literal%20.md'), 'literal-percent');
    await writeFile(join(tmpDir, 'literal .md'), 'decoded-sibling');
    const client = await connectClient(port);

    try {
      const changed = waitForSocketEvent(client, 'workspace:file-changed');
      client.emit('workspace:watch-file', {
        worktreeId: 'test-wt',
        path: 'literal%20.md',
        sha256: null,
      });

      const event = await changed;
      assert.equal(event.path, 'literal%20.md');
      assert.equal(event.sha256, sha256('literal-percent'));
    } finally {
      await disconnectClient(client);
    }
  });

  it('cleans up watcher on disconnect', async () => {
    const filePath = join(tmpDir, 'cleanup-test.txt');
    await writeFile(filePath, 'initial');

    const client = await connectClient(port);

    try {
      client.emit('workspace:watch-file', {
        worktreeId: 'test-wt',
        path: 'cleanup-test.txt',
        sha256: sha256('initial'),
      });
      await wait(100);

      await disconnectClient(client);
      await wait(100);

      // Modify file after disconnect — should not throw or crash the server
      await writeFile(filePath, 'modified-after-disconnect');
      await wait(400);
      // If we get here without crash, cleanup worked
      assert.ok(true);
    } finally {
      await disconnectClient(client);
    }
  });
  // One socket can carry several watches, each keyed by its watchId (plan B,
  // docs/plans/2026-11-05-hub-one-socket-per-page.md).
  it('keeps two watches on one socket and tags each change with its watchId', async () => {
    await writeFile(join(tmpDir, 'multi-a.txt'), 'a-1');
    await writeFile(join(tmpDir, 'multi-b.txt'), 'b-1');
    const client = await connectClient(port);
    const events = [];
    client.on('workspace:file-changed', (event) => events.push(event));

    try {
      client.emit('workspace:watch-file', {
        watchId: 'w-a',
        worktreeId: 'test-wt',
        path: 'multi-a.txt',
        sha256: sha256('a-1'),
      });
      client.emit('workspace:watch-file', {
        watchId: 'w-b',
        worktreeId: 'test-wt',
        path: 'multi-b.txt',
        sha256: sha256('b-1'),
      });
      await wait(200);

      await writeFile(join(tmpDir, 'multi-a.txt'), 'a-2');
      await writeFile(join(tmpDir, 'multi-b.txt'), 'b-2');
      await wait(1600);
      assert.deepEqual(events.map((e) => [e.watchId, e.path, e.sha256]).sort(), [
        ['w-a', 'multi-a.txt', sha256('a-2')],
        ['w-b', 'multi-b.txt', sha256('b-2')],
      ]);
      assert.equal(watcher.inspect().watches, 2);
    } finally {
      await disconnectClient(client);
    }
  });

  it('unwatch with a watchId releases only that watch', async () => {
    await writeFile(join(tmpDir, 'keep.txt'), 'keep-1');
    await writeFile(join(tmpDir, 'drop.txt'), 'drop-1');
    const client = await connectClient(port);
    const events = [];
    client.on('workspace:file-changed', (event) => events.push(event));

    try {
      client.emit('workspace:watch-file', {
        watchId: 'keep',
        worktreeId: 'test-wt',
        path: 'keep.txt',
        sha256: sha256('keep-1'),
      });
      client.emit('workspace:watch-file', {
        watchId: 'drop',
        worktreeId: 'test-wt',
        path: 'drop.txt',
        sha256: sha256('drop-1'),
      });
      await wait(200);
      client.emit('workspace:unwatch-file', { watchId: 'drop' });
      await wait(100);

      await writeFile(join(tmpDir, 'keep.txt'), 'keep-2');
      await writeFile(join(tmpDir, 'drop.txt'), 'drop-2');
      await wait(1600);
      assert.deepEqual(
        events.map((e) => e.watchId),
        ['keep'],
      );
      assert.equal(watcher.inspect().watches, 1);
    } finally {
      await disconnectClient(client);
    }
  });

  it('a payload-less unwatch from an old page releases only the legacy watch', async () => {
    await writeFile(join(tmpDir, 'legacy.txt'), 'legacy-1');
    await writeFile(join(tmpDir, 'modern.txt'), 'modern-1');
    const client = await connectClient(port);
    const events = [];
    client.on('workspace:file-changed', (event) => events.push(event));

    try {
      client.emit('workspace:watch-file', { worktreeId: 'test-wt', path: 'legacy.txt', sha256: sha256('legacy-1') });
      client.emit('workspace:watch-file', {
        watchId: 'modern',
        worktreeId: 'test-wt',
        path: 'modern.txt',
        sha256: sha256('modern-1'),
      });
      await wait(200);

      client.emit('workspace:unwatch-file');
      await wait(100);

      await writeFile(join(tmpDir, 'legacy.txt'), 'legacy-2');
      await writeFile(join(tmpDir, 'modern.txt'), 'modern-2');
      await wait(1600);
      assert.deepEqual(
        events.map((e) => e.watchId),
        ['modern'],
      );
      assert.equal(watcher.inspect().watches, 1);
    } finally {
      await disconnectClient(client);
    }
  });

  it('an unwatch that lands while the watch is still being established leaves nothing behind', async () => {
    await writeFile(join(tmpDir, 'pending-unwatch.txt'), 'pending');
    const client = await connectClient(port);
    const events = [];
    client.on('workspace:file-changed', (event) => events.push(event));

    try {
      // sha256: null would trigger an immediate notification once the watch is established.
      client.emit('workspace:watch-file', {
        watchId: 'p',
        worktreeId: 'test-wt',
        path: 'pending-unwatch.txt',
        sha256: null,
      });
      client.emit('workspace:unwatch-file', { watchId: 'p' });
      await wait(500);
      assert.deepEqual(events, []);
      assert.equal(watcher.inspect().watches, 0);
    } finally {
      await disconnectClient(client);
    }
  });

  it('a disconnect while the watch is still being established leaves nothing behind', async () => {
    await writeFile(join(tmpDir, 'pending-disconnect.txt'), 'pending');
    const before = watcher.inspect().watches;
    const client = await connectClient(port);
    client.emit('workspace:watch-file', {
      watchId: 'd',
      worktreeId: 'test-wt',
      path: 'pending-disconnect.txt',
      sha256: null,
    });
    await disconnectClient(client);
    await wait(500);
    assert.equal(watcher.inspect().watches, before);
  });

  it('a stale establishment cannot replace the watch that superseded it', async () => {
    await writeFile(join(tmpDir, 'stale-old.txt'), 'old');
    await writeFile(join(tmpDir, 'stale-new.txt'), 'new-1');
    const client = await connectClient(port);
    const events = [];
    client.on('workspace:file-changed', (event) => events.push(event));

    try {
      client.emit('workspace:watch-file', { watchId: 's', worktreeId: 'test-wt', path: 'stale-old.txt', sha256: null });
      client.emit('workspace:unwatch-file', { watchId: 's' });
      client.emit('workspace:watch-file', {
        watchId: 's',
        worktreeId: 'test-wt',
        path: 'stale-new.txt',
        sha256: sha256('new-1'),
      });
      await wait(500);
      assert.deepEqual(events, [], 'the cancelled establishment must not announce itself');

      await writeFile(join(tmpDir, 'stale-new.txt'), 'new-2');
      await wait(1600);
      assert.deepEqual(
        events.map((e) => [e.watchId, e.path]),
        [['s', 'stale-new.txt']],
      );
      assert.equal(watcher.inspect().watches, 1);
    } finally {
      await disconnectClient(client);
    }
  });
  it('a watchId that spells the internal legacy key is still an ordinary watch', async () => {
    await writeFile(join(tmpDir, 'spoof-legacy.txt'), 'spoof-1');
    await writeFile(join(tmpDir, 'real-legacy.txt'), 'real-1');
    const spoofId = '\u0000legacy';
    const client = await connectClient(port);
    const events = [];
    client.on('workspace:file-changed', (event) => events.push(event));

    try {
      client.emit('workspace:watch-file', {
        watchId: spoofId,
        worktreeId: 'test-wt',
        path: 'spoof-legacy.txt',
        sha256: sha256('spoof-1'),
      });
      client.emit('workspace:watch-file', { worktreeId: 'test-wt', path: 'real-legacy.txt', sha256: sha256('real-1') });
      await wait(200);

      // An old page's payload-less unwatch releases only the real legacy watch.
      client.emit('workspace:unwatch-file');
      await wait(100);

      await writeFile(join(tmpDir, 'spoof-legacy.txt'), 'spoof-2');
      await writeFile(join(tmpDir, 'real-legacy.txt'), 'real-2');
      await wait(1600);
      assert.deepEqual(
        events.map((e) => [e.watchId, e.path]),
        [[spoofId, 'spoof-legacy.txt']],
      );
      assert.equal(watcher.inspect().watches, 1);
    } finally {
      await disconnectClient(client);
    }
  });
});
