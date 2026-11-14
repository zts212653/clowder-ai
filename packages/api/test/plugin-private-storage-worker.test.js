import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentPluginCallContext, withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { executionFixture } from './helpers/module-execution-fixture.js';

const source = `export default { create() { return { async start(host) {
  return { actions: { async read(input) { return host.storage.scan(input); } }, stop() {} };
} }; } };`;

function storage(scan) {
  return {
    scan,
    async get() {
      return undefined;
    },
    async list() {
      assert.fail('the worker must use the page port');
    },
    async set() {
      assert.fail('a page read must not write state');
    },
    async compareAndSet() {
      assert.fail('unused CAS');
    },
    async delete() {
      assert.fail('unused delete');
    },
  };
}

test('real module-worker pages retain the Host plugin ID and captured native context', async (t) => {
  const calls = [];
  const f = await executionFixture(t, source, {
    storage: storage(async (pluginId, input) => {
      calls.push({ pluginId, input, catId: currentPluginCallContext('instance')?.catId });
      return { cursor: '9', entries: { selected: { revision: 3, value: { version: 'current' } } } };
    }),
  });
  await f.runtime.start('instance', f.record);
  const input = { prefix: 'github.wait.', cursor: '7', count: 2 };
  const result = await withPluginCallContext(
    'instance',
    {
      catId: 'codex61-sol',
      userId: 'owner',
      threadId: 'thread',
      invocationId: 'page-invocation',
      ownerAuthProvenance: 'user_message',
      assertCurrent: async () => {},
    },
    () => f.runtime.invoke('instance', 'read', input),
  );
  assert.deepEqual(result, { cursor: '9', entries: { selected: { revision: 3, value: { version: 'current' } } } });
  assert.deepEqual(calls, [{ pluginId: f.manifest.pluginId, input, catId: 'codex61-sol' }]);
});

test('stopping an activation with a page in flight withholds the late result', async (t) => {
  let entered, release;
  const began = new Promise((resolve) => {
    entered = resolve;
  });
  const result = new Promise((resolve) => {
    release = resolve;
  });
  const f = await executionFixture(t, source, {
    storage: storage(async () => {
      entered();
      return result;
    }),
  });
  await f.runtime.start('instance', f.record);
  const pending = f.runtime.invoke('instance', 'read', { prefix: 'github.wait.' });
  const rejected = assert.rejects(pending);
  await began;
  const stopped = f.runtime.stop('instance', 'owner-disabled');
  release({ cursor: '0', entries: { late: { revision: 4, value: 'withheld' } } });
  await Promise.all([stopped, rejected]);
});
