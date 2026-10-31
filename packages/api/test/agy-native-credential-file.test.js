import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareAgyNativeCredentialFile } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-credential-file.js';

test('native MCP receives a one-turn owner-only credential file, with no ambient token', () => {
  const home = mkdtempSync(join(tmpdir(), 'f325-credential-'));
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  try {
    const binding = prepareAgyNativeCredentialFile(home, {
      CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
      CAT_CAFE_INVOCATION_ID: 'inv-1',
      CAT_CAFE_CALLBACK_TOKEN: 'secret-1',
    });
    assert.equal(binding.apiUrl, 'http://127.0.0.1:3012');
    assert.match(binding.path, /cat-cafe-credentials\/.+\.json$/);
    assert.deepEqual(JSON.parse(readFileSync(binding.path, 'utf8')), {
      invocationId: 'inv-1',
      callbackToken: 'secret-1',
    });
    assert.equal(lstatSync(binding.path).mode & 0o077, 0);
    binding.dispose();
    assert.throws(() => lstatSync(binding.path), /ENOENT/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('native MCP credential file refuses incomplete or remote callback authority', () => {
  const home = mkdtempSync(join(tmpdir(), 'f325-credential-'));
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  try {
    for (const env of [
      { CAT_CAFE_API_URL: 'http://127.0.0.1:3012', CAT_CAFE_INVOCATION_ID: 'inv-1' },
      { CAT_CAFE_API_URL: 'https://example.com', CAT_CAFE_INVOCATION_ID: 'inv-1', CAT_CAFE_CALLBACK_TOKEN: 's' },
    ]) {
      assert.throws(() => prepareAgyNativeCredentialFile(home, env), /credential|callback/i);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
