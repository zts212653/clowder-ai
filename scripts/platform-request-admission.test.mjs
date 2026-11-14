import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('account admission failure is explicitly not sent and never points to a nonexistent charged-call audit', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-admission-'));
  try {
    mkdirSync(join(root, '.cat-cafe'));
    writeFileSync(join(root, '.cat-cafe/accounts.json'), '{}');
    writeFileSync(
      join(root, 'request.json'),
      JSON.stringify({ accountRef: 'missing', request: { method: 'GET', path: '/v1/models' } }),
    );
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CAT_CAFE_')));
    const output = join(root, 'outputs');
    const audit = join(root, 'audit');
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/platform-request.mjs'), '--request', join(root, 'request.json'), '--output-dir', output],
      {
        cwd: root,
        env: {
          ...env,
          NODE_ENV: 'test',
          LOG_DIR: join(root, 'logs'),
          AUDIT_LOG_DIR: audit,
          CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr);
    assert.equal(error.status, 'not_sent');
    assert.equal(error.code, 'platform_account_unavailable');
    assert.match(error.error, /account|账号/);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(audit), false);
    assert.doesNotMatch(error.error, /potentially charged|inspect its audit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
