// Home provider integration: the Claude hook intentionally is not exported.
// Portable classifier cases and the shared CLI remain in their public suites.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeHookTestEnv } from './helpers/native-hook-programs.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-home-provider-')));
const main = join(root, 'cat-cafe');
const runtime = join(root, 'cat-cafe-runtime');
const ordinary = join(root, 'ordinary');
const guardedBin = join(runtime, 'scripts', 'guarded-bin');
mkdirSync(main);
mkdirSync(ordinary);
mkdirSync(guardedBin, { recursive: true });
const input = join(ordinary, 'input');
writeFileSync(input, 'a\na\nb\n');
after(() => rmSync(root, { recursive: true, force: true }));

test('real provider hook entries accept the comparison chain and reject a protected output', () => {
  const source = join(runtime, 'read-source');
  const destination = join(ordinary, 'read-target');
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, 'file.txt'), 'same\n');
  writeFileSync(join(destination, 'file.txt'), 'same\n');
  const command = `diff -qr ${source} ${destination} && find ${source} -type f && du -sk ${source} ${destination}`;
  const guard = fileURLToPath(new URL('../../../scripts/native-effect-target-guard.mjs', import.meta.url));
  const claude = fileURLToPath(new URL('../../../.claude/hooks/runtime-sanctuary-guard.sh', import.meta.url));
  for (const [binary, args] of [
    [process.execPath, [guard]],
    ['/bin/bash', [claude]],
  ]) {
    const allowed = spawnSync(binary, args, {
      env: nativeHookTestEnv(),
      input: JSON.stringify({ tool_name: 'Bash', cwd: main, tool_input: { command } }),
      encoding: 'utf8',
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout.trim(), '');
    const blocked = spawnSync(binary, args, {
      env: nativeHookTestEnv(),
      input: JSON.stringify({
        tool_name: 'Bash',
        cwd: main,
        tool_input: { command: `diff -qr ${source} ${destination} > ${runtime}/output` },
      }),
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
  const compared = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(compared.status, 0, compared.stderr);
  assert.ok(compared.stdout.includes(join(source, 'file.txt')));
  const counted = `diff -qr ${source} ${destination} && find ${source} -type f | wc -l && du -sk ${source} ${destination}`;
  for (const [binary, args] of [
    [process.execPath, [guard]],
    ['/bin/bash', [claude]],
  ]) {
    const result = spawnSync(binary, args, {
      env: nativeHookTestEnv(),
      input: JSON.stringify({ tool_name: 'Bash', cwd: runtime, tool_input: { command: counted } }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '');
  }
  const countResult = spawnSync('/bin/sh', ['-c', counted], { encoding: 'utf8' });
  assert.equal(countResult.status, 0, countResult.stderr);
  assert.match(countResult.stdout, /^\s*1\s*$/m);
});

test('real Claude hook entry refuse output syntax before an effect', () => {
  const claude = fileURLToPath(new URL('../../../.claude/hooks/runtime-sanctuary-guard.sh', import.meta.url));
  for (const [program, args] of [['/bin/bash', [claude]]]) {
    for (const command of [
      'git diff HEAD~1',
      'git cat-file -p HEAD~1',
      'find . -name *.ts',
      'find ~/projects -maxdepth 1',
    ]) {
      const result = spawnSync(program, args, {
        env: nativeHookTestEnv(),
        input: JSON.stringify({
          tool_name: 'Bash',
          cwd: runtime,
          tool_input: { command },
        }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), '', command);
    }
    for (const form of [
      (out) => `uniq ${input} ${out}`,
      (out) => `git -C ${ordinary} log --pretty --output=${out}`,
      (out) => `git -C ${ordinary} log --format --output=${out}`,
      ...['log', 'show'].flatMap((subcommand) =>
        ['-L', '--decorate-refs'].map((flag) => (out) => `git -C ${ordinary} ${subcommand} ${flag} -- --output=${out}`),
      ),
      (out) => `find ${ordinary} -fprintf ${out} '%p\n'`,
    ]) {
      const result = spawnSync(program, args, {
        env: nativeHookTestEnv(),
        input: JSON.stringify({
          tool_name: 'Bash',
          cwd: runtime,
          tool_input: { command: form(join(runtime, 'sentinel')) },
        }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.trim(), 'a denied hook must emit its refusal');
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    }
  }
});

test('real Claude gh entry preserves inherited lookup and refuses inline selectors', async (t) => {
  const gh = join(guardedBin, 'gh');
  const delegate = join(ordinary, 'gh');
  const evilBin = join(ordinary, 'evilbin');
  mkdirSync(evilBin);
  writeFileSync(join(evilBin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(gh, readFileSync(new URL('../../../scripts/guarded-bin/gh', import.meta.url)), { mode: 0o700 });
  writeFileSync(delegate, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const savedPath = process.env.PATH;
  const savedDelegate = process.env.CAT_CAFE_REAL_GH_PATH;
  process.env.PATH = `${guardedBin}:${dirname(process.execPath)}:${ordinary}:/usr/bin:/bin`;
  process.env.CAT_CAFE_REAL_GH_PATH = delegate;
  const inline = [
    `PATH=${evilBin}:${process.env.PATH} ${gh} pr view 5346`,
    `CAT_CAFE_REAL_GH_PATH=${delegate} ${gh} pr view 5346`,
    `env PATH=${evilBin}:${process.env.PATH} ${gh} pr view 5346`,
    `env CAT_CAFE_REAL_GH_PATH=${delegate} ${gh} pr view 5346`,
    `env PATH=${evilBin}:${process.env.PATH} CAT_CAFE_REAL_GH_PATH=${delegate} ${gh} pr view 5346`,
  ];
  try {
    await t.test('real Claude hook accepts canonical read and leaves inline selectors unproved', () => {
      const hook = fileURLToPath(new URL('../../../.claude/hooks/runtime-sanctuary-guard.sh', import.meta.url));
      for (const [command, expected] of [
        [`${gh} pr view 5346`, 'allow'],
        ...inline.map((command) => [command, 'allow']),
      ]) {
        const result = spawnSync('/bin/bash', [hook], {
          env: nativeHookTestEnv(),
          input: JSON.stringify({ tool_name: 'Bash', cwd: runtime, tool_input: { command } }),
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        if (expected === 'allow') assert.equal(result.stdout.trim(), '');
        else assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
      }
    });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedDelegate === undefined) delete process.env.CAT_CAFE_REAL_GH_PATH;
    else process.env.CAT_CAFE_REAL_GH_PATH = savedDelegate;
  }
});
