import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-file-targets-')));
const runtime = join(root, 'projects/relay-station/cat-cafe-runtime');
mkdirSync(runtime, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));
const noHost = { selfHost: () => ({ confidence: 'none' }) };

function expect(decision, command, cwd = root) {
  let result;
  for (const payload of [
    { tool_name: 'Bash', cwd, tool_input: { command } },
    { tool_name: 'exec_command', turn_id: 'file-targets', cwd, tool_input: { cmd: command } },
  ]) {
    const actual = decideNativeHookPayload(payload, noHost);
    assert.equal(actual.decision, decision, `${command}: ${actual.effect} / ${actual.reasonCode}`);
    result = actual;
  }
  return result;
}

test('ordinary sort output works while unproved protected-cwd writes stay denied', () => {
  for (const option of ['-T ', '-nT', '--temporary-directory=', '--temp=', '-o ', '-no', '--output=']) {
    assert.equal(expect('allow', `sort ${option}${root}/out ${root}/input`).effect, 'write');
    expect('deny', `sort ${option}${runtime}/out ${root}/input`);
    expect('deny', `sort ${option}relative ${root}/input`, runtime);
    expect('deny', `sort ${option}${root}/out ${root}/input`, runtime);
  }
  expect('allow', `sort -T ${root} -o ${root}/out ${root}/input`);
  expect('deny', `sort -T ${root} -o ${runtime}/out ${root}/input`);
  expect('deny', `sort -T ${runtime} -o ${root}/out ${root}/input`);
});

test('all literal sed writes are attributed, not just the first effect', () => {
  for (const program of ['w', 'W', 's/a/b/w']) {
    assert.equal(expect('allow', `sed -n -e '${program} ${root}/out' ${root}/input`).effect, 'write');
    expect('deny', `sed -n -e '${program} ${runtime}/out' ${root}/input`);
    expect('deny', `sed -n -e '${program} relative' ${root}/input`, runtime);
    expect('deny', `sed -n -e '${program} ${root}/out' ${root}/input`, runtime);
  }
  expect('allow', `sed -ne'w ${root}/out' -e 'w ${root}/second' ${root}/input`);
  expect('deny', `sed -ne'w ${root}/out' -e 'w ${runtime}/second' ${root}/input`);
  expect('deny', `sed -ne'w ${root}/out' -e 'w relative' ${root}/input`, runtime);
  expect('deny', `sed -ne'w ${root}/out' -e 'e printf x' ${root}/input`, runtime);
});

test('redirections, relative operands, unknown scripts and effects retain cwd', () => {
  for (const program of [`sort -T ${root}`, `sed -ne'w ${root}/out'`]) {
    expect('allow', `${program} <${root}/input >${root}/stdout 2>&1`);
    expect('deny', `${program} <${root}/input >relative`, runtime);
    expect('deny', `${program} ${root}/input >${runtime}/out`);
    expect('deny', `${program} relative`, runtime);
  }
  for (const command of [
    `sed -i '' -e 'w ${root}/out' ${root}/input`,
    `sed -f ${root}/script.sed ${root}/input`,
    `sed -e 'w ${root}/out' -f ${root}/script.sed ${root}/input`,
    `sed -e 'w ${root}/out' -e 'r relative' ${root}/input`,
    `sed -e 'w \r${root}/out' ${root}/input`,
    `sort -T ${root} --compress-program=${root}/program ${root}/input`,
    `sort -T ${root} --files0-from=${root}/list`,
    `sort -T ${root} --unknown ${root}/input`,
  ])
    expect('deny', command, runtime);
  expect('allow', `sed -n p ${root}/input >${root}/stdout`);
  expect('deny', `sed -n p ${root}/input >${runtime}/stdout`);
  expect('allow', `sort ${root}/input >${root}/stdout`);
  expect('deny', `sort ${root}/input >${runtime}/stdout`);
});

test('runtime operands and physical output aliases stay protected without executor evidence', () => {
  const alias = join(root, 'alias');
  symlinkSync(runtime, alias);
  const dangling = join(root, 'dangling');
  symlinkSync(join(runtime, 'future'), dangling);
  for (const program of [`sort -o`, `sed -n -e`]) {
    const command = (output, input) =>
      program.startsWith('sort') ? `${program} ${output} ${input}` : `${program} 'w ${output}' ${input}`;
    expect('deny', command(`${root}/out`, `${runtime}/input`));
    expect('deny', command(`${alias}/out`, `${root}/input`));
    expect('deny', command(dangling, `${root}/input`), runtime);
    expect('deny', command('/dev/fd/3', `${root}/input`), runtime);
  }
});

