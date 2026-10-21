import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-program-selection-')));
const main = join(root, 'cat-cafe');
const protectedBin = join(root, 'cat-cafe-runtime', 'scripts', 'guarded-bin');
const ordinaryBin = join(root, 'ordinary-bin');
mkdirSync(main);
mkdirSync(protectedBin, { recursive: true });
mkdirSync(ordinaryBin);
after(() => rmSync(root, { force: true, recursive: true }));
const noHost = { selfHost: () => ({ confidence: 'none' }) };
const nodeBin = dirname(process.execPath);
function parity(command, expected) {
  for (const tool_name of ['Bash', 'exec_command']) {
    const verdict = decideNativeHookPayload({ tool_name, cwd: main, tool_input: { command, cmd: command } }, noHost);
    assert.equal(verdict.decision, expected, `${command}: ${JSON.stringify(verdict)}`);
  }
}

function symlinkSensitiveExecutable(label) {
  const shadowRoot = join(root, `path-shadow-${label}`);
  const lexicalBin = join(shadowRoot, 'guarded-bin');
  const protectedLink = join(shadowRoot, 'runtime-link');
  const tool = 'node';
  mkdirSync(lexicalBin, { recursive: true });
  writeFileSync(join(lexicalBin, tool), '#!/bin/sh\n# lexical executable\nexit 0\n', { mode: 0o700 });
  writeFileSync(join(protectedBin, tool), '#!/bin/sh\n# protected executable\nexit 0\n', { mode: 0o700 });
  symlinkSync(protectedBin, protectedLink, 'dir');
  const disguisedProtectedBin = `${protectedLink}/../guarded-bin`;
  assert.match(readFileSync(`${disguisedProtectedBin}/${tool}`, 'utf8'), /protected executable/);
  return {
    cleanup: () => rmSync(join(protectedBin, tool), { force: true }),
    disguisedProtectedBin,
    lexicalBin,
    tool,
  };
}

test('unknown or selected protected executable cannot disappear with PATH', () => {
  writeFileSync(join(protectedBin, 'custom-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  for (const prefix of [`PATH=${protectedBin}`, `env PATH=${protectedBin}`]) {
    parity(`${prefix} custom-tool --flag`, 'deny');
    parity(`${prefix} unproved-tool --flag`, 'deny');
  }
  symlinkSync(join(protectedBin, 'custom-tool'), join(ordinaryBin, 'alias-tool'));
  parity(`PATH=${ordinaryBin}:${protectedBin} alias-tool --flag`, 'deny');
});

test('first selected ordinary executable is distinct from a protected search directory', () => {
  writeFileSync(join(ordinaryBin, 'custom-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  parity(`PATH=${ordinaryBin}:${protectedBin} custom-tool --flag`, 'allow');
  parity(`PATH=${protectedBin}:${ordinaryBin} custom-tool --flag`, 'deny');
  parity(`PATH=${protectedBin}:${nodeBin} node -e 'console.log(1)'`, 'allow');
  parity(`env PATH=${protectedBin}:${nodeBin} node -e 'console.log(1)'`, 'allow');
});

test('PATH entries after the selected executable cannot invalidate that selection', () => {
  const malformedTail = 'Unknown command: bin';
  const data = JSON.stringify({ note: `rm -rf ${protectedBin}` });
  parity(`env PATH='${nodeBin}:${malformedTail}' node -e 'console.log(process.argv[1])' '${data}'`, 'allow');
  parity(`env PATH='${malformedTail}:${nodeBin}' node -e 'console.log(process.argv[1])' '${data}'`, 'deny');
  parity(`env PATH='${malformedTail}' ${process.execPath} -e 'console.log(process.argv[1])' '${data}'`, 'allow');
});

test('symlink-sensitive PATH parent segments cannot hide a protected executable', () => {
  const fixture = symlinkSensitiveExecutable('path');
  try {
    const data = JSON.stringify({ note: `rm -rf ${protectedBin}` });
    parity(`PATH=${fixture.lexicalBin} ${fixture.tool} -e 'console.log(process.argv[1])' '${data}'`, 'allow');
    parity(`PATH=${fixture.disguisedProtectedBin} ${fixture.tool} -e 'console.log(process.argv[1])' '${data}'`, 'deny');
  } finally {
    fixture.cleanup();
  }
});

test('symlink-sensitive direct parent segments cannot hide a protected executable', () => {
  const fixture = symlinkSensitiveExecutable('direct');
  try {
    const data = JSON.stringify({ note: `rm -rf ${protectedBin}` });
    parity(
      `PATH=${nodeBin} ${fixture.disguisedProtectedBin}/${fixture.tool} -e 'console.log(process.argv[1])' '${data}'`,
      'deny',
    );
  } finally {
    fixture.cleanup();
  }
});

test('PATH retains wrapper selection and script interpreter identity', () => {
  writeFileSync(join(protectedBin, 'env'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  parity(`PATH=${protectedBin} env PATH=${nodeBin} node -e 'console.log(1)'`, 'deny');
  writeFileSync(join(ordinaryBin, 'script-tool'), `#!${protectedBin}/custom-tool\n`, { mode: 0o700 });
  parity(`PATH=${ordinaryBin}:${protectedBin} script-tool --flag`, 'deny');
  writeFileSync(join(ordinaryBin, 'script-tool'), '#!/usr/bin/env custom-tool\n', { mode: 0o700 });
  parity(`PATH=${protectedBin}:${ordinaryBin} script-tool --flag`, 'deny');
});

test('canonical repository gh wrapper needs exact code and ordinary node/delegate selection', () => {
  const wrapper = readFileSync(new URL('../../../scripts/guarded-bin/gh', import.meta.url));
  const gh = join(protectedBin, 'gh');
  const realGh = join(ordinaryBin, 'gh');
  writeFileSync(realGh, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(gh, wrapper, { mode: 0o700 });
  const command = `env CAT_CAFE_REAL_GH_PATH=${realGh} PATH=${protectedBin}:${nodeBin}:${ordinaryBin}:/usr/bin:/bin gh pr status`;
  parity(command, 'allow');
  writeFileSync(gh, Buffer.concat([wrapper, Buffer.from('\n// unreviewed mutation\n')]), { mode: 0o700 });
  parity(command, 'deny');
  writeFileSync(gh, '#!/bin/sh\nexec custom-tool "$@"\n', { mode: 0o700 });
  parity(command, 'deny');
  writeFileSync(gh, wrapper, { mode: 0o700 });
  const protectedDelegate = join(protectedBin, 'gh-delegate');
  writeFileSync(protectedDelegate, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  parity(command.replace(`CAT_CAFE_REAL_GH_PATH=${realGh}`, `CAT_CAFE_REAL_GH_PATH=${protectedDelegate}`), 'deny');
  const git = join(protectedBin, 'git');
  writeFileSync(git, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  parity(command.replace('pr status', 'pr create --title example'), 'deny');
  rmSync(git);
  writeFileSync(join(protectedBin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  parity(command, 'deny');
});
