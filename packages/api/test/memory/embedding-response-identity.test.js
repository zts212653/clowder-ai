import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmbeddingService } from '../../dist/domains/memory/EmbeddingService.js';

const config = {
  embedModel: 'fixture-same-model',
  embedDim: 4,
  embedTimeoutMs: 2000,
  maxModelMemMb: 1234,
  generationId: 'g1',
  representationFingerprint: 'a'.repeat(64),
};
function transport(t, healthFingerprint, responseFingerprint) {
  const old = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body && JSON.parse(init.body) });
    return new Response(
      JSON.stringify(
        String(url).endsWith('/health')
          ? {
              status: 'ok',
              model: config.embedModel,
              dim: 4,
              generation_id: 'g1',
              representation_fingerprint: healthFingerprint,
            }
          : {
              model: config.embedModel,
              generation_id: 'g1',
              representation_fingerprint: responseFingerprint,
              data: [{ index: 0, embedding: [1, 0, 0, 0] }],
            },
      ),
      { status: 200 },
    );
  };
  t.after(() => {
    globalThis.fetch = old;
  });
  return calls;
}
test('same model and dimension with a different loaded recipe is not ready', async (t) => {
  transport(t, 'b'.repeat(64), 'b'.repeat(64));
  const service = new EmbeddingService(config);
  await service.load();
  assert.equal(service.isReady(), false);
});
test('a changed sidecar response is rejected even after a matching health probe', async (t) => {
  transport(t, config.representationFingerprint, 'b'.repeat(64));
  const service = new EmbeddingService(config);
  await service.load();
  assert.equal(service.isReady(), true);
  await assert.rejects(service.embed(['neutral document']), /representation|identity/i);
});
test('every request binds expected geometry and both endpoints retain memory limits', async (t) => {
  const calls = transport(t, config.representationFingerprint, config.representationFingerprint);
  const service = new EmbeddingService(config);
  await service.load();
  assert.deepEqual([...(await service.embed(['neutral document']))[0]], [1, 0, 0, 0]);
  const request = calls.at(-1).body;
  assert.equal(request.representation_fingerprint, config.representationFingerprint);
  assert.equal(request.max_model_mem_mb, 1234);
  assert.equal(service.getModelInfo().representationFingerprint, config.representationFingerprint);
});

test('a borrowed legacy provider cannot change packages after its health binding', async (t) => {
  const old = globalThis.fetch;
  globalThis.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).endsWith('/health')
          ? {
              status: 'ok',
              model: 'legacy-package',
              dim: 4,
              generation_id: 'g0',
            }
          : { model: 'other-package', dim: 4, generation_id: 'g0', data: [{ index: 0, embedding: [1, 0, 0, 0] }] },
      ),
    );
  t.after(() => {
    globalThis.fetch = old;
  });
  const service = new EmbeddingService({ ...config, generationId: 'g0', representationFingerprint: undefined });
  await service.load();
  assert.equal(service.isReady(), true);
  await assert.rejects(service.embed(['neutral document']), /identity|representation/i);
});

for (const generationId of ['g0', 'g1']) {
  test(`${generationId} health loading/degraded clears ready without erasing the previously bound identity`, async (t) => {
    const original = globalThis.fetch;
    let status = 'ok',
      model = config.embedModel;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status,
          model,
          dim: 4,
          generation_id: generationId,
          ...(generationId === 'g1' ? { representation_fingerprint: config.representationFingerprint } : {}),
        }),
      );
    t.after(() => {
      globalThis.fetch = original;
    });
    const service = new EmbeddingService({
      ...config,
      generationId,
      representationFingerprint: generationId === 'g1' ? config.representationFingerprint : undefined,
    });
    for (const unavailable of ['loading', 'degraded']) {
      status = 'ok';
      await service.load();
      assert.equal(service.isReady(), true);
      status = unavailable;
      await service.load();
      assert.equal(service.isReady(), false, `${generationId}: ${unavailable} must revoke readiness`);
    }
    status = 'ok';
    model = 'other-package';
    await service.load();
    assert.equal(
      service.isReady(),
      false,
      'non-ok health cannot erase the original identity and admit another package',
    );
    assert.equal(service.getModelInfo().modelId, config.embedModel);
    service.dispose();
  });
}
