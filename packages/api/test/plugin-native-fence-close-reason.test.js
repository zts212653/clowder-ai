import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureNativeCallbackCurrentness } from '../dist/routes/plugin-native-action-currentness.js';
import { createSharedPluginActionClient } from '../dist/routes/plugin-shared-mcp-client.js';

// F333 Task052: on 2026-11-16 a GitHub registration outlived the Host's 30 s shared MCP budget; the
// plugin's next check then read "Invocation is no longer current" and was diagnosed as an authority
// failure. A fence closed by the deadline or by the caller must say which.

function fence() {
  const record = {
    userId: 'owner',
    threadId: 'thread',
    catId: 'cat',
    invocationId: 'inv',
    originTriggerMessageId: 'origin',
    ownerAuthProvenance: 'strict',
  };
  return captureNativeCallbackCurrentness(
    record,
    'private-token',
    { instanceId: 'plugin', contributionId: 'native', method: 'example.read' },
    {
      registry: { verifyLatest: async () => ({ ok: true, record }) },
      threadStore: { get: async () => ({ id: 'thread', createdBy: 'owner' }) },
    },
  );
}

test('a fence closed by the Host deadline reports the deadline to later checks', async () => {
  const f = fence();
  f.close('deadline');
  f.close();
  await assert.rejects(f.assertCurrent, /exceeded the Host time limit/);
  assert.throws(f.assertWriteCurrent, /exceeded the Host time limit/);
});

test('a fence closed by its caller reports the cancellation', async () => {
  const f = fence();
  f.close('cancelled');
  await assert.rejects(f.assertInvocationCurrent, /cancelled by its caller/);
});

test('an ordinary close still reports that the invocation is no longer current', async () => {
  const f = fence();
  f.close();
  await assert.rejects(f.assertCurrent, /no longer current/);
});

test('a shared action outliving the Host deadline tells the caller and the still-running action', async () => {
  const f = fence();
  let later;
  const client = createSharedPluginActionClient({
    signal: new AbortController().signal,
    record: {},
    token: 'fixture-token',
    fence: f,
    assertCurrent: f.assertCurrent,
    deadlineMs: 30,
    options: {
      sources: {},
      actions: {
        async call(_token, _method, _args, caller) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          later = await caller.assertInvocationCurrent().then(
            () => 'current',
            (error) => error.message,
          );
          return { ok: true };
        },
      },
    },
  });
  await assert.rejects(client.invoke('example.read', {}), (error) => {
    assert.match(error.message, /exceeded the Host time limit/);
    assert.equal(error.effect, 'unknown');
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.match(later, /exceeded the Host time limit/);
});
