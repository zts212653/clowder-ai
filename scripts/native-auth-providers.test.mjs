import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertNativeAuthProvider } from './test-helpers/native-auth-providers.mjs';

for (const [layout, scripts] of [
  ['source', new URL('./', import.meta.url)],
  ['packaged', new URL('../packages/mcp-server/dist/runtime/scripts/', import.meta.url)],
]) {
  for (const provider of ['kimi', 'opencode', 'dsh']) {
    test(`${layout} ${provider} admission denies authentication and preserves observation/secret boundaries`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'native-auth-provider-'));
      try {
        await assertNativeAuthProvider(provider, scripts, cwd);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
}
