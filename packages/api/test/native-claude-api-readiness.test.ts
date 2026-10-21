import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nativeRuntimeReadiness } from '../src/routes/native-runtime-readiness.js';

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
  for (const source of ['settings', 'process']) {
    test(`Claude ${key} in ${source} is configured without launching a potentially mutating login probe`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'native-api-readiness-'));
      const names = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
      const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
      const file = join(root, 'settings.json');
      const settings = JSON.stringify({
        model: 'opus',
        env: source === 'settings' ? { [key]: 'fake-readiness-only' } : {},
      });
      writeFileSync(file, settings);
      try {
        process.env.CLAUDE_CONFIG_DIR = root;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
        if (source === 'process') process.env[key] = 'fake-readiness-only';
        // No executable exists: this would return unknown if it tried auth status.
        const result = await nativeRuntimeReadiness(
          { id: 'claude', installed: true, command: join(root, 'must-not-run') },
          root,
          true,
        );
        assert.equal(result.status, 'configured');
        assert.equal(readFileSync(file, 'utf8'), settings);
        assert.equal(JSON.stringify(result).includes('fake-readiness-only'), false);
        const missing = await nativeRuntimeReadiness({ id: 'claude', installed: false }, root, true);
        assert.equal(missing.status, 'not_installed');
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test('malformed configuration and blank API credentials cannot establish authentication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-api-empty-'));
  const names = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CLAUDE_CONFIG_DIR = root;
    process.env.ANTHROPIC_API_KEY = ' ';
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    for (const contents of ['invalid json', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: ' ' } })]) {
      writeFileSync(join(root, 'settings.json'), contents);
      const result = await nativeRuntimeReadiness(
        { id: 'claude', installed: true, command: join(root, 'absent') },
        root,
        true,
      );
      assert.equal(result.status, 'unknown');
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
