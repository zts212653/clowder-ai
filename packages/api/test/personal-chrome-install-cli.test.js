import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const installCli = fileURLToPath(new URL('../scripts/f247-personal-chrome-install.mjs', import.meta.url));

test('inspect CLI rejects a missing exact-route conversation selector', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [installCli, 'inspect', '--conversation-id'], {
      env: { ...process.env, CAT_CAFE_CONFIG_ROOT: '/tmp/cat-cafe-f247-install-cli' },
    }),
    (error) => error.code === 1 && error.stderr.includes('--conversation-id requires a value'),
  );
});

test('inspect CLI rejects a malformed exact-route conversation selector', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [installCli, 'inspect', '--conversation-id', 'bad/value'], {
      env: { ...process.env, CAT_CAFE_CONFIG_ROOT: '/tmp/cat-cafe-f247-install-cli' },
    }),
    (error) => error.code === 1 && error.stderr.includes('--conversation-id has an invalid format'),
  );
});
