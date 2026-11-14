import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MlxAudioTtsProvider } from '../dist/domains/cats/services/tts/MlxAudioTtsProvider.js';
import { setServiceConfig } from '../dist/domains/services/service-config.js';
import {
  getServiceManifest,
  resolveEffectiveServiceConfig,
  serviceHealthIdentityMatches,
} from '../dist/domains/services/service-manifest.js';
import { buildLifecycleEnv } from '../dist/routes/services-lifecycle-helpers.js';

const qwen = 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16';
const kokoro = 'mlx-community/Kokoro-82M-bf16';
test('environment-only legacy activation retains unknown identity until a fresh launch', () => {
  const service = getServiceManifest('mlx-tts');
  for (const activation of [
    { TTS_ENABLED: '1' },
    { CAT_CAFE_SERVICE_TTS_ENABLED: '1', CAT_CAFE_PROFILE: 'opensource' },
  ]) {
    for (const config of [
      undefined,
      { installed: true, enabled: true },
      { installed: true, enabled: true, selectedModel: kokoro },
      { installed: true, enabled: true, selectedModel: 'qwen3-clone' },
    ]) {
      for (const selection of [undefined, 'qwen3-clone', kokoro]) {
        const env = { ...activation, ...(selection ? { TTS_MODEL: selection } : {}) };
        const effective = resolveEffectiveServiceConfig(service, config, env);
        const expected = config?.selectedModel ?? selection;
        assert.equal(effective.selectedModel, expected);
        for (const model of [qwen, kokoro]) {
          const health = {
            ok: true,
            details: {
              model,
              backend: model === qwen ? 'qwen3-clone' : 'mlx-audio',
              capabilities: ['speech-stream-route-v1'],
            },
          };
          assert.equal(
            serviceHealthIdentityMatches(service, effective, health).matches,
            expected === undefined || (expected === 'qwen3-clone' ? qwen : expected) === model,
          );
        }
        const launch = buildLifecycleEnv(env, service.id, effective.selectedModel);
        assert.equal(launch.ok, true);
        assert.equal(launch.env.TTS_MODEL, expected ?? kokoro);
      }
    }
  }
});
test('unselected legacy readiness accepts the actual listener; only a new launch needs the default', () => {
  const service = getServiceManifest('mlx-tts');
  const effective = resolveEffectiveServiceConfig(service, { installed: true, enabled: true }, {});
  assert.equal(effective.selectedModel, undefined, 'a launch default cannot identify an already running model');
  for (const model of [qwen, kokoro]) {
    assert.equal(
      serviceHealthIdentityMatches(service, effective, {
        ok: true,
        details: {
          model,
          backend: model === qwen ? 'qwen3-clone' : 'mlx-audio',
          capabilities: ['speech-stream-route-v1'],
        },
      }).matches,
      true,
    );
  }
  const launch = buildLifecycleEnv({}, service.id, effective.selectedModel);
  assert.equal(launch.ok, true);
  assert.equal(launch.env.TTS_MODEL, kokoro);
});
test('legacy rows preserve environment selection or discover the active model without rewriting configuration', async () => {
  const original = {
    fetch: globalThis.fetch,
    config: process.env.CAT_CAFE_SERVICES_CONFIG,
    model: process.env.TTS_MODEL,
  };
  const root = mkdtempSync(join(tmpdir(), 'tts-legacy-'));
  process.env.CAT_CAFE_SERVICES_CONFIG = join(root, 'services.json');
  try {
    for (const [environment, selectedModel, liveModel] of [
      ['qwen3-clone', undefined, qwen],
      [undefined, undefined, qwen],
      [undefined, undefined, kokoro],
      ['qwen3-clone', kokoro, kokoro],
    ]) {
      if (environment === undefined) delete process.env.TTS_MODEL;
      else process.env.TTS_MODEL = environment;
      setServiceConfig('mlx-tts', { installed: true, enabled: true, selectedModel });
      let posts = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/health'))
          return Response.json({
            model: liveModel,
            backend: liveModel === qwen ? 'qwen3-clone' : 'mlx-audio',
            capabilities: ['speech-stream-route-v1'],
          });
        posts++;
        assert.equal(JSON.parse(init.body).model, liveModel);
        return new Response(new Uint8Array([1, 2, 3]));
      };
      const result = await new MlxAudioTtsProvider({ baseUrl: 'http://127.0.0.1:19999' }).synthesize({
        text: '旧配置继续可用',
        voice: 'zm_yunjian',
      });
      assert.equal(result.metadata.model, liveModel);
      assert.equal(posts, 1);
      assert.equal(
        JSON.parse(readFileSync(process.env.CAT_CAFE_SERVICES_CONFIG, 'utf8'))['mlx-tts'].selectedModel,
        selectedModel,
      );
    }
  } finally {
    globalThis.fetch = original.fetch;
    for (const [key, value] of [
      ['CAT_CAFE_SERVICES_CONFIG', original.config],
      ['TTS_MODEL', original.model],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
