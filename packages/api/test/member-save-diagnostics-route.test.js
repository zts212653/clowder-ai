import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { registerMemberSaveDiagnostics } from '../dist/routes/member-save-diagnostics.js';
import { saveSpan } from '../dist/utils/member-save-diagnostics.js';

async function fixture() {
  const records = [];
  const app = Fastify({
    logger: {
      level: 'info',
      stream: {
        write(line) {
          records.push(JSON.parse(line));
        },
      },
    },
  });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  registerMemberSaveDiagnostics(app, 'test-revision', 10);
  return { app, records };
}

test('real request hooks preserve context, diagnose a blocked stage before completion, and finish with HTTP status', async () => {
  const { app, records } = await fixture();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  app.patch('/api/cats/:id', async () => saveSpan('pool.codex.close', () => gate));
  const traceId = randomUUID(),
    clientRequestId = randomUUID();
  try {
    const request = app.inject({
      method: 'PATCH',
      url: '/api/cats/test',
      headers: {
        'x-clowder-save-id': traceId,
        'x-clowder-save-request': clientRequestId,
      },
      payload: { password: 'must-not-log' },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const slow = records.find((r) => r.event === 'member_save' && r.state === 'slow');
    assert.equal(slow?.traceId, traceId);
    assert.ok(slow.active.some((s) => s.phase === 'pool.codex.close'));
    release({ ok: true });
    const response = await request;
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-clowder-save-id'], traceId);
    const events = records.filter((r) => r.event === 'member_save');
    assert.ok(
      events.every(
        (r) => r.traceId === traceId && r.clientRequestId === clientRequestId && r.revision === 'test-revision',
      ),
    );
    const stage = events.find((r) => r.phase === 'pool.codex.close' && r.state === 'finish');
    assert.ok(stage.durationMs >= 10);
    assert.equal(events.at(-1).statusCode, 200);
    assert.ok(!JSON.stringify(events).includes('must-not-log'));
  } finally {
    release({});
    await app.close();
  }
});

test('browser timing requires session auth and rejects arbitrary content, oversized and invalid values', async () => {
  const { app, records } = await fixture();
  const payload = { traceId: randomUUID(), events: [{ seq: 0, phase: 'save', state: 'start', elapsedMs: 0 }] };
  try {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/member-save',
      headers: { 'x-cat-cafe-user': 'forged', origin: 'http://localhost:3003' },
      payload,
    });
    assert.equal(denied.statusCode, 401);
    const session = await app.inject('/api/session');
    const headers = { cookie: session.headers['set-cookie'].split(';')[0] };
    for (const invalid of [
      { ...payload, apiKey: 'secret' },
      { ...payload, events: [{ ...payload.events[0], elapsedMs: -1 }] },
      { ...payload, events: [{ ...payload.events[0], phase: 'token=secret' }] },
      { ...payload, events: Array(121).fill(payload.events[0]) },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/diagnostics/member-save',
        headers,
        payload: invalid,
      });
      assert.equal(response.statusCode, 400);
    }
    const accepted = await app.inject({ method: 'POST', url: '/api/diagnostics/member-save', headers, payload });
    assert.equal(accepted.statusCode, 204);
    const event = records.find((r) => r.event === 'member_save' && r.source === 'browser');
    assert.equal(event.traceId, payload.traceId);
    assert.equal(event.trustedTiming, false);
    const entry = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/member-save',
      headers,
      payload: { ...payload, events: [{ ...payload.events[0], phase: 'onboarding.entry' }] },
    });
    assert.equal(entry.statusCode, 204);
    assert.ok(records.some((r) => r.event === 'member_save' && r.phase === 'onboarding.entry'));
    assert.ok(!JSON.stringify(records.filter((r) => r.event === 'member_save')).includes('secret'));
  } finally {
    await app.close();
  }
});

test('invalid correlation headers are replaced and failed requests still have a terminal diagnostic', async () => {
  const { app, records } = await fixture();
  app.patch('/api/cats/:id', async (_request, reply) => reply.code(409).send({ error: 'conflict' }));
  try {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/cats/test',
      headers: { 'x-clowder-save-id': 'api-key-secret' },
    });
    assert.match(response.headers['x-clowder-save-id'], /^[a-f\d-]{36}$/i);
    const events = records.filter((r) => r.event === 'member_save');
    assert.equal(events.at(-1).state, 'failed');
    assert.equal(events.at(-1).statusCode, 409);
    assert.ok(!JSON.stringify(events).includes('api-key-secret'));
  } finally {
    await app.close();
  }
});
