import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executePublicInvocation } from '../dist/domains/cats/services/agents/invocation/public-invocation-execution.js';

function fixture() {
  const seen = [];
  let disposed = 0;
  let exposed = 0;
  const prepared = {
    source: { messageId: 'source-1', content: 'verified public source' },
    launch: {
      server: {
        name: 'native',
        command: '/fake/native',
        args: [],
        env: {},
        workingDirectory: '/fake/package',
        transport: 'stdio',
      },
      sandbox: { kind: 'public', workspaceRoot: '/fake/public' },
      assertCurrent: async () => {},
    },
    dispose: async () => {
      disposed++;
    },
  };
  const input = {
    port: { prepare: async () => prepared },
    invocationId: 'child-1',
    catId: 'codex',
    sourceMessageId: 'source-1',
    prompt: 'verified public source',
    service: {
      async *invoke(prompt) {
        seen.push(prompt);
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    },
    policy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'native',
      actionMethods: ['native.read'],
    },
    signal: new AbortController().signal,
    callbackEnv: { CAT_CAFE_INVOCATION_ID: 'child-1', CAT_CAFE_CALLBACK_TOKEN: 'fake-test-token' },
    expose: async () => {
      exposed++;
    },
    close: async (iterator) => {
      await iterator.return?.();
      return true;
    },
  };
  return { input, prepared, seen, disposed: () => disposed, exposed: () => exposed };
}
async function run(f) {
  for await (const _message of executePublicInvocation(f.input)) {
    /* exhaust the single attempt */
  }
}

test('public source fixture executes one valid prepared lease and disposes it', async () => {
  const f = fixture();
  await run(f);
  assert.deepEqual(f.seen, ['verified public source']);
  assert.equal(f.exposed(), 1);
  assert.equal(f.disposed(), 1);
});

test('public source excludes polluted generic prompt despite valid binding and exposure', async () => {
  const f = fixture();
  f.input.prompt = 'OWNER PRIVATE HISTORY AND SYSTEM INSTRUCTIONS';
  await run(f);
  assert.deepEqual(f.seen, ['verified public source'], 'generic invocation prompt must not reach public provider');
  assert.equal(f.exposed(), 1);
  assert.equal(f.disposed(), 1);
});

test('public source rejects a prepared envelope for another source before exposure', async () => {
  const f = fixture();
  f.prepared.source.messageId = 'foreign-source';
  await assert.rejects(() => run(f), /public.*source/i);
  assert.deepEqual(f.seen, []);
  assert.equal(f.exposed(), 0);
  assert.equal(f.disposed(), 1);
});

test('public source never falls back to generic prompt when prepared source is absent', async () => {
  const f = fixture();
  delete f.prepared.source;
  await assert.rejects(() => run(f), /public.*source/i);
  assert.deepEqual(f.seen, []);
  assert.equal(f.exposed(), 0);
  assert.equal(f.disposed(), 1);
});

test('public source content is snapshotted before awaiting the currentness fence', async () => {
  const f = fixture();
  f.prepared.launch.assertCurrent = async () => {
    f.prepared.source.content = 'injected later';
  };
  await run(f);
  assert.deepEqual(f.seen, ['verified public source']);
  assert.equal(f.disposed(), 1);
});

test('public source rejects accessor content without evaluating its getter', async () => {
  const f = fixture();
  let reads = 0;
  Object.defineProperty(f.prepared.source, 'content', {
    enumerable: true,
    get() {
      reads++;
      return 'private';
    },
  });
  await assert.rejects(() => run(f), /public.*source/i);
  assert.equal(reads, 0);
  assert.equal(f.exposed(), 0);
  assert.equal(f.disposed(), 1);
});

test('public source rejects additional private fields in the prepared envelope', async () => {
  const f = fixture();
  f.prepared.source.privateHistory = 'owner history';
  await assert.rejects(() => run(f), /public.*source/i);
  assert.equal(f.exposed(), 0);
  assert.equal(f.disposed(), 1);
});
