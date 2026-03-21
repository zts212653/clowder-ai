import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { PortDiscoveryService } from '../../../dist/domains/preview/port-discovery.js';
import { previewRoutes } from '../../../dist/routes/preview.js';

describe('preview routes', () => {
  const app = Fastify();
  const portDiscovery = new PortDiscoveryService();

  before(async () => {
    await app.register(previewRoutes, { portDiscovery, gatewayPort: 4100 });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('GET /api/preview/status returns gateway info', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/preview/status' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.available, true);
    assert.equal(body.gatewayPort, 4100);
  });

  it('POST /api/preview/validate-port allows valid port', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/validate-port',
      payload: { port: 5173 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, true);
  });

  it('POST /api/preview/validate-port rejects excluded port', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/validate-port',
      payload: { port: 6399 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, false);
    assert.ok(body.reason);
  });

  it('POST /api/preview/validate-port rejects non-loopback host', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/validate-port',
      payload: { port: 5173, host: '10.0.0.1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, false);
  });

  it('GET /api/preview/discovered returns empty initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/preview/discovered' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, []);
  });

  it('GET /api/preview/discovered filters by worktreeId', async () => {
    // Feed some data first
    await portDiscovery.feedStdout('test-wt', 'pane-1', 'http://localhost:59990');
    const res = await app.inject({
      method: 'GET',
      url: '/api/preview/discovered?worktreeId=test-wt',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.length, 1);
    assert.equal(body[0].port, 59990);
  });

  // P1-3: Audit endpoints for open/close/navigate
  it('POST /api/preview/open records audit event and returns gateway URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/open',
      payload: { port: 5173, threadId: 'test-thread' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, true);
    assert.ok(body.gatewayUrl);
  });

  it('POST /api/preview/close records audit event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/close',
      payload: { port: 5173, threadId: 'test-thread' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
  });

  it('POST /api/preview/navigate records audit event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/navigate',
      payload: { port: 5173, url: '/dashboard', threadId: 'test-thread' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
  });
});

describe('preview routes when gateway is disabled', () => {
  const app = Fastify();

  before(async () => {
    await app.register(previewRoutes, { portDiscovery: new PortDiscoveryService(), gatewayPort: 0 });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('GET /api/preview/status reports unavailable when gatewayPort=0', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/preview/status' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.available, false);
    assert.equal(body.gatewayPort, 0);
  });

  it('POST /api/preview/open returns unavailable instead of localhost:0 URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/open',
      payload: { port: 5173, threadId: 'test-thread' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, false);
    assert.match(body.reason, /preview gateway unavailable/i);
    assert.equal(body.gatewayUrl, undefined);
  });
});

// F120 Phase C: auto-open tests (need socketEmit)
describe('POST /api/preview/auto-open', () => {
  let app2;
  const emitted = [];

  before(async () => {
    app2 = Fastify();
    await app2.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: (event, data, room) => emitted.push({ event, data, room }),
    });
    await app2.ready();
  });

  after(async () => {
    await app2.close();
  });

  it('emits preview:auto-open socket event with port and path', async () => {
    emitted.length = 0;
    const res = await app2.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      payload: { port: 5173, path: '/dashboard' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, true);
    assert.equal(body.port, 5173);
    assert.equal(body.path, '/dashboard');
    // Without worktreeId: single emit to preview:global
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'preview:auto-open');
    assert.equal(emitted[0].data.port, 5173);
    assert.equal(emitted[0].data.path, '/dashboard');
    assert.equal(emitted[0].room, 'preview:global');
  });

  it('rejects excluded port (6399)', async () => {
    emitted.length = 0;
    const res = await app2.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      payload: { port: 6399 },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, false);
    assert.equal(emitted.length, 0); // no socket emit for rejected port
  });

  it('dual-broadcasts when worktreeId is provided (worktree room + global)', async () => {
    emitted.length = 0;
    const res = await app2.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      payload: { port: 5173, path: '/settings', worktreeId: 'wt-abc' },
    });
    assert.equal(res.statusCode, 200);
    // Should emit to BOTH rooms
    assert.equal(emitted.length, 2, 'should dual-broadcast to worktree room and preview:global');
    assert.equal(emitted[0].room, 'worktree:wt-abc');
    assert.equal(emitted[0].data.worktreeId, 'wt-abc');
    assert.equal(emitted[0].data.path, '/settings');
    assert.equal(emitted[1].room, 'preview:global');
    assert.equal(emitted[1].data.worktreeId, 'wt-abc');
  });

  it('works without path (port-only)', async () => {
    emitted.length = 0;
    const res = await app2.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      payload: { port: 3847 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, true);
    assert.equal(body.port, 3847);
    assert.equal(emitted[0].data.path, undefined);
  });

  it('emits only to preview:global when worktreeId is absent', async () => {
    emitted.length = 0;
    const res = await app2.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      payload: { port: 5173 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].room, 'preview:global');
  });
});

// F120 Phase C: screenshot upload endpoint
describe('POST /api/preview/screenshot', () => {
  let app3;
  /** @type {string | undefined} */
  let previousUploadDir;
  /** @type {string} */
  let customUploadDir;

  before(async () => {
    customUploadDir = await mkdtemp(join(tmpdir(), 'preview-screenshot-upload-'));
    previousUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = customUploadDir;
    app3 = Fastify();
    await app3.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
    });
    await app3.ready();
  });

  after(async () => {
    await app3.close();
    if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUploadDir;
    await rm(customUploadDir, { recursive: true, force: true });
  });

  it('accepts a data URL and returns upload path', async () => {
    // Minimal 1x1 red pixel PNG as data URL
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const res = await app3.inject({
      method: 'POST',
      url: '/api/preview/screenshot',
      payload: { dataUrl, threadId: 'test-thread' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.url, 'should return upload URL');
    assert.ok(body.url.startsWith('/uploads/'), 'URL should start with /uploads/');
    assert.ok(body.url.endsWith('.png'), 'URL should end with .png');
  });

  it('rejects invalid data URL', async () => {
    const res = await app3.inject({
      method: 'POST',
      url: '/api/preview/screenshot',
      payload: { dataUrl: 'not-a-data-url' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('writes screenshot files to UPLOAD_DIR when customized', async () => {
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const res = await app3.inject({
      method: 'POST',
      url: '/api/preview/screenshot',
      payload: { dataUrl, threadId: 'upload-dir-test-thread' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const filename = body.url.replace('/uploads/', '');
    const saved = await stat(join(customUploadDir, filename));
    assert.equal(saved.isFile(), true);
  });
});
