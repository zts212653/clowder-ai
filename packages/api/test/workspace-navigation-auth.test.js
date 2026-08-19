import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { EventAuditLog } from '../dist/domains/cats/services/orchestration/EventAuditLog.js';
import { registerWorktrees } from '../dist/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../dist/routes/workspace.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiIndexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
registerWorktrees([{ id: 'auth-test-wt', root: repoRoot, branch: 'main', head: 'abc123' }]);

function auditLogCollecting(target, suffix) {
  const auditLog = new EventAuditLog({ auditDir: `/tmp/cat-cafe-workspace-navigate-${suffix}-audit-test` });
  auditLog.append = async (input) => {
    target.push(input);
    return { id: `audit-${suffix}-1`, timestamp: Date.now(), ...input };
  };
  return auditLog;
}

describe('POST /api/workspace/navigate authentication boundary', () => {
  it('wires callback-token and agent-key verification at the API composition root', () => {
    assert.match(
      apiIndexSource,
      /app\.register\(workspaceRoutes,\s*\{\s*callbackRegistry: registry,\s*agentKeyRegistry,/,
    );
  });

  it('rejects unauthenticated navigation before filesystem lookup, broadcast, or audit', async () => {
    const app = Fastify();
    const emittedEvents = [];
    const auditEvents = [];
    await app.register(workspaceRoutes, {
      auditLog: auditLogCollecting(auditEvents, 'unauthenticated'),
      socketEmit: (event, data, room) => emittedEvents.push({ event, data, room }),
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      payload: {
        path: resolve(repoRoot, 'package.json'),
        action: 'open',
        catId: 'spoofed-cat',
      },
    });

    assert.equal(res.statusCode, 401);
    assert.match(JSON.parse(res.body).error, /authentication required/i);
    assert.equal(emittedEvents.length, 0);
    assert.equal(auditEvents.length, 0);
    await app.close();
  });

  it('rejects a remotely spoofed x-cat-cafe-user identity', async () => {
    const app = Fastify();
    await app.register(workspaceRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      remoteAddress: '203.0.113.10',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { path: resolve(repoRoot, 'package.json'), action: 'open' },
    });

    assert.equal(res.statusCode, 401);
    assert.match(JSON.parse(res.body).error, /authentication required/i);

    const documentRes = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-document-link',
      remoteAddress: '203.0.113.10',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { href: resolve(repoRoot, 'README.md') },
    });
    assert.equal(documentRes.statusCode, 401);
    assert.match(JSON.parse(documentRes.body).error, /authentication required/i);
    await app.close();
  });

  it('derives audit cat identity from a verified callback principal', async () => {
    const app = Fastify();
    const auditEvents = [];
    const emittedEvents = [];
    await app.register(workspaceRoutes, {
      auditLog: auditLogCollecting(auditEvents, 'callback'),
      socketEmit: (event, data, room) => emittedEvents.push({ event, data, room }),
      callbackRegistry: {
        verify: async (invocationId, callbackToken) =>
          invocationId === 'inv-workspace' && callbackToken === 'callback-secret'
            ? {
                ok: true,
                record: {
                  invocationId,
                  callbackToken,
                  threadId: 'thread-callback',
                  userId: 'default-user',
                  catId: 'codex-sol',
                  clientMessageIds: new Set(),
                  createdAt: Date.now(),
                  expiresAt: Date.now() + 60_000,
                },
              }
            : { ok: false, reason: 'invalid_token' },
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      headers: {
        'x-invocation-id': 'inv-workspace',
        'x-callback-token': 'callback-secret',
      },
      payload: {
        path: resolve(repoRoot, 'package.json'),
        action: 'open',
        catId: 'spoofed-cat',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].threadId, 'thread-callback');
    assert.equal(auditEvents[0].data.catId, 'codex-sol');
    assert.equal(emittedEvents[0].data.threadId, 'thread-callback');
    await app.close();
  });

  it('rejects an invocation principal targeting a thread outside its user scope', async () => {
    const app = Fastify();
    const emittedEvents = [];
    const auditEvents = [];
    await app.register(workspaceRoutes, {
      auditLog: auditLogCollecting(auditEvents, 'callback-cross-thread'),
      socketEmit: (event, data, room) => emittedEvents.push({ event, data, room }),
      callbackRegistry: {
        verify: async () => ({
          ok: true,
          record: {
            invocationId: 'inv-workspace-cross-thread',
            callbackToken: 'callback-secret',
            threadId: 'thread-callback',
            userId: 'default-user',
            catId: 'codex-sol',
            clientMessageIds: new Set(),
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
        }),
      },
      threadStore: {
        async get() {
          return { id: 'thread-other-user', createdBy: 'other-user' };
        },
        async list() {
          return [];
        },
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      headers: {
        'x-invocation-id': 'inv-workspace-cross-thread',
        'x-callback-token': 'callback-secret',
      },
      payload: {
        path: resolve(repoRoot, 'package.json'),
        action: 'open',
        threadId: 'thread-other-user',
      },
    });

    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /thread access denied/i);
    assert.equal(emittedEvents.length, 0);
    assert.equal(auditEvents.length, 0);
    await app.close();
  });

  it('accepts a verified agent-key principal and ignores the payload cat identity', async () => {
    const app = Fastify();
    const auditEvents = [];
    await app.register(workspaceRoutes, {
      auditLog: auditLogCollecting(auditEvents, 'agent-key'),
      callbackRegistry: {
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      agentKeyRegistry: {
        verify: async (secret) =>
          secret === 'agent-key-secret'
            ? {
                ok: true,
                record: {
                  agentKeyId: 'ak-workspace',
                  catId: 'codex-sol',
                  userId: 'default-user',
                  secretHash: 'hash',
                  salt: 'salt',
                  scope: 'user-bound',
                  issuedAt: Date.now(),
                  expiresAt: Date.now() + 60_000,
                },
              }
            : { ok: false, reason: 'agent_key_unknown' },
      },
      threadStore: {
        async get() {
          return { id: 'thread-agent-key', createdBy: 'default-user' };
        },
        async list() {
          return [];
        },
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      headers: { 'x-agent-key-secret': 'agent-key-secret' },
      payload: {
        path: resolve(repoRoot, 'package.json'),
        action: 'open',
        threadId: 'thread-agent-key',
        catId: 'spoofed-cat',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].data.catId, 'codex-sol');
    await app.close();
  });

  it('rejects an agent-key principal targeting a thread outside its user scope', async () => {
    const app = Fastify();
    const emittedEvents = [];
    const auditEvents = [];
    await app.register(workspaceRoutes, {
      auditLog: auditLogCollecting(auditEvents, 'agent-key-cross-thread'),
      socketEmit: (event, data, room) => emittedEvents.push({ event, data, room }),
      callbackRegistry: {
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      agentKeyRegistry: {
        verify: async () => ({
          ok: true,
          record: {
            agentKeyId: 'ak-workspace',
            catId: 'codex-sol',
            userId: 'default-user',
            secretHash: 'hash',
            salt: 'salt',
            scope: 'user-bound',
            issuedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
        }),
      },
      threadStore: {
        async get() {
          return { id: 'thread-other-user', createdBy: 'other-user' };
        },
        async list() {
          return [];
        },
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      headers: { 'x-agent-key-secret': 'agent-key-secret' },
      payload: {
        path: resolve(repoRoot, 'package.json'),
        action: 'open',
        threadId: 'thread-other-user',
      },
    });

    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /thread access denied/i);
    assert.equal(emittedEvents.length, 0);
    assert.equal(auditEvents.length, 0);
    await app.close();
  });
});
