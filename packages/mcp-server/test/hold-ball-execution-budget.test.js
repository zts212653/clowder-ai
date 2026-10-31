import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from '../dist/index.js';
import { handleGetHoldStatus, handleHoldBall } from '../dist/tools/callback-tools.js';
import { useInvocationAuth } from './helpers/invocation-auth.js';

const schema = createServer()._registeredTools.cat_cafe_hold_ball.inputSchema;
const request = (wakeWhen) => ({ reason: 'bounded gate', nextStep: 'consume terminal', wakeWhen });

test('hold_ball preserves an explicit execution budget independently of timeout', () => {
  const parsed = schema.parse(request({ command: 'pnpm gate', timeoutMs: 2_000, executionSlaMs: 7_200_000 }));
  assert.equal(parsed.wakeWhen.executionSlaMs, 7_200_000);
  assert.equal(parsed.wakeWhen.timeoutMs, 2_000);
});

test('ordinary managed commands preserve a stable retry key and a bounded status tail', async (t) => {
  useInvocationAuth(t);
  const input = schema.parse(
    request({ command: 'python train.py', executionSlaMs: 7_200_000, idempotencyKey: 'training-1' }),
  );
  assert.equal(input.wakeWhen.idempotencyKey, 'training-1');
  const previous = globalThis.fetch;
  const previousUrl = process.env.CAT_CAFE_API_URL;
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  t.after(() => {
    globalThis.fetch = previous;
    if (previousUrl === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = previousUrl;
  });
  let url;
  globalThis.fetch = async (value) => {
    url = String(value);
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };
  assert.equal((await handleGetHoldStatus({ taskId: 'hold-ball-1', tailBytes: 2048 })).isError, undefined);
  assert.match(url, /\/hold-ball\/hold-ball-1\/status\?tailBytes=2048$/);
  assert.equal((await handleGetHoldStatus({ tailBytes: 2048 })).isError, true);
  const statusSchema = createServer()._registeredTools.cat_cafe_get_hold_status.inputSchema;
  assert.equal(statusSchema.safeParse({ taskId: 'hold-ball-1', tailBytes: 65_537 }).success, false);
});

test('hold_ball keeps execution bounded by three hours and ordinary timeout by one hour', () => {
  for (const executionSlaMs of [1_000, 7_200_000, 10_800_000]) {
    assert.equal(
      schema.parse(request({ command: 'pnpm gate', executionSlaMs })).wakeWhen.executionSlaMs,
      executionSlaMs,
    );
  }
  for (const executionSlaMs of [999, 10_800_001, 1_000.5]) {
    assert.equal(schema.safeParse(request({ command: 'pnpm gate', executionSlaMs })).success, false);
  }
  assert.equal(schema.safeParse(request({ command: 'pnpm gate', timeoutMs: 3_600_001 })).success, false);
});

test('hold_ball forwards the parsed budget to the authenticated callback', async (t) => {
  useInvocationAuth(t);
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.CAT_CAFE_API_URL;
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = previousUrl;
  });
  let delivered;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/callbacks/hold-ball')) delivered = JSON.parse(options.body);
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };
  const parsed = schema.parse(request({ command: 'pnpm gate', executionSlaMs: 7_200_000 }));
  const result = await handleHoldBall(parsed);
  assert.equal(result.isError, undefined);
  assert.equal(delivered.wakeWhen.executionSlaMs, 7_200_000);
});

test('hold_ball preserves tightening-only readonly mode through its registered schema and transport', async (t) => {
  useInvocationAuth(t);
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.CAT_CAFE_API_URL;
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = previousUrl;
  });
  let delivered;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/callbacks/hold-ball')) delivered = JSON.parse(options.body);
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };
  const parsed = schema.parse(
    request({ command: 'python3 -c "print(1)"', executionPolicy: 'read_only', timeoutMs: 5000 }),
  );
  assert.equal(schema.safeParse(request({ command: 'pwd', executionPolicy: 'dangerFullAccess' })).success, false);
  assert.equal((await handleHoldBall(parsed)).isError, undefined);
  assert.deepEqual(delivered.wakeWhen, parsed.wakeWhen);
});
