import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptText = readFileSync(resolve(__dirname, 'logs-health.sh'), 'utf8');

test('logs-health treats ripgrep no-match as zero errors', () => {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'logs-health-'));
  const scriptsDir = resolve(sandbox, 'scripts');
  const processLogsDir = resolve(sandbox, 'data/logs/process');

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(processLogsDir, { recursive: true });
  writeFileSync(resolve(scriptsDir, 'logs-health.sh'), scriptText, 'utf8');
  writeFileSync(resolve(processLogsDir, 'clean.log'), 'all systems nominal\n', 'utf8');

  const result = spawnSync('bash', [resolve(scriptsDir, 'logs-health.sh')], {
    cwd: sandbox,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[ok\] process/);
  assert.match(result.stdout, /errors:\s+0/);
});
