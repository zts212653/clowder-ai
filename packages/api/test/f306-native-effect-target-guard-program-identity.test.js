import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-unproved-execution-')));
const runtime = join(root, 'projects/relay-station/cat-cafe-runtime');
mkdirSync(runtime, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));
const standardEnv = { PATH: '/usr/bin:/bin', ZDOTDIR: root };
const requiresZsh = { skip: !existsSync('/bin/zsh') ? '/bin/zsh is not installed' : false };

test('unbound shell hints cannot exclude protected cwd from a write', () => {
  const command = `/usr/bin/sort -o ${root}/safe ${root}/input`;
  for (const toolName of ['Bash', 'exec_command']) {
    for (const hints of [
      {},
      { shell: '/bin/bash', login: false },
      { shell: '/bin/zsh', login: true },
      { executionContext: { attested: true, startupFiles: [] } },
    ]) {
      const result = decideNativeHookPayload(
        {
          tool_name: toolName,
          cwd: runtime,
          tool_input: { command, cmd: command, ...hints },
        },
        { selfHost: () => ({ confidence: 'none' }) },
      );
      assert.equal(result.decision, 'deny');
      assert.equal(result.reasonCode, 'runtime_sanctuary_mutation');
    }
  }
});

test('startup contents cannot supply missing executor evidence, in non-login zsh too', requiresZsh, () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'f306-startup-identity-')));
  try {
    const runtime = join(fixture, 'projects/relay-station/cat-cafe-runtime');
    const bin = join(fixture, 'bin'),
      zdot = join(fixture, 'zdot');
    mkdirSync(runtime, { recursive: true });
    mkdirSync(bin);
    mkdirSync(zdot);
    const input = join(fixture, 'input'),
      safe = join(fixture, 'safe'),
      output = join(runtime, 'out');
    writeFileSync(input, 'b\na\n');
    writeFileSync(join(bin, 'sort'), `#!/bin/sh\nprintf 'AFTER\\n' > '${output}'\n`, { mode: 0o700 });
    const env = { ...process.env, PATH: '/usr/bin:/bin', ZDOTDIR: zdot };
    const homeEnv = { ...env, HOME: zdot };
    delete homeEnv.ZDOTDIR;
    const checks = [];
    for (const [startup, expectedDecisions, expectedContents] of [
      [null, ['deny', 'deny'], ['BEFORE\n', 'BEFORE\n']],
      [`export PATH=${bin}:$PATH\n`, ['deny', 'deny'], ['AFTER\n', 'BEFORE\n']],
      [`function /usr/bin/sort() { printf 'AFTER\\n' > '${output}'; }\n`, ['deny', 'deny'], ['BEFORE\n', 'AFTER\n']],
    ]) {
      if (startup !== null) writeFileSync(join(zdot, '.zshenv'), startup);
      for (const [index, program] of ['sort', '/usr/bin/sort'].entries()) {
        const command = `cd ${runtime}; ${program} -o ${safe} ${input}`;
        for (const inherited of [env, homeEnv]) {
          checks.push({
            actual: childDecisions(command, fixture, inherited),
            expected: [expectedDecisions[index], expectedDecisions[index]],
          });
          writeFileSync(output, 'BEFORE\n');
          const actual = spawnSync('/bin/zsh', ['-c', command], {
            env: inherited,
            cwd: fixture,
            encoding: 'utf8',
            timeout: 5000,
          });
          assert.equal(actual.status, 0, actual.stderr);
          assert.equal(readFileSync(output, 'utf8'), expectedContents[index]);
        }
      }
    }
    // All actual fixture executions finish before comparing guard decisions.
    for (const check of checks) assert.deepEqual(check.actual, check.expected);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function childDecisions(command, cwd, env) {
  const guardUrl = new URL('../../../scripts/native-effect-target-guard.mjs', import.meta.url).href;
  const payloads = [
    { tool_name: 'Bash', cwd, tool_input: { command } },
    { tool_name: 'exec_command', cwd, turn_id: 'startup-env', tool_input: { cmd: command } },
  ];
  const code = `import {decideNativeHookPayload as d} from ${JSON.stringify(guardUrl)};\nconsole.log(JSON.stringify(${JSON.stringify(payloads)}.map(p=>d(p,{selfHost:()=>({confidence:'none'})}).decision)));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('opaque startup does not become a blanket denial of ordinary work or reads', () => {
  const zdot = join(root, 'opaque-startup');
  mkdirSync(zdot);
  writeFileSync(join(zdot, '.zshenv'), 'source /tmp/unparsed-startup\n');
  const env = { ...standardEnv, ZDOTDIR: zdot };
  const write = `/usr/bin/sort -o ${root}/safe ${root}/input`;
  assert.deepEqual(childDecisions(write, runtime, env), ['deny', 'deny']);
  assert.deepEqual(childDecisions(write, root, env), ['allow', 'allow']);
  assert.deepEqual(childDecisions(`sort -- ${runtime}/*.log`, runtime, env), ['allow', 'allow']);
  assert.deepEqual(childDecisions(`sed -n '1,5p' ${runtime}/*.log`, runtime, env), ['allow', 'allow']);
});

test('default login execution cannot use the pre-profile PATH as a program certificate', requiresZsh, () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'f306-login-identity-')));
  try {
    const runtime = join(fixture, 'projects/relay-station/cat-cafe-runtime');
    const bin = join(fixture, 'bin'),
      zdot = join(fixture, 'zdot');
    mkdirSync(runtime, { recursive: true });
    mkdirSync(bin);
    mkdirSync(zdot);
    const output = join(runtime, 'out'),
      input = join(fixture, 'input'),
      safe = join(fixture, 'safe');
    writeFileSync(input, 'b\na\n');
    writeFileSync(join(bin, 'sort'), `#!/bin/sh\nprintf 'AFTER\\n' > '${output}'\n`, { mode: 0o700 });
    const env = { ...process.env, PATH: '/usr/bin:/bin', ZDOTDIR: zdot };
    const checks = [];
    for (const filename of ['.zprofile', '.zlogin']) {
      writeFileSync(join(zdot, filename), `export PATH=${bin}:$PATH\n`);
      const command = `cd ${runtime}; sort -o ${safe} ${input}`;
      checks.push(childDecisions(command, fixture, env));
      writeFileSync(output, 'BEFORE\n');
      const actual = spawnSync('/bin/zsh', ['-lc', command], { env, cwd: fixture, encoding: 'utf8', timeout: 5000 });
      assert.equal(actual.status, 0, actual.stderr);
      assert.equal(readFileSync(output, 'utf8'), 'AFTER\n');
      rmSync(join(zdot, filename));
    }
    // Both real startup paths are proved before either guard verdict is asserted.
    for (const actual of checks) assert.deepEqual(actual, ['deny', 'deny']);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
