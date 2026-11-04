import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

for (const duringRead of [false, true]) {
  test(`cancellation at the canonical prior-owner read cannot crash the Host; during read=${duringRead}`, () => {
    const child = fileURLToPath(new URL('../helpers/prior-admission-cancel-child.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--unhandled-rejections=strict', child, ...(duringRead ? ['--during-read'] : [])],
      {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /prior-read-cancellation-safe/);
  });
}
