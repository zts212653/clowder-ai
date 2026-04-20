import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rescueScript = resolve(__dirname, '..', '..', '..', 'scripts', 'rescue-claude-thinking-signature.mjs');

test('--session requires an argument value', () => {
  const result = spawnSync(process.execPath, [rescueScript, '--session', '--dry-run'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /--session requires a value/);
});
