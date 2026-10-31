import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runWithNativeTurnAuth } from '../src/native-turn-auth.js';
import { resolveInvocationCredentials } from '../src/tools/invocation-auth.js';

test('native tool admission uses the exact runtime turn, never latest/global credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'f317-auth-'));
  const file = join(dir, 'projection.json');
  const fixture = {
    v: 1,
    connectionId: 'connection',
    nativeThreadId: 'native-thread',
    turns: [
      { nativeTurnId: 'first', invocationId: 'first-invocation', callbackToken: 'first-token' },
      { nativeTurnId: 'second', invocationId: 'second-invocation', callbackToken: 'second-token' },
    ],
  };
  const env = { CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE: file, CAT_CAFE_NATIVE_CONNECTION_ID: 'connection' };
  const metadata = (turn: string) => ({
    threadId: 'native-thread',
    'x-codex-turn-metadata': { thread_id: 'native-thread', turn_id: turn },
  });
  let called = 0;
  const verified: string[] = [];
  const verify = async (credentials: { invocationId: string }) => {
    verified.push(credentials.invocationId);
  };
  const handler = async () => {
    called++;
    await new Promise((done) => setImmediate(done));
    return resolveInvocationCredentials();
  };
  const signal = AbortSignal.timeout(5000);
  try {
    await writeFile(file, JSON.stringify(fixture), { mode: 0o600 });
    const results = await Promise.all(
      ['first', 'second'].map((turn) => runWithNativeTurnAuth(metadata(turn), signal, handler, { env, verify })),
    );
    assert.deepEqual(
      results.map((r) => r.invocationId),
      ['first-invocation', 'second-invocation'],
    );
    assert.deepEqual(verified, ['first-invocation', 'second-invocation']);
    for (const invalid of [undefined, {}, metadata('unknown'), { ...metadata('first'), threadId: 'wrong' }]) {
      await assert.rejects(runWithNativeTurnAuth(invalid, signal, handler, { env, verify }), /native.*admission/i);
    }
    assert.equal(called, 2);
    await writeFile(file, JSON.stringify({ ...fixture, connectionId: 'replacement' }));
    await assert.rejects(
      runWithNativeTurnAuth(metadata('first'), signal, handler, { env, verify }),
      /native.*admission/i,
    );
    await writeFile(file, JSON.stringify(fixture));
    await assert.rejects(
      runWithNativeTurnAuth(metadata('first'), signal, handler, {
        env,
        verify: async () => {
          throw new Error('canonical terminal');
        },
      }),
      /canonical terminal/,
    );
    await assert.rejects(
      runWithNativeTurnAuth(metadata('first'), signal, handler, {
        env,
        verify: async () => {
          await writeFile(file, JSON.stringify({ ...fixture, turns: [] }));
        },
      }),
      /native.*admission/i,
    );
    assert.equal(called, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ordinary MCP calls retain their existing credential resolution', async () => {
  const before = resolveInvocationCredentials();
  const after = await runWithNativeTurnAuth(
    undefined,
    new AbortController().signal,
    async () => resolveInvocationCredentials(),
    {
      env: {},
      verify: async () => {
        throw new Error('must not run');
      },
    },
  );
  assert.deepEqual(after, before);
});
