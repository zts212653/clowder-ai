import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nativeKimiLoginCommand } from '../dist/routes/native-kimi-login.js';

test('copied Kimi login uses the API instance environment and restores the terminal environment', () => {
  const root = mkdtempSync(join(tmpdir(), "kimi-login-'quoted-"));
  try {
    const output = join(root, 'observed.json');
    const restored = join(root, 'restored.json');
    const recorder = join(root, 'record.mjs');
    const keys = ['HOME', 'USERPROFILE', 'KIMI_SHARE_DIR', 'KIMI_CONFIG_FILE'];
    writeFileSync(
      recorder,
      `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),env:Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,process.env[key]??null]))}));`,
    );
    const win = process.platform === 'win32';
    const command = join(root, win ? 'fixture-kimi.cmd' : 'fixture-kimi');
    writeFileSync(
      command,
      win
        ? `@"${process.execPath}" "${recorder}" %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${recorder.replaceAll("'", "'\\''")}' "$@"\n`,
    );
    chmodSync(command, 0o755);
    const instance = {
      HOME: join(root, 'instance & home'),
      USERPROFILE: join(root, 'instance & home'),
      KIMI_CONFIG_FILE: join(root, "config 'quoted.toml"),
    };
    mkdirSync(instance.HOME);
    const recipe = nativeKimiLoginCommand(command, instance);
    assert.equal(existsSync(output), false, 'building guidance must never launch the CLI');
    const terminal = Object.fromEntries(keys.map((key) => [key, `terminal-${key}`]));
    const after = win
      ? `\n[IO.File]::WriteAllText('${restored.replaceAll("'", "''")}', (@{${keys.map((key) => `${key}=$env:${key}`).join(';')}} | ConvertTo-Json -Compress))`
      : '';
    execFileSync(
      win ? 'powershell.exe' : 'sh',
      win
        ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', recipe + after]
        : ['-c', recipe],
      {
        env: { ...process.env, ...terminal },
        windowsHide: true,
        timeout: 15_000,
      },
    );
    const observed = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(observed.args, ['login']);
    assert.deepEqual(observed.env, { ...instance, KIMI_SHARE_DIR: null });
    if (win) assert.deepEqual(JSON.parse(readFileSync(restored, 'utf8').replace(/^\uFEFF/, '')), terminal);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
