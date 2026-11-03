import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./helpers/native-member-frozen-l0-child.mjs', import.meta.url));
for (const carrier of ['dsh', 'kimi']) {
  for (const scenario of ['frozen', 'missing']) {
    test(`${carrier} scoped native identity: ${scenario} admission input`, () => {
      const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', fixture, carrier, scenario], {
        encoding: 'utf8',
        env: process.env,
        timeout: 30_000,
      });
      assert.equal(child.status, 0, `${child.error?.message ?? ''}\n${child.stdout}\n${child.stderr}`);
    });
  }
}
