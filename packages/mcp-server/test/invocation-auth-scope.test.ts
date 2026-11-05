import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCallbackConfig } from '../src/tools/callback-tools.js';
import { resolveInvocationEnv, withInvocationCredentials } from '../src/tools/invocation-auth.js';

/** Set one launcher env value and return an exact restore (unset means delete). */
function withEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

test('without an invocation scope the launcher env is read exactly (stdio child behavior)', () => {
  const restoreSet = withEnv('CAT_CAFE_API_URL', 'http://launch-env:3004');
  const restoreUnset = withEnv('CAT_CAFE_CAT_ID', undefined);
  try {
    assert.equal(resolveInvocationEnv('CAT_CAFE_API_URL'), 'http://launch-env:3004');
    assert.equal(resolveInvocationEnv('CAT_CAFE_CAT_ID'), undefined);
  } finally {
    restoreUnset();
    restoreSet();
  }
});

test('the invocation scope wins over a decoy launcher env for every scoped name', () => {
  const restores = [
    withEnv('CAT_CAFE_API_URL', 'http://env-decoy:3004'),
    withEnv('CAT_CAFE_CAT_ID', 'env-decoy'),
    withEnv('CAT_CAFE_USER_ID', 'env-decoy-user'),
    withEnv('CAT_CAFE_THREAD_ID', 'env-decoy-thread'),
  ];
  try {
    withInvocationCredentials(
      {
        invocationId: 'inv-1',
        callbackToken: 'tok-1',
        apiUrl: 'http://127.0.0.1:59999',
        catId: 'opus',
        userId: 'u-1',
        threadId: 'th-1',
      },
      () => {
        assert.equal(resolveInvocationEnv('CAT_CAFE_API_URL'), 'http://127.0.0.1:59999');
        assert.equal(resolveInvocationEnv('CAT_CAFE_CAT_ID'), 'opus');
        assert.equal(resolveInvocationEnv('CAT_CAFE_USER_ID'), 'u-1');
        assert.equal(resolveInvocationEnv('CAT_CAFE_THREAD_ID'), 'th-1');
      },
    );
  } finally {
    for (const restore of restores) restore();
  }
});

test('an empty or absent scoped value falls back to the launcher env', () => {
  const restoreApi = withEnv('CAT_CAFE_API_URL', 'http://fallback-env:3004');
  const restoreUser = withEnv('CAT_CAFE_USER_ID', 'env-user');
  const restoreThread = withEnv('CAT_CAFE_THREAD_ID', 'env-thread');
  try {
    withInvocationCredentials({ invocationId: 'inv-1', callbackToken: 'tok-1', apiUrl: '', userId: undefined }, () => {
      assert.equal(resolveInvocationEnv('CAT_CAFE_API_URL'), 'http://fallback-env:3004');
      assert.equal(resolveInvocationEnv('CAT_CAFE_USER_ID'), 'env-user');
      assert.equal(resolveInvocationEnv('CAT_CAFE_THREAD_ID'), 'env-thread');
    });
  } finally {
    restoreThread();
    restoreUser();
    restoreApi();
  }
});

test('the invocation scope is invocation-only and never resolves the host agent key', () => {
  const restores = [
    withEnv('CAT_CAFE_API_URL', 'http://host-api:3004'),
    withEnv('CAT_CAFE_AGENT_KEY_SECRET', 'host-agent-key'),
    withEnv('CAT_CAFE_AGENT_KEY_FILE', undefined),
    withEnv('CAT_CAFE_AGENT_KEY_FILES', undefined),
    withEnv('CAT_CAFE_AGENT_KEY_BOUND_CAT_ID', undefined),
  ];
  try {
    withInvocationCredentials(
      {
        invocationId: 'inv-1',
        callbackToken: 'tok-1',
        apiUrl: 'http://127.0.0.1:59999',
        catId: 'opus',
        userId: 'u-1',
        threadId: 'th-1',
      },
      () => {
        assert.deepEqual(getCallbackConfig(), {
          apiUrl: 'http://127.0.0.1:59999',
          invocationId: 'inv-1',
          callbackToken: 'tok-1',
        });
        assert.equal(
          getCallbackConfig({ forceAgentKey: true }),
          null,
          'a member-gateway scope must reject force-agent-key dispatch',
        );
      },
    );
    assert.deepEqual(
      getCallbackConfig({ forceAgentKey: true }),
      { apiUrl: 'http://host-api:3004', agentKeySecret: 'host-agent-key' },
      'the persistent-agent transport keeps its existing agent-key behavior outside the scope',
    );
  } finally {
    for (const restore of restores.reverse()) restore();
  }
});
