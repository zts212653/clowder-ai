import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { currentPluginCallContext, withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import {
  currentOwnerOperation,
  withOwnerOperationInvocation,
} from '../dist/domains/plugin/carrier/plugin-owner-operation-context.js';
import { executionFixture } from './helpers/module-execution-fixture.js';

test('worker-supplied caller edits cannot replace the Host native invocation context', async (t) => {
  const f = await executionFixture(
    t,
    `export default { create() { return { async start(host) {
    return { actions: { async inspect(_params, caller) { caller.catId='spoof'; return host.config.get('LABEL'); } }, stop() {} };
  } }; } };`,
    {
      configuration: [{ key: 'LABEL', label: 'Label', kind: 'string', required: false }],
      readConfig: async () => currentPluginCallContext('instance')?.catId ?? 'background',
    },
  );
  await f.runtime.start('instance', f.record);
  const result = await withPluginCallContext(
    'instance',
    {
      catId: 'codex61-sol',
      userId: 'owner',
      threadId: 'thread-fixture',
      invocationId: 'invocation-fixture',
      ownerAuthProvenance: 'user_message',
      assertCurrent: async () => {},
    },
    () => f.runtime.invoke('instance', 'inspect', {}),
  );
  assert.equal(result, 'codex61-sol');
});

test('a synchronous owner write assertion is checked by Host before plugin continuation', async (t) => {
  let revoked = false;
  const f = await executionFixture(
    t,
    `export default { create() { return { async start(host) {
    return { actions: { async write(_params, _caller, owner) {
      await host.config.get('REVOKE'); owner.assertWriteCurrent(); await host.storage.set('unsafe', true);
    } }, stop() {} };
  } }; } };`,
    {
      configuration: [{ key: 'REVOKE', label: 'Revoke', kind: 'string', required: false }],
      readConfig: async () => {
        if (currentOwnerOperation('instance')) revoked = true;
        return 'value';
      },
    },
  );
  await f.runtime.start('instance', f.record);
  const cancellation = new AbortController();
  await assert.rejects(
    withOwnerOperationInvocation(
      {
        pluginId: f.manifest.pluginId,
        userId: 'owner',
        requestId: 'request',
        operationKey: 'test',
        actionId: 'write',
        signal: cancellation.signal,
        assertCurrent() {
          if (revoked) throw new Error('owner-revoked');
        },
      },
      'instance',
      'write',
      async () => {},
      () => f.runtime.invoke('instance', 'write', {}),
    ),
    /owner-revoked/,
  );
  assert.deepEqual(f.writes, []);
});

test('pull streams preserve cancellation and execute their finally block', async (t) => {
  const f = await executionFixture(
    t,
    `export default { create() { return { async start(host) {
    return { actions: {}, streams: { async *read(_reference, { signal }) {
      try { yield new Uint8Array([1]); await new Promise(resolve => {
        signal.addEventListener('abort', resolve, {once:true}); if(signal.aborted)resolve();
      }); signal.throwIfAborted(); yield new Uint8Array([2]); }
      finally { host.log('info', 'stream-finalized'); }
    } }, stop() {} };
  } }; } };`,
  );
  await f.runtime.start('instance', f.record);
  const cancellation = new AbortController();
  const stream = f.runtime.readStream('instance', 'reference', { signal: cancellation.signal })[Symbol.asyncIterator]();
  assert.deepEqual((await stream.next()).value, new Uint8Array([1]));
  const waiting = stream.next();
  cancellation.abort();
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
  assert.ok(f.events.some((row) => row.message === 'stream-finalized'));
});

test('an explicitly retried failed stop retains its execution closure and does not repeat completed steps', async (t) => {
  const f = await executionFixture(
    t,
    `export default { create() { let attempt=0; return { async start(host) {
    return { actions: {}, stop() { host.log('info','stop',{attempt:++attempt}); if(attempt===1)throw Error('retry-stop'); } };
  } }; } };`,
  );
  await f.runtime.start('instance', f.record);
  await assert.rejects(f.runtime.stop('instance', 'first'), /module stop failed/);
  await f.runtime.stop('instance', 'second');
  assert.deepEqual(
    f.events.filter((row) => row.message === 'stop').map((row) => row.fields.attempt),
    [1, 2],
  );
});

const crashModule = `import { threadId } from 'node:worker_threads';
export default { create() { return { async start() {
  return { actions: { inspect: () => threadId, crash: () => process.exit(17) }, stop() {} };
} }; } };`;

test('execution worker exit closes the old carrier, publishes crashed, and allows explicit fresh start', async (t) => {
  const f = await executionFixture(t, crashModule);
  const first = await f.carrier.start('instance');
  let closed = false;
  void first.closed.then(() => {
    closed = true;
  });
  const firstThread = await f.runtime.invoke('instance', 'inspect', {});
  await assert.rejects(f.runtime.invoke('instance', 'crash', {}), /Execution worker exited/);
  await setImmediate();
  assert.equal((await f.inventory.snapshot()).instances[0].runtimeState, 'crashed');
  assert.equal(closed, true);
  assert.equal(f.runtime.exposesAction('instance', 'inspect'), false);
  await f.carrier.start('instance');
  assert.notEqual(await f.runtime.invoke('instance', 'inspect', {}), firstThread);
});

test('an explicit owner stop after worker exit wins over the old crash projection', async (t) => {
  const f = await executionFixture(t, crashModule);
  await f.carrier.start('instance');
  await assert.rejects(f.runtime.invoke('instance', 'crash', {}));
  await f.carrier.stop('instance', 'owner-disabled');
  await setImmediate();
  assert.equal((await f.inventory.snapshot()).instances[0].runtimeState, 'stopped');
});

test('busy business requests cannot consume the path needed to stop their owner', async (t) => {
  let holding = false;
  let enteredCount = 0;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await executionFixture(
    t,
    `export default { create() { return { async start(host) {
    return { actions: { wait: () => host.config.get('WAIT') },
      async preStop() { await host.storage.set('stopped', true); }, stop() {} };
  } }; } };`,
    {
      configuration: [{ key: 'WAIT', label: 'Wait', kind: 'string', required: false }],
      readConfig: async () => {
        if (holding) {
          if (++enteredCount === 64) entered.resolve();
          await release.promise;
        }
        return 'value';
      },
    },
  );
  await f.runtime.start('instance', f.record);
  holding = true;
  const pending = Promise.allSettled(Array.from({ length: 65 }, () => f.runtime.invoke('instance', 'wait', {})));
  await entered.promise;
  try {
    await f.runtime.stop('instance', 'owner-stop-while-busy');
  } finally {
    holding = false;
    release.resolve();
    await pending;
  }
  assert.ok((await pending).every((result) => result.status === 'rejected'));
  assert.equal(f.writes.filter((row) => row.key === 'stopped').length, 1);
});

test('a saved owner capability cannot be reused by a later module action', async (t) => {
  const f = await executionFixture(
    t,
    `export default { create() { let saved; return { async start(host) {
    return { actions: { prepare(_params, _caller, owner) { saved=owner; return {}; },
      async commit() { saved.assertWriteCurrent(); await host.storage.set('late', true); }
    }, stop() {} };
  } }; } };`,
  );
  await f.runtime.start('instance', f.record);
  await withOwnerOperationInvocation(
    {
      pluginId: f.manifest.pluginId,
      userId: 'owner',
      requestId: 'saved',
      operationKey: 'test',
      actionId: 'prepare',
      signal: new AbortController().signal,
      assertCurrent() {},
    },
    'instance',
    'prepare',
    async () => {},
    () => f.runtime.invoke('instance', 'prepare', {}),
  );
  await assert.rejects(f.runtime.invoke('instance', 'commit', {}), /no longer current|authority has ended|expired/);
  assert.deepEqual(f.writes, []);
});

test('refresh calls coalesce while retaining the newest configuration', async (t) => {
  let refresh = false;
  let version = 'v1';
  let waits = 0;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await executionFixture(
    t,
    `export default { create() { let version; return { async start(host) {
    return { actions: { read: () => version }, async configRefresh() {
      const next=await host.config.get('LABEL'); host.log('info','refresh',{version:next});
      await host.config.get('BARRIER'); version=next;
    }, stop() {} };
  } }; } };`,
    {
      configuration: [
        { key: 'LABEL', label: 'Label', kind: 'string', required: false },
        { key: 'BARRIER', label: 'Barrier', kind: 'string', required: false },
      ],
      readConfig: async (_instance, key) => {
        if (key === 'LABEL') return version;
        if (refresh && ++waits === 1) {
          entered.resolve();
          await release.promise;
        }
        return 'value';
      },
    },
  );
  await f.runtime.start('instance', f.record);
  refresh = true;
  const first = f.runtime.configRefresh('instance');
  await entered.promise;
  version = 'v2';
  const later = [f.runtime.configRefresh('instance'), f.runtime.configRefresh('instance')];
  assert.equal(f.events.filter((row) => row.message === 'refresh').length, 1);
  release.resolve();
  await Promise.all([first, ...later]);
  assert.equal(await f.runtime.invoke('instance', 'read', {}), 'v2');
  assert.deepEqual(
    f.events.filter((row) => row.message === 'refresh').map((row) => row.fields.version),
    ['v1', 'v2'],
  );
});
