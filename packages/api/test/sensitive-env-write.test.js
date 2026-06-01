/**
 * F136 follow-up: Sensitive env write — owner gate + audit
 * Tests the PATCH /api/config/env owner gate for sensitive vars (F102_API_KEY etc.)
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const savedEnv = {};
function setEnv(key, value) {
  savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function addSessionHook(app) {
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
}

describe('PATCH /api/config/env — sensitive env owner gate', () => {
  afterEach(() => restoreEnv());

  it('rejects sensitive env writes from non-owner session operators', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'F102_API_KEY=sk-old\n', 'utf8');
    setEnv('DEFAULT_OWNER_USER_ID', 'you');

    const app = Fastify({ logger: false });
    addSessionHook(app);
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-test-session-user': 'codex' },
        payload: { updates: [{ name: 'F102_API_KEY', value: 'sk-new' }] },
      });

      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.payload).error, /only be modified by the owner/);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'F102_API_KEY=sk-old\n');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects sensitive env writes with header-only (non-session) identity', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'F102_API_KEY=sk-old\n', 'utf8');
    delete process.env.DEFAULT_OWNER_USER_ID;

    const app = Fastify({ logger: false });
    addSessionHook(app);
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'forged' },
        payload: { updates: [{ name: 'F102_API_KEY', value: 'sk-new' }] },
      });

      assert.equal(res.statusCode, 401);
      assert.match(JSON.parse(res.payload).error, /session authentication/);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'F102_API_KEY=sk-old\n');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('allows sensitive env writes in single-user mode when DEFAULT_OWNER_USER_ID is not configured (issue #794)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'F102_API_KEY=sk-old\n', 'utf8');
    delete process.env.DEFAULT_OWNER_USER_ID;

    const app = Fastify({ logger: false });
    addSessionHook(app);
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-test-session-user': 'any-user' },
        payload: { updates: [{ name: 'F102_API_KEY', value: 'sk-new' }] },
      });

      assert.equal(res.statusCode, 200, 'should return 200 in single-user mode');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('owner can write sensitive env vars and triggers dual audit trail', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'F102_API_KEY=sk-old\n', 'utf8');
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    const auditEvents = [];

    const app = Fastify({ logger: false });
    addSessionHook(app);
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async (event) => auditEvents.push(event) },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-test-session-user': 'you' },
        payload: { updates: [{ name: 'F102_API_KEY', value: 'sk-new-key-123' }] },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);

      // .env file updated
      assert.match(readFileSync(envFilePath, 'utf8'), /F102_API_KEY=/);

      // process.env updated
      assert.equal(process.env.F102_API_KEY, 'sk-new-key-123');

      // Summary masks value as ***
      const entry = body.summary?.find((v) => v.name === 'F102_API_KEY');
      assert.ok(entry, 'F102_API_KEY should be in summary');
      assert.equal(entry.currentValue, '***', 'sensitive value must be masked in summary');

      // Dual audit: config_updated + env_sensitive_write
      assert.equal(auditEvents.length, 2);
      assert.equal(auditEvents[0].type, 'config_updated');
      assert.equal(auditEvents[1].type, 'env_sensitive_write');
      assert.deepEqual(auditEvents[1].data.keys, ['F102_API_KEY']);
      assert.equal(auditEvents[1].data.operator, 'you');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('sensitive write audit uses session identity, not forgeable header', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'F102_API_KEY=sk-old\n', 'utf8');
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    const auditEvents = [];

    const app = Fastify({ logger: false });
    addSessionHook(app);
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async (event) => auditEvents.push(event) },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-test-session-user': 'you', 'x-cat-cafe-user': 'attacker' },
        payload: { updates: [{ name: 'F102_API_KEY', value: 'sk-new' }] },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(auditEvents.length, 2);
      assert.equal(auditEvents[0].data.operator, 'you', 'CONFIG_UPDATED must use session identity');
      assert.equal(auditEvents[1].data.operator, 'you', 'ENV_SENSITIVE_WRITE must use session identity');
      assert.notEqual(auditEvents[0].data.operator, 'attacker', 'forged header must not appear in audit');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects DEFAULT_OWNER_USER_ID edits (trust anchor protection, P1 fix)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'DEFAULT_OWNER_USER_ID=you\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'attacker' },
        payload: { updates: [{ name: 'DEFAULT_OWNER_USER_ID', value: 'attacker' }] },
      });

      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.payload).error, /not editable/);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('mixed-batch audit only logs sensitive keys (P2 fix)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'FRONTEND_URL=http://old\nF102_API_KEY=sk-old\n', 'utf8');
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    const auditEvents = [];

    const app = Fastify({ logger: false });
    addSessionHook(app);
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async (event) => auditEvents.push(event) },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-test-session-user': 'you' },
        payload: {
          updates: [
            { name: 'FRONTEND_URL', value: 'http://new' },
            { name: 'F102_API_KEY', value: 'sk-new' },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const sensitiveAudit = auditEvents.find((e) => e.type === 'env_sensitive_write');
      assert.ok(sensitiveAudit, 'should have env_sensitive_write event');
      assert.deepEqual(sensitiveAudit.data.keys, ['F102_API_KEY']);
      assert.ok(!sensitiveAudit.data.keys.includes('FRONTEND_URL'), 'non-sensitive key must not appear');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects sensitive env writes from non-loopback when owner is not configured (#794 P1)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'F102_API_KEY=sk-old\n', 'utf8');
    delete process.env.DEFAULT_OWNER_USER_ID;

    const app = Fastify({ logger: false });
    addSessionHook(app);
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-test-session-user': 'any-user' },
        payload: { updates: [{ name: 'F102_API_KEY', value: 'sk-new' }] },
        remoteAddress: '192.168.1.100',
      });

      assert.equal(res.statusCode, 403, 'non-loopback sensitive write without owner must be rejected');
      assert.match(
        JSON.parse(res.payload).error,
        /non-localhost|DEFAULT_OWNER_USER_ID/i,
        'error should mention network or owner requirement',
      );
      // .env must NOT be modified
      assert.equal(readFileSync(envFilePath, 'utf8'), 'F102_API_KEY=sk-old\n');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('allows sensitive env writes from non-loopback when owner IS configured and matches', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'F102_API_KEY=sk-old\n', 'utf8');
    setEnv('DEFAULT_OWNER_USER_ID', 'the-owner');

    const app = Fastify({ logger: false });
    addSessionHook(app);
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-test-session-user': 'the-owner' },
        payload: { updates: [{ name: 'F102_API_KEY', value: 'sk-new' }] },
        remoteAddress: '192.168.1.100',
      });

      assert.equal(res.statusCode, 200, 'non-loopback with matching owner should be allowed');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects proxy-forwarded loopback sensitive writes when owner is not configured (#794 proxy guard)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'F102_API_KEY=sk-old\n', 'utf8');
    delete process.env.DEFAULT_OWNER_USER_ID;

    const app = Fastify({ logger: false });
    addSessionHook(app);
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      // Loopback IP but with proxy forwarding header → not a direct client
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: {
          'x-test-session-user': 'any-user',
          'x-forwarded-for': '203.0.113.50',
        },
        payload: { updates: [{ name: 'F102_API_KEY', value: 'sk-new' }] },
      });

      assert.equal(res.statusCode, 403, 'proxy-forwarded loopback sensitive write without owner must be rejected');
      assert.equal(readFileSync(envFilePath, 'utf8'), 'F102_API_KEY=sk-old\n', '.env must NOT be modified');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('non-sensitive vars bypass owner gate even when DEFAULT_OWNER_USER_ID is set', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'FRONTEND_URL=http://old\n', 'utf8');
    setEnv('DEFAULT_OWNER_USER_ID', 'you');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: { updates: [{ name: 'FRONTEND_URL', value: 'http://new' }] },
      });

      assert.equal(res.statusCode, 200);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