test('real ordinary outputs do not by themselves attest the tool execution context', () => {
  const input = join(root, 'input');
  const output = join(root, 'output');
  writeFileSync(input, 'bravo\nalpha\n');
  expect('deny', `/usr/bin/sort -T ${root} ${input}`, runtime);
  expect('deny', `/usr/bin/sed -n -e 'w ${output}' ${input}`, runtime);
  const sorted = spawnSync('/usr/bin/sort', ['-T', root, input], { cwd: runtime, encoding: 'utf8', timeout: 5000 });
  assert.equal(sorted.status, 0, sorted.stderr);
  assert.equal(sorted.stdout, 'alpha\nbravo\n');
  const written = spawnSync('/usr/bin/sed', ['-n', '-e', `w ${output}`, input], {
    cwd: runtime,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(written.status, 0, written.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'bravo\nalpha\n');
  assert.deepEqual(readdirSync(runtime), []);
});

test('a later segment cannot use the initial snapshot after an alias-producing predecessor', () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'f306-file-order-')));
  try {
    const protectedDir = join(fixture, 'projects/relay-station/cat-cafe-runtime');
    mkdirSync(protectedDir, { recursive: true });
    const output = join(protectedDir, 'out');
    const input = join(fixture, 'input');
    const link = join(fixture, 'link');
    writeFileSync(output, 'BEFORE\n');
    writeFileSync(input, 'AFTER\n');
    const makeAlias = `ln -s ${fixture}/projects/relay-station/cat-cafe-run*/out ${link}`;
    const write = `sed -n -e 'w ${link}' ${input}`;
    expect('deny', write, protectedDir);
    expect('allow', write, fixture);
    expect('deny', `cd ${protectedDir}; ${write}`, fixture);
    expect('deny', `INPUT=${input}; cd ${protectedDir}; sed -ne'w ${link}' "$INPUT"`, fixture);
    expect('deny', `sed -n p ${input}; cd ${protectedDir}; ${write}`, fixture);
    expect('deny', `sort ${fixture}/*.log; cd ${protectedDir}; ${write}`, fixture);
    for (const predecessor of [
      makeAlias,
      `node ${fixture}/unknown-program.js`,
      `${fixture}/cd`,
      `${fixture}/sed p ${input}`,
    ]) {
      for (const separator of [';', '&&', '||', '\n']) {
        expect('deny', `${predecessor}${separator} cd ${protectedDir}; ${write}`, fixture);
      }
    }
    // Only this controlled fixture chain executes. Its alias and write stay in fixture.
    const chain = `${makeAlias}; cd ${protectedDir}; ${write}`;
    const result = spawnSync('/bin/bash', ['-c', chain], { cwd: fixture, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'AFTER\n');
    // Replacing a previously ordinary leaf or parent invalidates the same proof.
    const existing = join(fixture, 'existing');
    writeFileSync(existing, 'ordinary\n');
    expect('deny', `sed -ne'w ${existing}' ${input}`, protectedDir);
    expect(
      'deny',
      `ln -sf ${fixture}/projects/relay-station/cat-cafe-run*/out ${existing}; cd ${protectedDir}; sed -ne'w ${existing}' ${input}`,
      fixture,
    );
    const directory = join(fixture, 'directory');
    mkdirSync(directory);
    expect(
      'deny',
      `mv ${directory} ${fixture}/old; ln -s ${fixture}/projects/relay-station/cat-cafe-run* ${directory}; cd ${protectedDir}; sed -ne'w ${directory}/out' ${input}`,
      fixture,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('concurrent or repeated segments cannot certify paths against a stale snapshot', () => {
  const link = join(root, 'future-link');
  const makeAlias = `ln -sf ${root}/projects/relay-station/cat-cafe-run*/out ${link}`;
  const write = `sed -ne'w ${link}' ${root}/input`;
  expect('allow', write);
  const scopedWrite = `(cd ${runtime}; ${write})`;
  expect('deny', `for x in 1 2; do ${scopedWrite}; done`, root);
  expect('deny', `${scopedWrite}; ${makeAlias}`, root);
  for (const chain of [
    `${makeAlias} | ${scopedWrite}`,
    `${scopedWrite} | ${makeAlias}`,
    `${makeAlias} & ${scopedWrite}`,
    `${scopedWrite} & ${makeAlias}`,
    `for x in 1 2; do ${scopedWrite}; ${makeAlias}; done`,
    `while true; do ${scopedWrite}; ${makeAlias}; done`,
  ])
    expect('deny', chain, root);
});

test('PATH changes cannot certify a bare program by the system programs file roles', () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'f306-program-identity-')));
  try {
    const protectedDir = join(fixture, 'projects/relay-station/cat-cafe-runtime');
    const bin = join(fixture, 'bin');
    mkdirSync(protectedDir, { recursive: true });
    mkdirSync(bin);
    const output = join(protectedDir, 'out');
    const input = join(fixture, 'input');
    const safe = join(fixture, 'safe');
    writeFileSync(output, 'BEFORE\n');
    writeFileSync(input, 'bravo\nalpha\n');
    const fake = join(bin, 'sort');
    writeFileSync(fake, `#!/bin/sh\nprintf 'AFTER\\n' > '${output}'\n`);
    chmodSync(fake, 0o700);
    const binding = `PATH=${bin}:/usr/bin:/bin`;
    const write = `sort -o ${safe} ${input}`;
    for (const assignment of [binding, `export ${binding}`]) {
      expect('deny', `${assignment}; cd ${protectedDir}; ${write}`, fixture);
      expect('deny', `${assignment}; cd ${protectedDir}; /usr/bin/sort -o ${safe} ${input}`, fixture);
      expect('deny', `${assignment}; cd ${protectedDir}; <${input} /usr/bin/sort -o ${safe}`, fixture);
    }
    expect('deny', write, protectedDir);
    expect('allow', write, fixture);
    // Real execution is confined to the fixture, proving which executable wins.
    const result = spawnSync('/bin/bash', ['-c', `${binding}; cd ${protectedDir}; ${write}`], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'AFTER\n');
    writeFileSync(output, 'BEFORE\n');
    const standard = spawnSync(
      '/bin/bash',
      ['-c', `${binding}; cd ${protectedDir}; /usr/bin/sort -o ${safe} ${input}`],
      {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.equal(standard.status, 0, standard.stderr);
    assert.equal(readFileSync(safe, 'utf8'), 'alpha\nbravo\n');
    assert.equal(readFileSync(output, 'utf8'), 'BEFORE\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('function/alias resolution and fake predecessors cannot supply program certificates', () => {
  const write = `sort -o ${root}/safe ${root}/input`;
  for (const prefix of [
    'sort() { :; };',
    'function sort { :; };',
    "alias sort='custom';",
    `hash -p ${root}/sort sort;`,
    `for PATH in ${root}/bin; do`,
  ])
    expect('deny', `${prefix} ${write}${prefix.endsWith('do') ? '; done' : ''}`, runtime);
  expect('deny', `PATH=${root}/bin; sed p ${root}/input; /usr/bin/sort -o ${root}/safe ${root}/input`, runtime);
  expect('deny', `function /usr/bin/sort() { :; }; /usr/bin/sort -o ${root}/safe ${root}/input`, runtime);
  expect('allow', `NOTE='PATH=/tmp/bin function sort'; ${write}`);
});

for (const shell of ['/bin/bash', '/bin/zsh']) {
  test(
    `shell function lookup can override an absolute executable spelling (${shell})`,
    {
      skip: !existsSync(shell) ? `${shell} is not installed` : false,
    },
    () => {
      const result = spawnSync(shell, ['-c', 'function /usr/bin/sort() { printf function-selected; }; /usr/bin/sort'], {
        input: '',
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'function-selected');
    },
  );
}

test('initial inherited PATH is not a certificate for bare executable identity', () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'f306-initial-program-')));
  try {
    const protectedDir = join(fixture, 'projects/relay-station/cat-cafe-runtime');
    const bin = join(fixture, 'bin');
    mkdirSync(protectedDir, { recursive: true });
    mkdirSync(bin);
    const input = join(fixture, 'input'),
      output = join(protectedDir, 'out'),
      safe = join(fixture, 'safe');
    writeFileSync(input, 'b\na\n');
    writeFileSync(output, 'BEFORE\n');
    const fake = join(bin, 'sort');
    writeFileSync(fake, `#!/bin/sh\nprintf 'AFTER\\n' > '${output}'\n`);
    chmodSync(fake, 0o700);
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
    const guardUrl = new URL('../../../scripts/native-effect-target-guard.mjs', import.meta.url).href;
    const checks = [];
    for (const [program, decision] of [
      ['sort', 'deny'],
      ['/usr/bin/sort', 'deny'],
    ]) {
      const command = `cd ${protectedDir}; ${program} -o ${safe} ${input}`;
      const payloads = [
        { tool_name: 'Bash', cwd: fixture, tool_input: { command } },
        { tool_name: 'exec_command', turn_id: 'initial-path', cwd: fixture, tool_input: { cmd: command } },
      ];
      const code = `import {decideNativeHookPayload as d} from ${JSON.stringify(guardUrl)};\nconsole.log(JSON.stringify(${JSON.stringify(payloads)}.map(p=>d(p,{selfHost:()=>({confidence:'none'})}).decision)));`;
      const verdict = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(verdict.status, 0, verdict.stderr);
      checks.push({ program, actual: JSON.parse(verdict.stdout), expected: [decision, decision] });
      writeFileSync(output, 'BEFORE\n');
      const actual = spawnSync('/bin/bash', ['-c', command], { env, cwd: fixture, encoding: 'utf8', timeout: 5000 });
      assert.equal(actual.status, 0, actual.stderr);
      assert.equal(readFileSync(output, 'utf8'), program === 'sort' ? 'AFTER\n' : 'BEFORE\n');
    }
    assert.equal(readFileSync(safe, 'utf8'), 'a\nb\n');
    for (const check of checks) assert.deepEqual(check.actual, check.expected, check.program);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
