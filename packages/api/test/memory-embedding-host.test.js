import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { createMemoryEmbeddingHost } from '../dist/domains/plugin/host-surface/memory-embedding-host.js';

const instance = 'approved-memory-instance';
const principal = {
  catId: 'user',
  userId: 'owner',
  threadId: 'thread',
  invocationId: 'invocation',
  assertCurrent: async () => {},
};
const model = { modelId: 'fixture-model', modelRev: '1', dim: 2, generationId: 'g1', queryInstruction: 'Prefix: ' };
const service = (embed) => ({
  isReady: () => true,
  reprobeIfNeeded: async () => {},
  getModelInfo: () => model,
  embed,
});

test('the embedding port accepts only the query bound to the verified ready memory invocation', async () => {
  const calls = [];
  const provider = service(async (inputs) => {
    calls.push(inputs);
    return [new Float32Array([0.25, 0.75])];
  });
  const port = createMemoryEmbeddingHost({
    pluginInstanceId: instance,
    assertActivation() {},
    getEmbedding: () => provider,
  });
  const call = (query, context = principal, plugin = instance) =>
    withPluginCallContext(plugin, context, () => port.embedQuery(query));
  const allowed = { ...principal, memorySearch: { query: 'canonical query' } };
  await assert.rejects(port.embedQuery('canonical query'), /memory_embedding_access_denied/);
  await assert.rejects(call('canonical query'), /memory_embedding_access_denied/);
  await assert.rejects(call('another query', allowed), /memory_embedding_access_denied/);
  await assert.rejects(call('canonical query', allowed, 'another-instance'), /memory_embedding_access_denied/);
  const { queryInstruction: _instruction, ...expectedModel } = model;
  assert.deepEqual(await call('  canonical query  ', allowed), {
    model: { ...expectedModel, representationFingerprint: undefined },
    vector: [0.25, 0.75],
  });
  assert.deepEqual(calls, [['Prefix: canonical query']]);
});

test('a retired embedding provider cannot return an old vector and caller cancellation remains authoritative', async () => {
  let current = service(async () => {
    current = undefined;
    return [new Float32Array([1, 0])];
  });
  const port = createMemoryEmbeddingHost({
    pluginInstanceId: instance,
    assertActivation() {},
    getEmbedding: () => current,
  });
  const call = (signal) =>
    withPluginCallContext(instance, { ...principal, memorySearch: { query: 'one', signal } }, () => port.embedQuery('one'));
  assert.equal(await call(), null);

  current = service(async () => [new Float32Array([1, 0])]);
  let checks = 0;
  const replacedDuringRecheck = await withPluginCallContext(
    instance,
    {
      ...principal,
      memorySearch: { query: 'one' },
      async assertCurrent() {
        if (++checks === 2) current = undefined;
      },
    },
    () => port.embedQuery('one'),
  );
  assert.equal(replacedDuringRecheck, null);
  const controller = new AbortController();
  current = service(async (_texts, signal) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    return [new Float32Array([1, 0])];
  });
  await assert.rejects(call(controller.signal), { name: 'AbortError' });
});
