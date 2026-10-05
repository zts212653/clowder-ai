import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { LegacyPawFeelBlockerCensusCursorError } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/legacy-blocker-census.js';
import { pawFeelLegacyCensusRoutes } from '../../dist/routes/paw-feel-legacy-census.js';

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

function realHttpRequest({ port, method, path, body, invocationId = 'inv-1', callbackToken = 'token-1' }) {
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
          'x-invocation-id': invocationId,
          'x-callback-token': callbackToken,
          accept: '*/*',
          'accept-language': '*',
          'sec-fetch-mode': 'cors',
          'user-agent': 'node',
          'accept-encoding': 'gzip, deflate',
          connection: 'keep-alive',
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
    request.setTimeout(5_000, () => request.destroy(new Error('real HTTP census request timed out')));
    request.on('error', reject);
    request.end(encoded);
  });
}

describe('F313 cat-authenticated legacy blocker census route', () => {
  const apps = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('requires callback auth and returns a refs-only partial page', async () => {
    const calls = [];
    const app = Fastify();
    await app.register(pawFeelLegacyCensusRoutes, {
      callbackRegistry: callbackRegistry(),
      censusService: {
        async read(input) {
          calls.push(input);
          return {
            status: 'partial',
            pageScannedSignals: 50,
            totalScannedSignals: 50,
            nextCursor: 'signed-cursor',
          };
        },
      },
    });
    await app.ready();
    apps.push(app);

    const denied = await app.inject({ method: 'POST', url: '/api/callbacks/paw-feel-legacy-blocker-census' });
    assert.equal(denied.statusCode, 401);
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-legacy-blocker-census',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
      payload: { limit: 25, cursor: 'opaque' },
    });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json(), {
      status: 'partial',
      pageScannedSignals: 50,
      totalScannedSignals: 50,
      nextCursor: 'signed-cursor',
    });
    assert.deepEqual(calls, [{ cursor: 'opaque', limit: 25 }]);
    assert.equal(JSON.stringify(allowed.json()).includes('blockerRef'), false);

    const retiredGet = await app.inject({
      method: 'GET',
      url: '/api/callbacks/paw-feel-legacy-blocker-census?limit=25&cursor=opaque',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
    });
    assert.equal(retiredGet.statusCode, 404);
  });

  it('maps a forged cursor to 400 and an unavailable service to 503', async () => {
    const app = Fastify();
    await app.register(pawFeelLegacyCensusRoutes, {
      callbackRegistry: callbackRegistry(),
      censusService: {
        async read() {
          throw new LegacyPawFeelBlockerCensusCursorError('invalid legacy census cursor signature');
        },
      },
    });
    await app.ready();
    apps.push(app);
    const forged = await app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-legacy-blocker-census',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
      payload: { cursor: 'forged' },
    });
    assert.equal(forged.statusCode, 400);
    assert.equal(forged.json().error, 'invalid_legacy_census_cursor');

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-legacy-blocker-census',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
      payload: { cursor: 'x'.repeat(100_001) },
    });
    assert.equal(oversized.statusCode, 400);
    assert.equal(oversized.json().error, 'invalid_legacy_census_request');

    const unavailable = Fastify();
    await unavailable.register(pawFeelLegacyCensusRoutes, { callbackRegistry: callbackRegistry() });
    await unavailable.ready();
    apps.push(unavailable);
    const response = await unavailable.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-legacy-blocker-census',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
    });
    assert.equal(response.statusCode, 503);
  });

  it('moves a production-sized signed cursor from the real HTTP request line into the POST body', async () => {
    const calls = [];
    const cursor = 'x'.repeat(16_139);
    const app = Fastify();
    await app.register(pawFeelLegacyCensusRoutes, {
      callbackRegistry: callbackRegistry(),
      censusService: {
        async read(input) {
          calls.push(input);
          return {
            status: 'partial',
            pageScannedSignals: 50,
            totalScannedSignals: 750,
            nextCursor: 'next-signed-cursor',
          };
        },
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    apps.push(app);
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');

    const oversizedGet = await realHttpRequest({
      port: address.port,
      method: 'GET',
      path: `/api/callbacks/paw-feel-legacy-blocker-census?limit=50&cursor=${cursor}`,
      // Opaque callback credentials share the same parser envelope as the request line.
      callbackToken: 't'.repeat(512),
    });
    assert.equal(oversizedGet.statusCode, 431);

    const response = await realHttpRequest({
      port: address.port,
      method: 'POST',
      path: '/api/callbacks/paw-feel-legacy-blocker-census',
      body: { limit: 50, cursor },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [{ limit: 50, cursor }]);
  });
});
