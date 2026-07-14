import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const originalCatCafeHome = process.env.CAT_CAFE_HOME;
const originalServicesConfig = process.env.CAT_CAFE_SERVICES_CONFIG;

const { getServiceConfig, setServiceConfig } = await import('../dist/domains/services/service-config.js');
const { deriveLegacyServiceConfig, SERVICE_MANIFESTS } = await import('../dist/domains/services/service-manifest.js');

afterEach(() => {
  if (originalCatCafeHome === undefined) delete process.env.CAT_CAFE_HOME;
  else process.env.CAT_CAFE_HOME = originalCatCafeHome;
  if (originalServicesConfig === undefined) delete process.env.CAT_CAFE_SERVICES_CONFIG;
  else process.env.CAT_CAFE_SERVICES_CONFIG = originalServicesConfig;
});

describe('service config storage', () => {
  it('defaults services.json to CAT_CAFE_HOME', () => {
    const catCafeHome = mkdtempSync(join(tmpdir(), 'cat-cafe-config-home-'));
    delete process.env.CAT_CAFE_SERVICES_CONFIG;
    process.env.CAT_CAFE_HOME = catCafeHome;
    try {
      setServiceConfig('whisper-stt', { enabled: true, installed: true });

      const configPath = join(catCafeHome, 'services.json');
      assert.equal(existsSync(configPath), true);
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(parsed['whisper-stt'].enabled, true);
      assert.equal(parsed['whisper-stt'].installed, true);
    } finally {
      rmSync(catCafeHome, { recursive: true, force: true });
    }
  });
});

