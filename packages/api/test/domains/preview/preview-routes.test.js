import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { EventAuditLog } from '../../../dist/domains/cats/services/orchestration/EventAuditLog.js';
import { PortDiscoveryService } from '../../../dist/domains/preview/port-discovery.js';
import { previewRoutes } from '../../../dist/routes/preview.js';

describe('preview routes', () => {
  const app = Fastify();
  const portDiscovery = new PortDiscoveryService();
  const appendedAuditEvents = [];

  before(async () => {
    const auditLog = new EventAuditLog({ auditDir: '/tmp/cat-cafe-preview-audit-test' });
    auditLog.append = async (input) => {
      appendedAuditEvents.push(input);
      return { id: 'audit-1', timestamp: Date.now(), ...input };
    };
    await app.register(previewRoutes, { portDiscovery, gatewayPort: 4100, auditLog });
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
    appendedAuditEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/open',
      payload: { port: 5173, threadId: 'test-thread', catId: 'gpt52' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, true);
    assert.equal(body.gatewayUrl, 'http://preview-5173.localhost:4100/');
    assert.equal(appendedAuditEvents[0].data.catId, 'gpt52');
  });

  it('POST /api/preview/close records audit event', async () => {
    appendedAuditEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/close',
      payload: { port: 5173, threadId: 'test-thread', catId: 'gpt52' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(appendedAuditEvents[0].data.catId, 'gpt52');
  });

  it('POST /api/preview/navigate records audit event', async () => {
    appendedAuditEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/navigate',
      payload: { port: 5173, url: '/dashboard', threadId: 'test-thread', catId: 'gpt52' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(appendedAuditEvents[0].data.catId, 'gpt52');
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
// F120 × F284 review P1: auto-open is authenticated + exact-thread scoped.
// The interactive test identity uses a direct loopback call with an explicit
// X-Cat-Cafe-User header (fastify inject is loopback, no Origin header).
const INTERACTIVE_HEADERS = { 'x-cat-cafe-user': 'tester' };

describe('POST /api/preview/auto-open', () => {
  let app2;
  const legacyEmitted = [];
  const ackEmitted = [];

  before(async () => {
    app2 = Fastify();
    await app2.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: (event, data, room) => legacyEmitted.push({ event, data, room }),
      socketEmitWithAck: async (event, data, room) => {
        ackEmitted.push({ event, data, room });
        return [];
      },
    });
    await app2.ready();
  });

  after(async () => {
    await app2.close();
  });

  beforeEach(() => {
    legacyEmitted.length = 0;
    ackEmitted.length = 0;
  });

  it('delivers only to the caller user room — never to preview:global / worktree rooms', async () => {
    const res = await app2.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: INTERACTIVE_HEADERS,
      payload: { port: 5173, path: '/dashboard', threadId: 'default', worktreeId: 'wt-abc', catId: 'gpt52' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, true);
    assert.equal(body.port, 5173);
    assert.equal(body.path, '/dashboard');
    assert.equal(body.threadId, 'default');
    // Review round-2 P1: no legacy fire-and-forget broadcast — a foreign
    // observer in preview:global / worktree rooms must never see the event.
    assert.equal(legacyEmitted.length, 0, 'no legacy room emission');
    assert.equal(ackEmitted.length, 1);
    assert.equal(ackEmitted[0].event, 'preview:auto-open');
    assert.equal(ackEmitted[0].room, 'user:tester');
    assert.equal(ackEmitted[0].data.port, 5173);
    assert.equal(ackEmitted[0].data.path, '/dashboard');
    assert.equal(ackEmitted[0].data.threadId, 'default');
    assert.equal(ackEmitted[0].data.worktreeId, 'wt-abc');
    assert.equal(ackEmitted[0].data.eventId, body.eventId);
  });

  it('rejects excluded port (6399)', async () => {
    const res = await app2.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: INTERACTIVE_HEADERS,
      payload: { port: 6399, threadId: 'default' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, false);
    assert.equal(legacyEmitted.length, 0);
    assert.equal(ackEmitted.length, 0); // no socket emit for rejected port
  });

  it('works without path and without worktreeId (port-only)', async () => {
    const res = await app2.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: INTERACTIVE_HEADERS,
      payload: { port: 3847, threadId: 'default' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, true);
    assert.equal(body.port, 3847);
    assert.equal(legacyEmitted.length, 0);
    assert.equal(ackEmitted.length, 1);
    assert.equal(ackEmitted[0].data.path, undefined);
    assert.equal(ackEmitted[0].data.worktreeId, undefined);
    assert.equal(ackEmitted[0].room, 'user:tester');
  });

  it('reports deliveryStatus unconfirmed when the ack channel answers nothing', async () => {
    const res = await app2.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: INTERACTIVE_HEADERS,
      payload: { port: 5173, path: '/dash', threadId: 'default' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.allowed, true);
    assert.equal(body.deliveryStatus, 'unconfirmed');
    assert.equal(body.deliveryReason, 'no_client_ack');
    assert.ok(body.eventId, 'response carries an eventId for receipt correlation');
    assert.equal(ackEmitted[0].data.eventId, body.eventId, 'socket payload carries the same eventId');
  });
});

// F120 × F284 review P1: auth matrix — anonymous / thread scope enforcement
describe('POST /api/preview/auto-open auth', () => {
  it('denies anonymous requests (401) and emits nothing', async () => {
    const emitted = [];
    const app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: (event, data, room) => emitted.push({ event, data, room }),
      socketEmitWithAck: async () => [{ status: 'applied', eventId: 'x' }],
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      payload: { port: 5173, threadId: 'default' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(emitted.length, 0, 'no socket emit for anonymous calls');
    await app.close();
  });

  it('requires threadId for interactive sessions (400)', async () => {
    const app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: () => {},
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: INTERACTIVE_HEADERS,
      payload: { port: 5173 },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  const agentKeyRecord = {
    agentKeyId: 'ak-1',
    catId: 'kimi',
    userId: 'key-user',
    secretHash: 'h',
    salt: 's',
    scope: 'user-bound',
    issuedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const invocationRecord = {
    invocationId: 'inv-1',
    threadId: 'thread-inv',
    userId: 'inv-user',
    catId: 'kimi',
    targetCats: ['kimi'],
  };

  function fakeRegistries(threadStore) {
    return {
      callbackRegistry: {
        verify: async (invocationId, callbackToken) =>
          invocationId === 'inv-1' && callbackToken === 'tok'
            ? { ok: true, record: invocationRecord }
            : { ok: false, reason: 'invalid_token' },
      },
      agentKeyRegistry: {
        verify: async (secret) =>
          secret === 'ak-secret' ? { ok: true, record: agentKeyRecord } : { ok: false, reason: 'invalid_secret' },
      },
      threadStore,
    };
  }

  it('agent-key without threadId → 400', async () => {
    const app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: () => {},
      ...fakeRegistries({ get: async () => null, list: async () => [] }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: { 'x-agent-key-secret': 'ak-secret' },
      payload: { port: 5173 },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it('agent-key targeting a thread outside its user scope → 403', async () => {
    const app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: () => {},
      ...fakeRegistries({
        get: async (id) => (id === 'thread-other' ? { id, createdBy: 'someone-else' } : null),
        list: async () => [],
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: { 'x-agent-key-secret': 'ak-secret' },
      payload: { port: 5173, threadId: 'thread-other' },
    });
    assert.equal(res.statusCode, 403);
    await app.close();
  });

  it('agent-key happy path: acks collected on the caller user room', async () => {
    const ackRooms = [];
    const app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: () => {},
      socketEmitWithAck: async (_event, data, room) => {
        ackRooms.push(room);
        return [{ status: 'applied', eventId: data.eventId }];
      },
      ...fakeRegistries({
        get: async (id) => (id === 'thread-mine' ? { id, createdBy: 'key-user' } : null),
        list: async () => [],
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: { 'x-agent-key-secret': 'ak-secret' },
      payload: { port: 5173, threadId: 'thread-mine' },
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.deliveryStatus, 'applied');
    assert.equal(body.threadId, 'thread-mine');
    assert.deepEqual(ackRooms, ['user:key-user'], 'ack collection is tenant-scoped to the caller user room');
    await app.close();
  });

  it('invocation auth derives the thread from the invocation record; body mismatch → 403', async () => {
    const app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: () => {},
      socketEmitWithAck: async (_event, data) => [{ status: 'applied', eventId: data.eventId }],
      ...fakeRegistries({ get: async () => null, list: async () => [] }),
    });
    await app.ready();
    // Derived thread when body omits threadId
    const ok = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'tok' },
      payload: { port: 5173 },
    });
    const okBody = JSON.parse(ok.body);
    assert.equal(ok.statusCode, 200);
    assert.equal(okBody.threadId, 'thread-inv');
    // Cross-thread body override rejected
    const bad = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'tok' },
      payload: { port: 5173, threadId: 'thread-other' },
    });
    assert.equal(bad.statusCode, 403);
    await app.close();
  });
});

// F120 × F284: delivery ack — admission must not masquerade as visible
describe('POST /api/preview/auto-open delivery ack', () => {
  it('returns deliveryStatus applied when a client acks applied', async () => {
    const app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: () => {},
      socketEmitWithAck: async (_event, data, room) => {
        assert.equal(room, 'user:tester');
        return [{ status: 'applied', eventId: data.eventId }];
      },
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: INTERACTIVE_HEADERS,
      payload: { port: 5173, path: '/ok', threadId: 'default' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.deliveryStatus, 'applied');
    assert.equal(body.deliveryReason, undefined);
    await app.close();
  });

  it('aggregates queued receipts with their reason', async () => {
    const app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: () => {},
      socketEmitWithAck: async (_event, data) => [
        { status: 'queued', eventId: data.eventId, reason: 'thread_inactive' },
      ],
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: INTERACTIVE_HEADERS,
      payload: { port: 5173, threadId: 'thread-b' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.deliveryStatus, 'queued');
    assert.equal(body.deliveryReason, 'thread_inactive');
    await app.close();
  });

  it('treats ack timeout / missing ack callback as unconfirmed', async () => {
    const app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: () => {},
      socketEmitWithAck: async () => [],
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: INTERACTIVE_HEADERS,
      payload: { port: 5173, threadId: 'default' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.deliveryStatus, 'unconfirmed');
    assert.equal(body.deliveryReason, 'no_client_ack');
    await app.close();
  });

  it('skipped receipts never win; applied still resolves across tabs', async () => {
    const app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: () => {},
      socketEmitWithAck: async (_event, data) => [
        { status: 'skipped', eventId: data.eventId, reason: 'worktree_mismatch' },
        { status: 'applied', eventId: data.eventId },
      ],
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: INTERACTIVE_HEADERS,
      payload: { port: 5173, threadId: 'default' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.deliveryStatus, 'applied');
    await app.close();
  });

  it('only-skipped receipts report unconfirmed/no_matching_client (distinct from no ack)', async () => {
    const app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
      socketEmit: () => {},
      socketEmitWithAck: async (_event, data) => [
        { status: 'skipped', eventId: data.eventId, reason: 'worktree_mismatch' },
      ],
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview/auto-open',
      headers: INTERACTIVE_HEADERS,
      payload: { port: 5173, threadId: 'default' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.deliveryStatus, 'unconfirmed');
    assert.equal(body.deliveryReason, 'no_matching_client');
    await app.close();
  });
});

// F120 × F284: target liveness probe — restored previews of dead dev servers
// must surface a stopped/unavailable state instead of an error shell.
describe('GET /api/preview/target-health', () => {
  let app;
  let liveServer;
  let livePort;

  before(async () => {
    app = Fastify();
    await app.register(previewRoutes, {
      portDiscovery: new PortDiscoveryService(),
      gatewayPort: 4100,
    });
    await app.ready();
    liveServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
    livePort = liveServer.address().port;
  });

  after(async () => {
    await new Promise((resolve) => liveServer.close(resolve));
    await app.close();
  });

  it('reports reachable for a live target', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/preview/target-health?port=${livePort}` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { port: livePort, reachable: true });
  });

  it('reports unreachable for a dead target', async () => {
    // Port 1 is reserved and refuses connections immediately.
    const res = await app.inject({ method: 'GET', url: '/api/preview/target-health?port=1' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.port, 1);
    assert.equal(body.reachable, false);
  });

  it('rejects excluded ports fail-closed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/preview/target-health?port=6399' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.reachable, false);
    assert.ok(body.reason);
  });

  it('rejects a missing or invalid port', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/preview/target-health' });
    assert.equal(res.statusCode, 400);
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
