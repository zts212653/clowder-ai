import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

for (const whileWaiting of [false, true]) {
  test(`cancellation at actual session custody cannot crash the Host; while waiting=${whileWaiting}`, () => {
    const child = fileURLToPath(new URL('../helpers/prior-admission-cancel-child.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--unhandled-rejections=strict', child, ...(whileWaiting ? ['--while-waiting'] : [])],
      {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /session-custody-cancellation-safe/);
  });
}
