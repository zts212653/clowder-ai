import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteValues } from '../dist/domains/plugin/execution-worker/remote-values.js';
import { ExternalPluginRuntimeError } from '../dist/domains/plugin/external-runtime/types.js';

function codec() {
  return new RemoteValues({
    call: async () => {
      throw new Error('unused call');
    },
    callSync: () => {
      throw new Error('unused synchronous call');
    },
    abort() {},
    release() {},
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
