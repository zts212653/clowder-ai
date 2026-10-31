import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { registerConnectionDiagnostics } from '../src/routes/connection-diagnostics.js';

async function fixture(onRecord?: (record: Record<string, unknown>) => void) {
  const records: Record<string, unknown>[] = [];
  const app = Fastify({
    forceCloseConnections: true,
    logger: {
      level: 'info',
      stream: {
        write(line: string) {
          const record = JSON.parse(line) as Record<string, unknown>;
          records.push(record);
          onRecord?.(record);
        },
      },
    },
  });
  await app.register(cors, { origin: /^http:\/\/127\.0\.0\.1(?::\d+)?$/, credentials: true, maxAge: 600 });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  registerConnectionDiagnostics(app, 10);
  return { app, records };
}

async function observedWithin<T>(signal: Promise<T>, stage: string, records: Record<string, unknown>[]): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Missing ${stage}: ${JSON.stringify(records.map(({ event, state, source, clientRequestId }) => ({ event, state, source, clientRequestId })))}`,
              ),
            ),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  'a still-waiting real request leaves correlated progress and preserves its eventual result',
  { timeout: 5_000 },
  async () => {
    let observed!: (record: Record<string, unknown>) => void;
    const observation = new Promise<Record<string, unknown>>((resolve) => {
      observed = resolve;
    });
    const { app, records } = await fixture((record) => {
      if (record.event === 'connection_diagnostic' && record.state === 'pending') observed(record);
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.get('/api/threads/:id/artifacts', async (request) => {
      request.log.info({ stage: 'fixture_wait' }, 'fixture stage');
      await gate;
      return { canonical: true };
    });
    const clientRequestId = randomUUID();
    const request = app.inject({
      url: '/api/threads/private-thread/artifacts?secret=private-query',
      headers: { 'x-clowder-client-request': clientRequestId },
    });
    try {
      const pending = await observation;
      assert.ok(pending, 'pending observation exists before handler completion');
      assert.equal(pending.clientRequestId, clientRequestId);
      assert.equal(pending.route, 'artifacts');
      assert.equal(typeof pending.timerLagMs, 'number');
      assert.equal(typeof pending.processCpuUserMs, 'number');
      assert.equal(records.find((r) => r.stage === 'fixture_wait')?.clientRequestId, clientRequestId);
      release();
      const response = await request;
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { canonical: true });
      const diagnostics = records.filter((r) => r.event === 'connection_diagnostic');
      assert.equal(diagnostics.at(-1)?.state, 'finish');
      assert.equal(diagnostics.at(-1)?.statusCode, 200);
      assert.ok(!JSON.stringify(diagnostics).includes('private-thread'));
      assert.ok(!JSON.stringify(diagnostics).includes('private-query'));
    } finally {
      release();
      await request;
      await app.close();
    }
  },
);

test('browser records require an authentic browser session and reject content outside the diagnostic vocabulary', async () => {
  const { app, records } = await fixture();
  const payload = {
    v: 1,
    events: [
      { eventId: randomUUID(), at: Date.now(), kind: 'connection_notice', state: 'shown', errorKind: 'timeout' },
    ],
  };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/diagnostics/connection', payload })).statusCode, 401);
    const session = await app.inject('/api/session');
    const headers = {
      cookie: String(session.headers['set-cookie']).split(';')[0] ?? '',
      origin: 'http://localhost:3003',
      'x-csrf-token': session.json().csrfToken,
    };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/diagnostics/connection',
          headers: { ...headers, 'x-csrf-token': 'forged' },
          payload,
        })
      ).statusCode,
      403,
    );
    for (const invalid of [
      { ...payload, content: 'private-message' },
      { ...payload, events: [{ ...payload.events[0], errorMessage: 'private-error' }] },
      { ...payload, events: Array(61).fill(payload.events[0]) },
    ])
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/diagnostics/connection', headers, payload: invalid }))
          .statusCode,
        400,
      );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/diagnostics/connection', headers, payload })).statusCode,
      204,
    );
    const browser = records.filter((r) => r.event === 'connection_diagnostic' && r.source === 'browser');
    assert.equal(browser.length, 1);
    assert.equal(browser[0]?.trustedTiming, false);
    assert.equal(browser[0]?.eventId, payload.events[0]?.eventId);
  } finally {
    await app.close();
  }
});

test('diagnostic ingestion has a bounded log budget and never trusts a malformed request coordinate', async () => {
  const { app, records } = await fixture();
  app.get('/api/messages', async () => ({ messages: [] }));
  try {
    const malformed = await app.inject({
      url: '/api/messages',
      headers: { 'x-clowder-client-request': 'private-invalid-value' },
    });
    assert.equal(malformed.statusCode, 200);
    assert.ok(!records.some((record) => record.clientRequestId === 'private-invalid-value'));
    const session = await app.inject('/api/session');
    const headers = {
      cookie: String(session.headers['set-cookie']).split(';')[0] ?? '',
      origin: 'http://localhost:3003',
      'x-csrf-token': session.json().csrfToken,
    };
    const event = {
      eventId: randomUUID(),
      at: Date.now(),
      kind: 'connection_notice',
      state: 'shown',
      errorKind: 'timeout',
    };
    const payload = { v: 1, events: Array(60).fill(event) };
    for (let index = 0; index < 20; index += 1)
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/diagnostics/connection', headers, payload })).statusCode,
        204,
      );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/diagnostics/connection', headers, payload })).statusCode,
      429,
    );
    assert.equal(
      records.filter((record) => record.event === 'connection_diagnostic' && record.source === 'browser').length,
      1_200,
    );
  } finally {
    await app.close();
  }
});

test(
  'real HTTP disconnect, preflight and authenticated report share the original request coordinate',
  { timeout: 10_000 },
  async () => {
    const clientRequestId = randomUUID();
    let observePending!: () => void;
    let observeClosed!: () => void;
    const waiting = new Promise<void>((resolve) => {
      observePending = resolve;
    });
    const disconnected = new Promise<void>((resolve) => {
      observeClosed = resolve;
    });
    const { app, records } = await fixture((record) => {
      if (record.event !== 'connection_diagnostic' || record.clientRequestId !== clientRequestId) return;
      if (record.state === 'pending') observePending();
      if (record.state === 'aborted') observeClosed();
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.post('/api/messages', async () => {
      entered();
      await gate;
      return { status: 'queued' };
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const browserOrigin = 'http://127.0.0.1:3111';
    try {
      const preflight = await fetch(`${origin}/api/messages`, {
        method: 'OPTIONS',
        headers: {
          origin: browserOrigin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-clowder-client-request,x-csrf-token',
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), browserOrigin);
      assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
      assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /x-clowder-client-request/);
      assert.equal(preflight.headers.get('access-control-max-age'), '600');
      const session = await fetch(`${origin}/api/session`, { headers: { origin: browserOrigin } });
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const sessionCookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
      let client!: ReturnType<typeof httpRequest>;
      const request = new Promise<unknown>((resolve) => {
        client = httpRequest(
          `${origin}/api/messages`,
          {
            method: 'POST',
            headers: {
              cookie: sessionCookie,
              origin: browserOrigin,
              'Content-Type': 'application/json',
              'x-clowder-client-request': clientRequestId,
            },
          },
          (response) => {
            response.resume();
            resolve('unexpected response');
          },
        );
        client.on('error', resolve);
        client.end(JSON.stringify({ content: 'private-fixture-content' }));
      });
      await observedWithin(started, 'handler admission', records);
      await observedWithin(waiting, 'pending diagnostic', records);
      assert.ok(
        records.some(
          (record) =>
            record.event === 'connection_diagnostic' &&
            record.clientRequestId === clientRequestId &&
            record.state === 'pending',
        ),
      );
      client.destroy();
      const outcome = await observedWithin(request, 'client socket closure', records);
      assert.ok(outcome instanceof Error);
      await observedWithin(disconnected, 'disconnect diagnostic', records);
      assert.equal(
        records.filter(
          (record) =>
            record.event === 'connection_diagnostic' &&
            record.clientRequestId === clientRequestId &&
            record.state === 'aborted',
        ).length,
        1,
      );
      const report = await fetch(`${origin}/api/diagnostics/connection`, {
        method: 'POST',
        headers: {
          cookie: sessionCookie,
          origin: browserOrigin,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          v: 1,
          events: [
            {
              eventId: randomUUID(),
              at: Date.now(),
              kind: 'connection_notice',
              state: 'shown',
              errorKind: 'timeout',
              clientRequestId,
            },
          ],
        }),
      });
      assert.equal(report.status, 204);
      assert.ok(records.some((record) => record.source === 'browser' && record.clientRequestId === clientRequestId));
      assert.ok(
        !JSON.stringify(records.filter((record) => record.event === 'connection_diagnostic')).includes(
          'private-fixture-content',
        ),
      );
    } finally {
      release();
      await app.close();
    }
  },
);
