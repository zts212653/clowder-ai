import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { shellEscape, writeAgentCommandFile } from '../dist/domains/terminal/tmux-command-file.js';
import { buildChildEnv } from '../dist/utils/cli-spawn.js';

test('private command file applies canonical environment policy and disappears on consumption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catcafe-command-file-'));
  const keys = [
    'F212_FILE_VALUE',
    'F212_DELETE_ME',
    'CAT_CAFE_HOOK_TOKEN',
    'CAT_CAFE_EXECUTION_ID',
    'PWD',
    'INIT_CWD',
    'PATH',
    'CAT_CAFE_VERDICT_GH_GUARD_BIN',
    'CAT_CAFE_VERDICT_REPO_FULL_NAME',
    'ZDOTDIR',
    'CAT_CAFE_ORIGINAL_ZDOTDIR',
    'HISTFILE',
  ];
  const env = {
    F212_FILE_VALUE: 'quotes\' " and $() and\nnewlines survive',
    F212_DELETE_ME: null,
    CAT_CAFE_HOOK_TOKEN: 'forbidden',
    CAT_CAFE_EXECUTION_ID: 'forbidden-owner',
    PWD: '/incorrect',
    INIT_CWD: '/incorrect',
    PATH: '/caller/path',
    CAT_CAFE_VERDICT_GH_GUARD_BIN: '/incorrect/guard',
    CAT_CAFE_VERDICT_REPO_FULL_NAME: 'explicit/target',
    ZDOTDIR: dir,
  };
  try {
    const expected = buildChildEnv(env, { workingDirectory: dir, bindExecutionOwner: false });
    const js = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]]))))`;
    const launch = await writeAgentCommandFile(
      dir,
      { env, cwd: dir },
      `${shellEscape(process.execPath)} -e ${shellEscape(js)}`,
    );
    const path = launch.at(-1);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(
      launch.some((value) => value.includes(env.F212_FILE_VALUE)),
      false,
    );
    const observed = JSON.parse(
      execFileSync(launch[0], launch.slice(1), {
        encoding: 'utf8',
        cwd: dir,
        env: { F212_DELETE_ME: 'stale-server-value' },
      }),
    );
    const selected = JSON.parse(JSON.stringify(Object.fromEntries(keys.map((key) => [key, expected[key]]))));
    assert.deepEqual(observed, selected);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unsupported ownership and invalid environment input fail before producing a launch artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catcafe-command-invalid-'));
  try {
    await assert.rejects(writeAgentCommandFile(dir, { bindExecutionOwner: true }, ':'), /bindExecutionOwner/);
    await assert.rejects(writeAgentCommandFile(dir, { env: { 'invalid;key': 'value' } }, ':'), /environment key/);
    await assert.rejects(writeAgentCommandFile(dir, { env: { VALUE: 'invalid\0value' } }, ':'), /environment value/);
    assert.equal(existsSync(join(dir, 'launch.sh')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
