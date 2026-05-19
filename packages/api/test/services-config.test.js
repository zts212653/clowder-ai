import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('service config storage', () => {
  it('uses ~/.cat-cafe/services.json as the default config path', () => {
    const home = mkdtempSync(join(tmpdir(), 'cat-cafe-services-home-'));
    try {
      const env = { ...process.env, HOME: home };
      delete env.CAT_CAFE_SERVICES_CONFIG;
      const moduleUrl = new URL('../dist/domains/services/service-config.js', import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { setServiceConfig } from ${JSON.stringify(moduleUrl)}; setServiceConfig('whisper-stt', { enabled: true, selectedModel: 'org/model' });`,
        ],
        { cwd: process.cwd(), env, encoding: 'utf-8' },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const configPath = join(home, '.cat-cafe/services.json');
      assert.equal(existsSync(configPath), true);
      const data = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.equal(data['whisper-stt'].enabled, true);
      assert.equal(data['whisper-stt'].selectedModel, 'org/model');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
