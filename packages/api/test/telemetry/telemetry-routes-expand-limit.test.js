/**
 * F192 verdict 2026-06-17-eval-a2a-c1-sample-window-build — expandLimit
 * opt-in tests, split into a sibling file at R1 P1.2 (砚砚): the parent
 * `telemetry-routes.test.js` was already 418 lines at the merge base
 * (over the 350 hard cap), and adding the 5 expandLimit cases inline
 * pushed it to 502. Sibling-split preserves the F192 coverage without
 * worsening the cap violation.
 *
 * The default 500 cap protects the dashboard from runaway queries.
 * Scheduled eval (run-f167-eval.mjs) sometimes needs the full window to
 * compute `sampleCoverage.complete=true` for per-fire sample evidence.
 * The `?expandLimit=true` toggle raises the cap to
 * `traceStore.stats().maxSpans` (default 10k) — still bounded, still
 * session-gated, same redacted DTO shape.
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';

const { LocalTraceStore } = await import('../../dist/infrastructure/telemetry/local-trace-store.js');
const { telemetryRoutes } = await import('../../dist/routes/telemetry.js');
const { sessionAuthPlugin, sessionRoute } = await import('../../dist/infrastructure/session-auth.js');

/** Build a test Fastify app with telemetry routes registered. */
async function buildApp(opts = {}) {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  await app.register(telemetryRoutes, {
    traceStore: opts.traceStore ?? new LocalTraceStore({ maxSpans: 100 }),
    getMetricsText: opts.getMetricsText ?? undefined,
    ...opts,
  });
  return app;
}

/** Get a session cookie from the test app. */
async function getSessionCookie(app) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/session',
    headers: { 'x-cat-cafe-user': 'test-user' },
  });
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  const match = String(setCookie).match(/cat_cafe_session=([^;]+)/);
  return match ? `cat_cafe_session=${match[1]}` : '';
}

/** Make a DTO for test fixtures. */
function makeDTO(overrides = {}) {
  return {
    traceId: 'trace-aaa',
    spanId: 'span-bbb',
    name: 'test.span',
    kind: 0,
    startTimeMs: Date.now() - 100,
    endTimeMs: Date.now(),
    durationMs: 100,
    status: { code: 0 },
    attributes: {},
    events: [],
    storedAt: Date.now(),
    ...overrides,
  };
}

test('expandLimit=true raises cap to traceStore.stats().maxSpans (700 > default 500)', async () => {
  const store = new LocalTraceStore({ maxSpans: 1000 });
  for (let i = 0; i < 700; i++) store.add(makeDTO({ spanId: `s-${i}` }));
  const app = await buildApp({ traceStore: store });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/traces?limit=999&expandLimit=true',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.count, 700, 'expandLimit should bypass the 500 floor');
  app.close();
});

test('expandLimit=true still bounded by maxSpans (no unbounded queries)', async () => {
  const store = new LocalTraceStore({ maxSpans: 600 });
  for (let i = 0; i < 600; i++) store.add(makeDTO({ spanId: `s-${i}` }));
  const app = await buildApp({ traceStore: store });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/traces?limit=99999&expandLimit=true',
    headers: { cookie },
  });
  const body = JSON.parse(res.body);
  assert.equal(body.count, 600, 'cap should equal maxSpans, not the requested 99999');
  app.close();
});

test('expandLimit absent: 500 cap preserved (default behavior unchanged)', async () => {
  const store = new LocalTraceStore({ maxSpans: 1000 });
  for (let i = 0; i < 700; i++) store.add(makeDTO({ spanId: `s-${i}` }));
  const app = await buildApp({ traceStore: store });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/traces?limit=9999', // no expandLimit
    headers: { cookie },
  });
  const body = JSON.parse(res.body);
  assert.equal(body.count, 500, 'omitting expandLimit must keep the 500 cap');
  app.close();
});

test('expandLimit=true still requires session auth (401 without cookie)', async () => {
  const app = await buildApp({ traceStore: new LocalTraceStore({ maxSpans: 100 }) });
  const res = await app.inject({ method: 'GET', url: '/api/telemetry/traces?expandLimit=true' });
  assert.equal(res.statusCode, 401, 'expandLimit must not bypass auth gate');
  app.close();
});

test('expandLimit=true only accepted as exact string "true" (no truthy coercion)', async () => {
  const store = new LocalTraceStore({ maxSpans: 1000 });
  for (let i = 0; i < 700; i++) store.add(makeDTO({ spanId: `s-${i}` }));
  const app = await buildApp({ traceStore: store });
  const cookie = await getSessionCookie(app);

  // 'yes' / '1' / 'TRUE' should not enable expansion — strict 'true' only
  // (prevents accidental enablement via misconfigured client params).
  for (const v of ['yes', '1', 'TRUE', 'on']) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/telemetry/traces?limit=9999&expandLimit=${v}`,
      headers: { cookie },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.count, 500, `expandLimit=${v} should NOT enable expansion (only literal "true")`);
  }
  app.close();
});
