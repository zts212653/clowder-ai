import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('embedding runtime policy enforces bounded admission and memory scope', () => {
  execFileSync('python3', [resolve(repoRoot, 'scripts/services/test_embed_runtime_policy.py')], {
    cwd: resolve(repoRoot, 'scripts/services'),
    encoding: 'utf8',
    stdio: 'pipe',
  });
});
