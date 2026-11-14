import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import {
  currentPluginCallContext,
  currentPluginOwnerRequestContext,
  withPluginCallContext,
} from '../dist/domains/plugin/carrier/plugin-call-context.js';
import {
  currentOwnerOperation,
  currentOwnerOperationRequest,
  withOwnerOperationInvocation,
} from '../dist/domains/plugin/carrier/plugin-owner-operation-context.js';
import { ExecutionRpcPeer } from '../dist/domains/plugin/execution-worker/rpc-peer.js';
import { executionFixture } from './helpers/module-execution-fixture.js';

const backgroundModule = `export default { create() { return { async start(host) {
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  return { actions: {
    begin(_params, _caller, owner) {
      setTimeout(async () => {
        try {
          await host.config.get('BARRIER');
          const value = await host.config.get('LABEL');
          let savedOwner = 'absent';
          if (owner) {
            try { owner.assertWriteCurrent(); savedOwner = 'accepted'; }
            catch { savedOwner = 'rejected'; }
          }
          complete({ value, savedOwner });
        } catch (error) { complete({ error: error.message }); }
      }, 0);
      return 'started';
    },
    result() { return done; }
  }, stop() {} };
} }; } };`;

async function backgroundFixture(t) {
  const barrier = Promise.withResolvers();
  let active = false;
  const f = await executionFixture(t, backgroundModule, {
    configuration: [
      { key: 'BARRIER', label: 'Barrier', kind: 'string', required: false },
      { key: 'LABEL', label: 'Label', kind: 'string', required: false },
    ],
    readConfig: async (_instanceId, key) => {
      // Startup reads every configuration field before creating the activation.
      if (key === 'BARRIER' && active) return barrier.promise;
      if (currentOwnerOperation('instance') || currentOwnerOperationRequest()) return 'stale-owner';
      if (currentPluginCallContext('instance') || currentPluginOwnerRequestContext('instance')) return 'stale-native';
      return 'background';
    },
  });
  t.after(() => barrier.resolve('released'));
  await f.runtime.start('instance', f.record);
  active = true;
  return { ...f, release: () => barrier.resolve('released') };
}

test('activation background reads outlive an owner action without retaining its owner capability', async (t) => {
  const f = await backgroundFixture(t);
  const result = await withOwnerOperationInvocation(
    {
      pluginId: f.manifest.pluginId,
      userId: 'owner',
      requestId: 'start-background-once',
      operationKey: 'test',
      actionId: 'begin',
      signal: new AbortController().signal,
      assertCurrent() {},
    },
    'instance',
    'begin',
    async () => {},
    () => f.runtime.invoke('instance', 'begin', {}),
  );
  assert.equal(result, 'started');
  // The ordinary Host read can only complete after the owner action has ended.
  f.release();
  assert.deepEqual(await f.runtime.invoke('instance', 'result', {}), {
    value: 'background',
    savedOwner: 'rejected',
  });
  assert.deepEqual(f.writes, []);
});

test('activation background reads do not restore the native caller of a finished action', async (t) => {
  const f = await backgroundFixture(t);
  assert.equal(
    await withPluginCallContext(
      'instance',
      {
        catId: 'codex61-sol',
        userId: 'owner',
        threadId: 'thread-fixture',
        invocationId: 'finished-invocation',
        ownerAuthProvenance: 'user_message',
        assertCurrent: async () => {},
      },
      () => f.runtime.invoke('instance', 'begin', {}),
    ),
    'started',
  );
  f.release();
  assert.deepEqual(await f.runtime.invoke('instance', 'result', {}), {
    value: 'background',
    savedOwner: 'absent',
  });
});

test('Host still rejects a supplied expired authority id instead of running its target in base context', async (t) => {
  const { port1, port2 } = new MessageChannel();
  const peer = new ExecutionRpcPeer(port1);
  t.after(() => {
    peer.close();
    port2.close();
  });
  let calls = 0;
  peer.expose('must-not-run', () => ++calls);
  const result = once(port2, 'message');
  port2.postMessage({
    kind: 'call',
    id: 'late-call',
    target: 'must-not-run',
    args: { kind: 'array', items: [] },
    context: { rootId: 'finished-root', authorityId: 'expired-authority' },
  });
  const [reply] = await result;
  assert.equal(reply.returned, false);
  assert.match(reply.value.message, /Calling authority has ended/);
  assert.equal(calls, 0);
});
