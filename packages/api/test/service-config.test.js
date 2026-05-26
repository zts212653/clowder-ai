import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const originalCatCafeHome = process.env.CAT_CAFE_HOME;
const originalServicesConfig = process.env.CAT_CAFE_SERVICES_CONFIG;

const { setServiceConfig } = await import('../dist/domains/services/service-config.js');

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
