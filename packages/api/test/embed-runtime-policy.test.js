import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('embedding runtime policy enforces bounded admission and memory scope', () => {
  execFileSync('python3', ['-B', '-m', 'unittest', 'discover', '-p', 'test_embed_*.py'], {
    cwd: resolve(repoRoot, 'scripts/services'),
    encoding: 'utf8',
    stdio: 'pipe',
  });
});
