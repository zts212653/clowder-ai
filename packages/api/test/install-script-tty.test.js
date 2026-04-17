import test from 'node:test';

import { assert, installScript, runSourceOnlySnippet, spawnSync } from './install-script-test-helpers.js';

test('tty_select and tty_multiselect have read timeout to prevent indefinite blocking', () => {
  const output = runSourceOnlySnippet(`
type tty_select
echo '---SEPARATOR---'
type tty_multiselect
`);

  const [selectSource, multiselectSource] = output.split('---SEPARATOR---');
  assert.match(selectSource, /read\s+-rsn1\s+-t\s+\d+/, 'tty_select must have -t timeout on primary read');
  assert.match(multiselectSource, /read\s+-rsn1\s+-t\s+\d+/, 'tty_multiselect must have -t timeout on primary read');
});

test('tty arrow parser accepts normal and application cursor key sequences', () => {
  const output = runSourceOnlySnippet(`
printf '%s' "$(tty_arrow_delta '[A'),$(tty_arrow_delta 'OA'),$(tty_arrow_delta '[B'),$(tty_arrow_delta 'OB')"
`);

  assert.equal(output, '-1,-1,1,1');
});

test('tty numeric shortcut parser maps visible menu numbers to zero-based indices', () => {
  const output = runSourceOnlySnippet(`
printf '%s' "$(tty_numeric_index 1 3),$(tty_numeric_index 3 3),"
if tty_numeric_index 4 3 >/dev/null; then
  printf 'unexpected'
else
  printf 'none'
fi
`);

  assert.equal(output, '0,2,none');
});

test('tty_select honors a configured default index when no tty is available', () => {
  const output = runSourceOnlySnippet(`
HAS_TTY=false
TTY_SELECT_DEFAULT_INDEX=2 tty_select SELECTED "Pick one:" "OAuth" "API Key" "Skip"
printf '%s' "$SELECTED"
`);

  assert.equal(output, '2');
});

test('tty_read returns empty string when /dev/tty is unavailable (no blocking)', () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
source "${installScript}" --source-only >/dev/null 2>&1
HAS_TTY=false
tty_read "prompt: " MY_VAR
printf '%s' "$MY_VAR"`,
    ],
    { encoding: 'utf8', input: '' },
  );

  assert.equal(result.status, 0, `exit=${result.status}\nstderr:\n${result.stderr}`);
  assert.equal(result.stdout, '');
});

test('tty_read uses 120s timeout to prevent indefinite blocking', () => {
  const result = spawnSync(
    'bash',
    ['-c', `set -e\nsource "${installScript}" --source-only >/dev/null 2>&1\ntype tty_read`],
    {
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, `exit=${result.status}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /-t 120/, 'tty_read should include -t 120 timeout');
});

test('tty_read_secret uses 120s timeout and suppresses echo', () => {
  const result = spawnSync(
    'bash',
    ['-c', `set -e\nsource "${installScript}" --source-only >/dev/null 2>&1\ntype tty_read_secret`],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, `exit=${result.status}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /-t 120/, 'tty_read_secret should include -t 120 timeout');
  assert.match(result.stdout, /-rs/, 'tty_read_secret should use -s to suppress echo');
});

test('tty_read prompt is written via printf, not via read -p', () => {
  const result = spawnSync(
    'bash',
    ['-c', `set -e\nsource "${installScript}" --source-only >/dev/null 2>&1\ntype tty_read`],
    {
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /read\s+-rp/, 'tty_read should not use read -rp');
  assert.match(result.stdout, /printf.*\/dev\/tty/, 'tty_read should printf prompt to /dev/tty');
});

test('HAS_TTY detection checks both -r and -w on /dev/tty', () => {
  const result = spawnSync('bash', ['-c', `grep -E '\\-r /dev/tty.*\\-w /dev/tty' "${installScript}" | head -1`], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /-r \/dev\/tty/, 'Should check /dev/tty is readable');
  assert.match(result.stdout, /-w \/dev\/tty/, 'Should check /dev/tty is writable');
});
