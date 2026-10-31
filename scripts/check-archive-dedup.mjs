#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'darwin') {
  const result = spawnSync(
    'python3',
    ['-B', fileURLToPath(new URL('./deduplicate-release-archives.test.py', import.meta.url))],
    {
      stdio: 'inherit',
      timeout: 60_000,
    },
  );
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else {
  console.log('Native archive clone tests require macOS; skipped on this platform.');
}
