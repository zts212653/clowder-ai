import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { RemoteValues } from '../dist/domains/plugin/execution-worker/remote-values.js';
import { ExternalPluginRuntimeError } from '../dist/domains/plugin/external-runtime/types.js';

function codec(calls = {}) {
  return new RemoteValues({
    call: async () => {
      throw new Error('unused call');
    },
    callSync: () => {
      throw new Error('unused synchronous call');
    },
    abort() {},
    release() {},
    ...calls,
  });
}

test('a Host error returned by the module retains its identity while the Host still owns it', () => {
  const host = codec();
  const worker = codec();
  const original = new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'invalid module');
  const received = worker.decode(host.encode(original, 'call'));
  assert.equal(host.decode(worker.encode(received, 'call')), original);
});

test('returning an error preserves its details after the original error reference has ended', () => {
  const firstHost = codec();
  const worker = codec();
  const original = new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'invalid module');
  const received = worker.decode(firstHost.encode(original, 'call'));
  const returned = worker.encode(received, 'call');
  firstHost.close(); // Drop the origin lookup without depending on nondeterministic GC.
  const recovered = firstHost.decode(returned);
  assert.ok(recovered instanceof ExternalPluginRuntimeError);
  assert.equal(recovered.code, original.code);
  assert.equal(recovered.message, original.message);
});

test('both response codec directions wait for every transferred resource across container variants', async (t) => {
  const host = codec({ call: async (id, args) => worker.invoke(id, args) });
  const worker = codec({ call: async (id, args) => host.invoke(id, args) });
  t.after(() => {
    host.close();
    worker.close();
  });
  const events = () =>
    (async function* () {
      const reply = yield 'event';
      return reply;
    })();
  const origin = Object.assign(new Error('origin'), { events: events() });
  const returned = worker.decode(host.encode(origin, 'origin'));
  let encodedRetired = 0;
  let decodedRetired = 0;
  const encoded = worker.encodeResponse(
    [
      { events: events() },
      Object.assign(new Error('nested'), { events: events() }),
      AbortSignal.abort(events()),
      returned,
      Readable.from(['body']),
    ],
    'response',
    () => encodedRetired++,
  );
  const decoded = host.decodeResponse(encoded.value, () => decodedRetired++);
  const [object, error, signal, original, body] = decoded.value;
  assert.equal(encoded.retained, true);
  assert.equal(decoded.retained, true);
  assert.equal(original, origin);
  assert.equal(host.encode(origin, 'identity-check').kind, 'error');
  const closed = body.closed ? Promise.resolve() : once(body, 'close');
  for await (const chunk of body) assert.equal(chunk, 'body');
  await closed;
  assert.deepEqual([encodedRetired, decodedRetired], [0, 0]);
  assert.deepEqual(await object.events.next(), { done: false, value: 'event' });
  assert.deepEqual(await object.events.next('reply'), { done: true, value: 'reply' });
  await error.events.return();
  await signal.reason.return();
  assert.deepEqual([encodedRetired, decodedRetired], [0, 0]);
  await original.events.return();
  assert.deepEqual([encodedRetired, decodedRetired], [1, 1]);
  await original.events.return();
  assert.deepEqual([encodedRetired, decodedRetired], [1, 1]);
});
