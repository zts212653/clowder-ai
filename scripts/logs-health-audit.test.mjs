import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const script = fileURLToPath(new URL('./logs-health.sh', import.meta.url)).replaceAll('\\', '/');
test(
  'health audit diagnostics honor the deployment directory and explicit override without switching other layers',
  { skip: process.platform === 'win32' && !existsSync(bash) },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'logs-health-audit-')).replaceAll('\\', '/');
    const apiData = `${root}/api/data`;
    for (const override of [undefined, `${root}/explicit audit`]) {
      const result = spawnSync(bash, [script, apiData, `${root}/process`, ...(override ? [override] : [])], {
        encoding: 'utf8',
        env: { ...process.env, AUDIT_LOG_DIR: 'relative-audit' },
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const expected = override ?? `${root}/api/relative-audit`;
      assert.ok(result.stdout.includes(`Audit dir:     ${expected}`), result.stdout);
      assert.ok(result.stdout.includes(`Audit source:  ${override ? 'explicit argument' : 'deployment environment'}`));
      assert.ok(result.stdout.includes(`${apiData}/logs/api`));
    }
  },
);
