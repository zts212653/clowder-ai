import assert from 'node:assert/strict';
import { test } from 'node:test';

const CALLBACK_ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_CREDENTIAL_FILE',
];

function captureEnv() {
  return Object.fromEntries(CALLBACK_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(before) {
  for (const key of CALLBACK_ENV_KEYS) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
}

function configureCallbackEnv() {
  process.env.CAT_CAFE_API_URL = 'http://localhost:3003';
  process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
  delete process.env.CAT_CAFE_CREDENTIAL_FILE;
}

function failedRefreshResponse(reason) {
  return {
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: 'callback_auth_failed', reason }),
  };
}

test('typed terminal callback failures stop the refresh tick, including legacy stale ownership', async () => {
  const { performRefreshTick } = await import('../dist/refresh-loop.js');
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const before = captureEnv();
  const terminalReasons = ['completed', 'failed', 'interrupted', 'replaced', 'revoked', 'canceled', 'stale_invocation'];

  configureCallbackEnv();
  console.warn = () => {};
  try {
    for (const reason of terminalReasons) {
      globalThis.fetch = async () => failedRefreshResponse(reason);
      const result = await performRefreshTick();
      assert.equal(result.ok, false, `${reason} is not a successful refresh`);
      assert.equal(result.shouldReschedule, false, `${reason} must terminate this refresh loop`);
      assert.equal(result.nextDelayMs, 0, `${reason} must not produce a follow-up delay`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    restoreEnv(before);
  }
});

test('typed terminal callback failures never write lifecycle text to MCP stdout', async () => {
  const { performRefreshTick } = await import('../dist/refresh-loop.js');
  const originalFetch = globalThis.fetch;
  const originalStdoutWrite = process.stdout.write;
  const before = captureEnv();
  const stdoutWrites = [];

  configureCallbackEnv();
  process.stdout.write = (chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  };
  globalThis.fetch = async () => failedRefreshResponse('completed');
  try {
    const result = await performRefreshTick();
    assert.equal(result.shouldReschedule, false);
    assert.deepEqual(
      stdoutWrites,
      [],
      'terminal refresh lifecycle handling must not corrupt the stdio protocol channel',
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdoutWrite;
    restoreEnv(before);
  }
});

test('non-terminal 401 retains the recoverable refresh decision', async () => {
  const { performRefreshTick } = await import('../dist/refresh-loop.js');
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const before = captureEnv();

  configureCallbackEnv();
  console.warn = () => {};
  globalThis.fetch = async () => failedRefreshResponse('invalid_token');
  try {
    const result = await performRefreshTick();
    assert.equal(result.ok, false);
    assert.equal(result.shouldReschedule, true, 'a non-terminal 401 must retain existing retry behavior');
    assert.ok(result.nextDelayMs > 0);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    restoreEnv(before);
  }
});

test('refresh loop only installs a follow-up timer for recoverable failures', async () => {
  const { startRefreshLoop } = await import('../dist/refresh-loop.js');
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWarn = console.warn;
  const before = captureEnv();
  const scheduled = [];

  configureCallbackEnv();
  console.warn = () => {};
  globalThis.setTimeout = (callback, delay) => {
    const handle = { unref() {} };
    scheduled.push({ callback, delay, handle });
    return handle;
  };
  globalThis.clearTimeout = () => {};

  try {
    globalThis.fetch = async () => failedRefreshResponse('completed');
    const terminalLoop = startRefreshLoop();
    assert.equal(scheduled.length, 1, 'loop starts with one initial timer');
    await scheduled[0].callback();
    assert.equal(scheduled.length, 1, 'completed invocation must not schedule another refresh');
    terminalLoop.stop();

    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'startup recovery' });
    const recoverableLoop = startRefreshLoop();
    assert.equal(scheduled.length, 2, 'a new loop gets its initial timer');
    await scheduled[1].callback();
    assert.equal(scheduled.length, 3, '503 remains recoverable and schedules a follow-up');
    recoverableLoop.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    console.warn = originalWarn;
    restoreEnv(before);
  }
});
