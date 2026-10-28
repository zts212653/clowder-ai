import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { withInvocationCredentials } from '../../../mcp-server/dist/tools/invocation-auth.js';
import { handleScanPawFeelInbox } from '../../../mcp-server/dist/tools/paw-feel-inbox-audit-scan-tool.js';
import {
  PawFeelInboxAuditCursorError,
  PawFeelInboxAuditCursorSigner,
  PawFeelInboxAuditScanService,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/inbox-audit-scan.js';
import { pawFeelInboxAuditScanRoutes } from '../../dist/routes/paw-feel-inbox-audit-scan.js';

function callbackRegistry() {
  return {
    async verify(invocationId, callbackToken) {
      if (invocationId !== 'inv-1' || callbackToken !== 'token-1') {
        return { ok: false, reason: 'unknown_invocation' };
      }
      return {
        ok: true,
        record: {
          invocationId,
          callbackToken,
          threadId: 'thread_eval_friction',
          userId: 'user-1',
          catId: 'codex-sol',
        },
      };
    },
  };
}

function realHttpRequest({ port, method, path, body }) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          'x-invocation-id': 'inv-1',
          'x-callback-token': 'token-1',
          ...(encoded
            ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error('real HTTP audit scan request timed out')));
    request.on('error', reject);
    request.end(encoded);
  });
}

describe('F278 cat-authenticated bounded inbox audit scan route', () => {
  const apps = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('requires callback auth, forwards POST body, and leaves GET retired', async () => {
    const calls = [];
    const app = Fastify();
    await app.register(pawFeelInboxAuditScanRoutes, {
      callbackRegistry: callbackRegistry(),
      auditScanService: {
        async read(input) {
          calls.push(input);
          return {
            status: 'partial',
            startedAt: '2026-10-22T17:00:00.000Z',
            generatedAt: '2026-10-22T17:00:01.000Z',
            pageScannedSignals: 25,
            totalScannedSignals: 25,
            entries: [],
            nextCursor: 'signed-cursor',
          };
        },
      },
    });
    await app.ready();
    apps.push(app);

    const denied = await app.inject({ method: 'POST', url: '/api/callbacks/paw-feel-inbox-audit-scan' });
    assert.equal(denied.statusCode, 401);
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-inbox-audit-scan',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
      payload: { limit: 25, cursor: 'opaque' },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.json().nextCursor, 'signed-cursor');
    assert.deepEqual(calls, [{ cursor: 'opaque', limit: 25 }]);

    const retiredGet = await app.inject({
      method: 'GET',
      url: '/api/callbacks/paw-feel-inbox-audit-scan?limit=25&cursor=opaque',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
    });
    assert.equal(retiredGet.statusCode, 404);
  });

  it('maps invalid cursors to 400 and an unavailable service to 503', async () => {
    const app = Fastify();
    await app.register(pawFeelInboxAuditScanRoutes, {
      callbackRegistry: callbackRegistry(),
      auditScanService: {
        async read() {
          throw new PawFeelInboxAuditCursorError('invalid inbox audit cursor signature');
        },
      },
    });
    await app.ready();
    apps.push(app);
    const forged = await app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-inbox-audit-scan',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
      payload: { cursor: 'forged' },
    });
    assert.equal(forged.statusCode, 400);
    assert.equal(forged.json().error, 'invalid_paw_feel_inbox_audit_cursor');

    const unavailable = Fastify();
    await unavailable.register(pawFeelInboxAuditScanRoutes, { callbackRegistry: callbackRegistry() });
    await unavailable.ready();
    apps.push(unavailable);
    const response = await unavailable.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-inbox-audit-scan',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
    });
    assert.equal(response.statusCode, 503);
  });

  it('accepts a large signed cursor through a real POST body', async () => {
    const calls = [];
    const cursor = 'x'.repeat(16_139);
    const app = Fastify();
    await app.register(pawFeelInboxAuditScanRoutes, {
      callbackRegistry: callbackRegistry(),
      auditScanService: {
        async read(input) {
          calls.push(input);
          return {
            status: 'partial',
            startedAt: '2026-10-22T17:00:00.000Z',
            generatedAt: '2026-10-22T17:00:01.000Z',
            pageScannedSignals: 50,
            totalScannedSignals: 100,
            entries: [],
            nextCursor: 'next-signed-cursor',
          };
        },
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    apps.push(app);
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');

    const response = await realHttpRequest({
      port: address.port,
      method: 'POST',
      path: '/api/callbacks/paw-feel-inbox-audit-scan',
      body: { limit: 50, cursor },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [{ limit: 50, cursor }]);
  });

  it('carries two bounded pages through the built MCP handler and real HTTP route', async () => {
    const signalIds = Array.from(
      { length: 10_000 },
      (_, index) => `message-${String(index).padStart(5, '0')}:${'a'.repeat(64)}:0`,
    );
    const readBatches = [];
    const service = new PawFeelInboxAuditScanService({
      eventLog: {
        async scanSignalIds(cursor, limit) {
          const offset = cursor ? Number(cursor.redisCursor) : 0;
          const page = signalIds.slice(offset, offset + limit);
          const next = offset + page.length;
          return {
            signalIds: page,
            scanCalls: 1,
            ...(next < signalIds.length
              ? {
                  nextCursor: {
                    redisCursor: String(next),
                    pendingSignalIds: [],
                    completeAfterPending: false,
                  },
                }
              : {}),
          };
        },
      },
      readModel: {
        async readAuditSignals(ids) {
          readBatches.push([...ids]);
          return ids.map((signalId) => ({
            disposition: { signalId },
            source: { availability: 'available', preview: signalId, sourceHref: '/thread/thread-source' },
          }));
        },
      },
      signer: new PawFeelInboxAuditCursorSigner(Buffer.alloc(32, 7)),
      now: () => '2026-10-22T17:00:00.000Z',
    });
    const app = Fastify();
    await app.register(pawFeelInboxAuditScanRoutes, {
      callbackRegistry: callbackRegistry(),
      auditScanService: service,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    apps.push(app);
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    await withInvocationCredentials(
      {
        apiUrl: `http://127.0.0.1:${address.port}`,
        invocationId: 'inv-1',
        callbackToken: 'token-1',
      },
      async () => {
        const firstResult = await handleScanPawFeelInbox({ limit: 50 });
        assert.equal(firstResult.isError, undefined, JSON.stringify(firstResult));
        const first = JSON.parse(firstResult.content[0].text);
        const secondResult = await handleScanPawFeelInbox({ limit: 50, cursor: first.nextCursor });
        assert.equal(secondResult.isError, undefined, JSON.stringify(secondResult));
        const second = JSON.parse(secondResult.content[0].text);

        assert.deepEqual(
          readBatches.map((batch) => batch.length),
          [50, 50],
        );
        assert.equal(new Set(readBatches.flat()).size, 100);
        assert.equal(first.totalScannedSignals, 50);
        assert.equal(second.totalScannedSignals, 100);
        assert.equal(first.entries.length, 50);
        assert.equal(second.entries.length, 50);
        for (const key of ['bundleCounts', 'denominator', 'responsibilityCounts', 'issueCounts']) {
          assert.equal(key in first, false);
          assert.equal(key in second, false);
        }
      },
    );
  });
});