describe('legacy service config migration (#863)', () => {
  it('migrates qwen3-asr config to whisper-stt on first load', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cat-cafe-migration-'));
    const configPath = join(tmpDir, 'services.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        'qwen3-asr': { enabled: true, installed: true, selectedModel: 'mlx-community/Qwen3-ASR-1.7B-8bit' },
      }),
    );
    process.env.CAT_CAFE_SERVICES_CONFIG = configPath;
    try {
      const config = getServiceConfig('whisper-stt');
      assert.ok(config, 'whisper-stt config should exist after migration');
      assert.equal(config.enabled, true);
      assert.equal(config.selectedModel, 'mlx-community/Qwen3-ASR-1.7B-8bit');
      // installed must be explicitly false — old venv (asr-venv) doesn't
      // match new service (whisper-venv). Stripping (undefined) makes the
      // reconciler infer installed=true from enabled=true, which skips
      // the necessary venv rebuild.
      assert.equal(config.installed, false, 'installed must be false to force reinstall');

      // Old key should be removed from disk
      const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(persisted['qwen3-asr'], undefined, 'old qwen3-asr key should be removed');
      assert.ok(persisted['whisper-stt'], 'whisper-stt key should exist on disk');
      assert.equal(persisted['whisper-stt'].installed, false, 'installed must be false on disk');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('backfills default model when old config has no selectedModel', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cat-cafe-migration-nomodel-'));
    const configPath = join(tmpDir, 'services.json');
    // Old Qwen service allowed running without explicit model selection —
    // the start script had a hardcoded default. The new whisper-server.sh
    // requires WHISPER_MODEL, so migration must backfill the Qwen default.
    writeFileSync(
      configPath,
      JSON.stringify({
        'qwen3-asr': { enabled: true, installed: true },
      }),
    );
    process.env.CAT_CAFE_SERVICES_CONFIG = configPath;
    try {
      const config = getServiceConfig('whisper-stt');
      assert.ok(config, 'whisper-stt config should exist after migration');
      assert.equal(config.enabled, true);
      assert.equal(config.installed, false, 'installed must be false to force reinstall');
      assert.equal(
        config.selectedModel,
        'mlx-community/Qwen3-ASR-1.7B-8bit',
        'must backfill Qwen default model when old config had none',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps whisper-stt config when both old and new exist', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cat-cafe-migration-both-'));
    const configPath = join(tmpDir, 'services.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        'qwen3-asr': { enabled: true, installed: true, selectedModel: 'mlx-community/Qwen3-ASR-1.7B-8bit' },
        'whisper-stt': { enabled: true, installed: true, selectedModel: 'mlx-community/whisper-large-v3-turbo' },
      }),
    );
    process.env.CAT_CAFE_SERVICES_CONFIG = configPath;
    try {
      const config = getServiceConfig('whisper-stt');
      assert.equal(
        config?.selectedModel,
        'mlx-community/whisper-large-v3-turbo',
        'should keep existing whisper-stt config, not overwrite with qwen3-asr',
      );

      const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(persisted['qwen3-asr'], undefined, 'old key should still be cleaned up');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('legacy env bridge fallback (#863)', () => {
  const whisperManifest = SERVICE_MANIFESTS.find((s) => s.id === 'whisper-stt');

  it('derives whisper-stt config from QWEN3_ASR_ENABLED env var', () => {
    const env = { QWEN3_ASR_ENABLED: '1', QWEN3_ASR_MODEL: 'mlx-community/Qwen3-ASR-1.7B-8bit' };
    const config = deriveLegacyServiceConfig(whisperManifest, env);
    assert.ok(config, 'should derive config from legacy QWEN3_ASR_ENABLED');
    assert.equal(config.enabled, true);
    assert.equal(config.selectedModel, 'mlx-community/Qwen3-ASR-1.7B-8bit');
  });

  it('derives whisper-stt config from CAT_CAFE_SERVICE_QWEN3_ASR_ENABLED', () => {
    const env = { CAT_CAFE_SERVICE_QWEN3_ASR_ENABLED: 'true' };
    const config = deriveLegacyServiceConfig(whisperManifest, env);
    assert.ok(config, 'should derive config from CAT_CAFE_SERVICE_QWEN3_ASR_ENABLED');
    assert.equal(config.enabled, true);
  });

  it('prefers primary ASR_ENABLED over fallback QWEN3_ASR_ENABLED', () => {
    const env = { ASR_ENABLED: '1', WHISPER_MODEL: 'large-v3', QWEN3_ASR_ENABLED: '1', QWEN3_ASR_MODEL: 'Qwen3-ASR' };
    const config = deriveLegacyServiceConfig(whisperManifest, env);
    assert.ok(config);
    assert.equal(config.selectedModel, 'large-v3', 'primary model env should take precedence');
  });

  it('returns undefined when no legacy env vars are set', () => {
    const config = deriveLegacyServiceConfig(whisperManifest, {});
    assert.equal(config, undefined);
  });

  it('explicit ASR_ENABLED=0 is not overridden by stale QWEN3_ASR_ENABLED=1', () => {
    const env = { ASR_ENABLED: '0', QWEN3_ASR_ENABLED: '1' };
    const config = deriveLegacyServiceConfig(whisperManifest, env);
    assert.equal(config, undefined, 'explicit disable must win over legacy fallback enable');
  });

  it('explicit CAT_CAFE_SERVICE_ASR_ENABLED=0 is not overridden by legacy Qwen flag', () => {
    const env = { CAT_CAFE_SERVICE_ASR_ENABLED: '0', CAT_CAFE_SERVICE_QWEN3_ASR_ENABLED: 'true' };
    const config = deriveLegacyServiceConfig(whisperManifest, env);
    assert.equal(config, undefined, 'API-level disable must win over legacy fallback');
  });

  it('uses Qwen default model when activation came from QWEN3_ASR_ENABLED without model env', () => {
    const env = { QWEN3_ASR_ENABLED: '1' };
    const config = deriveLegacyServiceConfig(whisperManifest, env);
    assert.ok(config, 'should derive config from legacy enable');
    assert.equal(
      config.selectedModel,
      'mlx-community/Qwen3-ASR-1.7B-8bit',
      'should use Qwen default, not whisper manifest default',
    );
  });
});
