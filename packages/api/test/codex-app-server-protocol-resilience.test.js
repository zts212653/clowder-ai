import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CodexAppServerClient } from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class FakeAppServerWire {
  constructor() {
    this.inbox = new AsyncInbox();
    this.writes = [];
  }

  read() {
    return this.inbox;
  }

  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') {
      this.inbox.push({
        id: message.id,
        result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'test', codexHome: '/tmp' },
      });
    } else if (message.method === 'thread/start') {
      this.inbox.push({ id: message.id, result: { thread: { id: 'thread-1', turns: [] } } });
    } else if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
    }
  }

  async close() {
    this.inbox.close();
  }
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function waitFor(predicate) {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}

const apiPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
const eventMapperSource = await readFile(
  new URL('../src/domains/cats/services/agents/providers/CodexAppServerEventMapper.ts', import.meta.url),
  'utf8',
);
const { boundedUnsupportedCodexAppServerNotificationMethod, mapCodexAppServerNotification } = await import(
  '../src/domains/cats/services/agents/providers/CodexAppServerEventMapper.ts'
);

test('ordinary root and API builds never execute an ambient Codex protocol audit', () => {
  assert.doesNotMatch(rootPackage.scripts.build, /codex|protocol[ -]?audit|protocol[ -]?census/i);
  assert.doesNotMatch(apiPackage.scripts.build, /codex|protocol[ -]?audit|protocol[ -]?census/i);
});

test('Codex protocol inspection is an explicit audit command outside ordinary build', () => {
  assert.match(apiPackage.scripts['audit:codex-protocol'] ?? '', /audit-codex-app-server-protocol\.mjs/);
  assert.doesNotMatch(apiPackage.scripts.build, /audit:codex-protocol/);
  assert.match(apiPackage.scripts['verify:codex-build-independence'] ?? '', /verify-codex-build-independence\.mjs/);
});

test('explicit protocol audit reports a live snapshot without a pinned comparison fixture', async () => {
  const { computeProtocolSnapshot } = await import('../scripts/audit-codex-app-server-protocol.mjs');
  const snapshot = computeProtocolSnapshot({
    codexVersion: 'codex-cli 9.8.7',
    stable: {
      clientRequests: ['thread/start'],
      serverNotifications: ['turn/completed'],
      serverRequests: ['item/fileChange/requestApproval'],
    },
    experimental: {
      clientRequests: ['thread/start', 'future/start'],
      serverNotifications: ['turn/completed'],
      serverRequests: ['item/fileChange/requestApproval', 'future/request'],
    },
    threadItemTypes: ['fileChange', 'futureTool'],
  });

  assert.equal(snapshot.codexVersion, '9.8.7');
  assert.deepEqual(snapshot.stable.counts, {
    clientRequests: 1,
    serverNotifications: 1,
    serverRequests: 1,
  });
  assert.deepEqual(snapshot.experimental.methodDelta, {
    clientRequests: ['future/start'],
    serverNotifications: [],
    serverRequests: ['future/request'],
  });
  assert.deepEqual(snapshot.threadItemTypes, ['fileChange', 'futureTool']);
});

test('the permanent full-protocol fixture and build-blocking census script are removed', async () => {
  await assert.rejects(
    access(new URL('./fixtures/codex-app-server-thread-item-types.json', import.meta.url)),
    /ENOENT/,
  );
  await assert.rejects(
    access(new URL('../scripts/check-codex-app-server-protocol-census.mjs', import.meta.url)),
    /ENOENT/,
  );
});

test('the unsupported-notification filter derives mapped methods instead of mirroring them by hand', () => {
  assert.doesNotMatch(eventMapperSource, /CONSUMED_NOTIFICATION_METHODS/);
  assert.match(eventMapperSource, /Object\.hasOwn\(CODEX_APP_SERVER_NOTIFICATION_MAPPERS, method\)/);

  for (const method of [
    'item/started',
    'item/completed',
    'turn/started',
    'turn/plan/updated',
    'turn/completed',
    'error',
    'thread/tokenUsage/updated',
  ]) {
    assert.equal(boundedUnsupportedCodexAppServerNotificationMethod({ method }), null, method);
  }
  assert.equal(boundedUnsupportedCodexAppServerNotificationMethod({ method: 'turn/interrupted' }), 'turn/interrupted');

  for (const method of ['valueOf', 'hasOwnProperty', 'toString', 'constructor', '__proto__']) {
    assert.equal(mapCodexAppServerNotification({ method, params: {} }), null, method);
    assert.equal(boundedUnsupportedCodexAppServerNotificationMethod({ method }), method, method);
  }
});

test('unknown notifications are bounded and callback failures do not abort the turn', async () => {
  const wire = new FakeAppServerWire();
  const observed = [];
  const client = new CodexAppServerClient({
    wire,
    onUnsupportedNotification: async (observation) => {
      observed.push(observation);
      if (observed.length === 1) throw new Error('telemetry unavailable');
    },
  });
  const run = collect(
    client.run({
      prompt: { kind: 'frozen', prompt: 'ignore future notifications safely' },
      thread: { kind: 'start' },
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  for (let index = 0; index < 10; index++) {
    wire.inbox.push({
      method: `future/notification/${index}/${'x'.repeat(80)}`,
      params: { secret: `must-not-be-observed-${index}` },
    });
  }
  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
  });
  await run;

  assert.equal(observed.length, 8);
  assert.ok(observed.every((entry) => entry.method.length <= 64));
  assert.doesNotMatch(JSON.stringify(observed), /must-not-be-observed/);
});

test('unknown server requests remain explicit fail-closed rejections', async () => {
  const wire = new FakeAppServerWire();
  const client = new CodexAppServerClient({ wire });
  const run = collect(
    client.run({
      prompt: { kind: 'frozen', prompt: 'reject unsupported requests' },
      thread: { kind: 'start' },
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  wire.inbox.push({ id: 231, method: 'future/safety/requestApproval', params: {} });
  await waitFor(() => wire.writes.some((message) => message.id === 231));
  assert.deepEqual(wire.writes.find((message) => message.id === 231).error, {
    code: -32601,
    message: 'Unsupported app-server request: future/safety/requestApproval',
  });

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
  });
  await run;
});
