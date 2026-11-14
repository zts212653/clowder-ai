import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { MlxAudioTtsProvider } from '../dist/domains/cats/services/tts/MlxAudioTtsProvider.js';
import { setServiceConfig } from '../dist/domains/services/service-config.js';
import { getServiceManifest, serviceHealthIdentityMatches } from '../dist/domains/services/service-manifest.js';

const originalFetch = globalThis.fetch;
const originalConfig = process.env.CAT_CAFE_SERVICES_CONFIG;
const roots = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalConfig === undefined) delete process.env.CAT_CAFE_SERVICES_CONFIG;
  else process.env.CAT_CAFE_SERVICES_CONFIG = originalConfig;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('model identity, request and result follow the installed service selection on the same provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tts-model-selection-'));
  roots.push(root);
  process.env.CAT_CAFE_SERVICES_CONFIG = join(root, 'services.json');
  const bodies = [];
  let liveModel = 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16';
  globalThis.fetch = async (_url, init) => {
    if (String(_url).endsWith('/health'))
      return Response.json({ model: liveModel, backend: 'qwen3-clone', capabilities: ['speech-stream-route-v1'] });
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  const provider = new MlxAudioTtsProvider({ baseUrl: 'http://127.0.0.1:19979' });
  const models = ['mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16', 'mlx-community/Breeze-TTS-2-mlx'];
  for (const model of models) {
    liveModel = model;
    setServiceConfig('mlx-tts', { enabled: true, installed: true, selectedModel: model });
    assert.equal(provider.model, model, 'cache consumers must see the selected model without API restart');
    const result = await provider.synthesize({ text: '相同台词', voice: 'S0' });
    assert.equal(bodies.at(-1)?.model, model);
    assert.equal(result.metadata.model, model);
  }
});

test('an explicit model override stays fixed while the persisted selection changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tts-explicit-model-'));
  roots.push(root);
  process.env.CAT_CAFE_SERVICES_CONFIG = join(root, 'services.json');
  const provider = new MlxAudioTtsProvider({ model: 'fixture/explicit' });
  setServiceConfig('mlx-tts', { enabled: true, selectedModel: 'mlx-community/Breeze-TTS-2-mlx' });
  assert.equal(provider.model, 'fixture/explicit');
});

test('the legacy Qwen provider alias retains its concrete model identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'tts-qwen-alias-'));
  roots.push(root);
  process.env.CAT_CAFE_SERVICES_CONFIG = join(root, 'services.json');
  setServiceConfig('mlx-tts', { enabled: true, installed: true, selectedModel: 'qwen3-clone' });
  assert.equal(new MlxAudioTtsProvider().model, 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16');
});

test('TTS readiness rejects an old model after selection changes, while accepting the Qwen alias', () => {
  const service = getServiceManifest('mlx-tts');
  assert.ok(service);
  const health = {
    ok: true,
    details: {
      model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16',
      capabilities: ['speech-stream-route-v1'],
    },
  };
  assert.equal(
    serviceHealthIdentityMatches(
      service,
      {
        enabled: true,
        selectedModel: 'mlx-community/Breeze-TTS-2-mlx',
      },
      health,
    ).matches,
    false,
    'start must replace an owned process running the previous model',
  );
  assert.equal(
    serviceHealthIdentityMatches(
      service,
      {
        enabled: true,
        selectedModel: 'qwen3-clone',
      },
      health,
    ).matches,
    true,
  );
  assert.equal(serviceHealthIdentityMatches(service, { enabled: true }, health).matches, true);
});

test('provider aliases reject a Qwen listener and accept their actual backend identity', () => {
  const service = getServiceManifest('mlx-tts');
  for (const [selectedModel, backend, model] of [
    ['edge-tts', 'edge-tts', 'none'],
    ['sapi', 'sapi', 'none'],
    ['piper', 'piper', 'zh_CN-huayan-medium'],
    ['zh_CN-huayan-medium', 'piper', 'zh_CN-huayan-medium'],
  ]) {
    const config = { enabled: true, selectedModel };
    const details = {
      model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16',
      backend: 'qwen3-clone',
      capabilities: ['speech-stream-route-v1'],
    };
    assert.equal(serviceHealthIdentityMatches(service, config, { ok: true, details }).matches, false, selectedModel);
    assert.equal(
      serviceHealthIdentityMatches(service, config, { ok: true, details: { ...details, backend, model } }).matches,
      true,
      selectedModel,
    );
  }
});

for (const streaming of [false, true]) {
  test(`in-flight ${streaming ? 'stream' : 'synthesis'} retains the requested model identity`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tts-in-flight-'));
    roots.push(root);
    process.env.CAT_CAFE_SERVICES_CONFIG = join(root, 'services.json');
    const selected = 'mlx-community/Breeze-TTS-2-mlx';
    setServiceConfig('mlx-tts', { enabled: true, selectedModel: selected });
    globalThis.fetch = async (_url, init) => {
      if (String(_url).endsWith('/health'))
        return Response.json({ model: selected, backend: 'qwen3-clone', capabilities: ['speech-stream-route-v1'] });
      assert.equal(JSON.parse(String(init?.body)).model, selected);
      setServiceConfig('mlx-tts', { selectedModel: 'qwen3-clone' });
      return new Response(
        streaming ? `${JSON.stringify({ type: 'final', audio_base64: 'AQID' })}\n` : new Uint8Array([1, 2, 3]),
        { status: 200 },
      );
    };
    const provider = new MlxAudioTtsProvider({ baseUrl: 'http://127.0.0.1:19979' });
    if (streaming) {
      for await (const event of provider.stream({ text: '你好', voice: 'S0' })) {
        if (event.type === 'final') assert.equal(event.result.metadata.model, selected);
      }
    } else {
      assert.equal((await provider.synthesize({ text: '你好', voice: 'S0' })).metadata.model, selected);
    }
  });
}
