import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { fileProgramAnalysis } from '../../../scripts/native-effect-write-effects.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-output-roles-')));
const runtime = join(root, 'cat-cafe-runtime');
const ordinary = join(root, 'ordinary');
mkdirSync(runtime);
mkdirSync(ordinary);
const input = join(ordinary, 'input');
writeFileSync(input, 'a\na\nb\n');
const alias = join(ordinary, 'alias');
symlinkSync(runtime, alias);
after(() => rmSync(root, { recursive: true, force: true }));
const noHost = { selfHost: () => ({ confidence: 'none' }) };

function decide(command, cwd = ordinary) {
  return ['Bash', 'exec_command'].map((tool_name) =>
    decideNativeHookPayload(
      {
        tool_name,
        cwd,
        tool_input: { command, cmd: command },
        ...(tool_name === 'exec_command' ? { turn_id: 'owned-output-role' } : {}),
      },
      noHost,
    ),
  );
}

const outputForms = [
  (out) => `uniq ${input} ${out}`,
  (out) => `uniq -c ${input} ${out}`,
  (out) => `uniq -f 1 -s 2 -w 3 ${input} ${out}`,
  (out) => `uniq --skip-fields=1 --check-chars 3 -- ${input} ${out}`,
  (out) => `git -C ${ordinary} log --pretty --output=${out}`,
  (out) => `git -C ${ordinary} log --format --output=${out}`,
  (out) => `git -C ${ordinary} diff -L --output=${out}`,
  ...['diff-tree', 'diff-index', 'diff-files', 'rev-list'].map(
    (subcommand) => (out) => `git -C ${ordinary} ${subcommand} HEAD --output=${out}`,
  ),
  (out) => `uniq +1 ${input} ${out}`,
  (out) => `uniq -1 ${input} ${out}`,
  (out) => `uniq --cou ${input} ${out}`,
  ...['log', 'diff', 'show'].flatMap((subcommand) => [
    (out) => `git -C ${ordinary} ${subcommand} --output=${out}`,
    (out) => `git -C ${ordinary} ${subcommand} --output ${out}`,
    (out) => `git -C ${ordinary} ${subcommand} --output=${ordinary}/first --output=${out}`,
  ]),
  ...['-fprint', '-fprint0', '-fls'].map((primary) => (out) => `find ${ordinary} ${primary} ${out}`),
  (out) => `find ${ordinary} -fprintf ${out} '%p\n'`,
  (out) => `find ${ordinary} -false -a -fprint ${out}`,
  (out) => `find ${ordinary} -fprint ${ordinary}/first -o -fprintf ${out} '%p'`,
];

test('file-output programs cannot write a protected destination through read classification', async (t) => {
  for (const form of outputForms)
    for (const cwd of [ordinary, runtime]) {
      const command = form(join(runtime, 'sentinel'));
      await t.test(`${command}:${cwd}`, () => {
        for (const result of decide(command, cwd)) {
          assert.equal(result.decision, 'deny', JSON.stringify(result));
          assert.equal(result.effect, 'write', JSON.stringify(result));
          assert.equal(result.target.kind, 'runtime_sanctuary');
        }
      });
    }
});

test('output roles preserve ordinary writes and protected-cwd conservatism', () => {
  for (const form of outputForms) {
    const command = form(join(ordinary, 'output'));
    for (const result of decide(command)) {
      assert.equal(result.decision, 'allow', `${command}:${JSON.stringify(result)}`);
      assert.equal(result.effect, 'write');
    }
    // Git -C already establishes the actual ordinary cwd; the turn cwd is not its write target.
    for (const result of decide(command, runtime))
      assert.equal(result.decision, command.startsWith('git -C ') ? 'allow' : 'deny');
    for (const result of decide(form(join(alias, 'output'))))
      assert.equal(result.decision, 'deny', `${form(join(alias, 'output'))}:${JSON.stringify(result)}`);
  }
});

test('ordinary observations and option values stay data rather than output roles', () => {
  for (const command of [
    `uniq -c ${runtime}/input`,
    `uniq --group=separate ${runtime}/input`,
    `git -C ${runtime} log --format=--output=${runtime}/text`,
    `find ${runtime} -name '-fprint' -print`,
    `find ${runtime} -printf '-fprint ${runtime}/text'`,
  ])
    for (const result of decide(command, runtime)) {
      assert.equal(result.decision, 'allow', `${command}:${JSON.stringify(result)}`);
      assert.equal(result.effect, 'read');
    }
  for (const command of [`sort -o ${runtime}/out ${input}`, `tee ${runtime}/out`, `sed -i '' p ${runtime}/input`])
    for (const result of decide(command)) assert.equal(result.decision, 'deny');
});

test('relative, expanded and ambiguous output operands cannot be credited as reads', () => {
  for (const command of [
    `uniq ${input} alias/relative`,
    `git -C ${ordinary} log --output=alias/relative`,
    `find ${ordinary} -fprint alias/relative`,
  ])
    for (const result of decide(command)) assert.equal(result.decision, 'deny', command);
  for (const command of [
    `uniq ${input} relative`,
    `git -C ${runtime} log --output=relative`,
    `find ${ordinary} -fprint relative`,
    `uniq ${input} "$DEST"`,
    'git log --output="$DEST"',
    `find ${ordinary} -fprintf "$DEST" '%p'`,
    `uniq --unknown ${input} ${runtime}/out`,
    `find ${runtime} -fprint`,
  ])
    for (const result of decide(command, runtime)) assert.equal(result.decision, 'deny', command);
});

test('one canonical file analysis supplies both effect and literal write aliases', () => {
  const out = join(ordinary, 'output');
  for (const form of outputForms) {
    const analysis = fileProgramAnalysis(form(out));
    assert.equal(analysis.effect, 'write');
    assert.ok(analysis.writes.includes(out), JSON.stringify(analysis));
  }
  assert.deepEqual(fileProgramAnalysis(`find ${ordinary} -name '-fprint' -print`).writes, []);
  assert.deepEqual(fileProgramAnalysis(`find ${ordinary} -printf '-fprint ${runtime}/text'`).writes, []);
});

test('output detection does not grant new Git observation eligibility', () => {
  for (const command of ['git --no-pager log', `git --git-dir ${runtime}/.git log`]) {
    for (const result of decide(command, runtime)) {
      assert.equal(result.decision, 'deny', command);
      assert.equal(result.effect, 'unknown');
    }
  }
});

test('native observation keeps stable revision and path syntax readable', async (t) => {
  for (const command of [
    'git diff HEAD~1',
    'git diff HEAD~1 -- file.js',
    'git diff HEAD^',
    'git diff HEAD^..HEAD',
    'git diff @{u}',
    'git diff --stat HEAD~1',
    'git log HEAD~5..HEAD --oneline',
    'git log @{u}..',
    'git log main@{1}',
    'git show HEAD~1',
    'git show HEAD~1:package.json',
    'git rev-parse HEAD~1',
    'git cat-file -p HEAD~1',
    'find . -name *.ts',
    'find ~/projects -maxdepth 1',
    'find ~ -maxdepth 1',
    'find . -name x{a,b}',
    'git diff -- *.ts',
    'git log -- "$PATH"',
  ])
    await t.test(command, () => {
      for (const result of decide(command, runtime)) {
        assert.equal(result.decision, 'allow', JSON.stringify(result));
        assert.equal(result.effect, 'read');
      }
    });
});

test('opaque option expansions still veto reads before an explicit pathspec boundary', () => {
  for (const command of [
    'git log "$FLAGS"',
    'git log HEAD$X',
    `git log $X --output=${runtime}/out`,
    'git diff *',
    'find . -name *',
    'find . -name {-fprint,out}',
  ])
    for (const result of decide(command, runtime)) {
      assert.equal(result.decision, 'deny', command);
      assert.equal(result.effect, 'unknown', command);
    }
  for (const command of [`git log --grep --output=${runtime}/out`, `git rev-parse --output=${runtime}/out`])
    for (const result of decide(command, runtime)) {
      assert.equal(result.decision, 'deny', command);
      assert.equal(result.effect, 'write', command);
    }
});

test('Git output detection cannot be hidden after a consumed literal separator', async (t) => {
  for (const subcommand of ['log', 'show'])
    for (const flag of ['-L', '--decorate-refs'])
      await t.test(`${subcommand} ${flag}`, () => {
        for (const out of [join(runtime, 'sentinel'), join(alias, 'sentinel')]) {
          const command = `git -C ${ordinary} ${subcommand} ${flag} -- --output=${out}`;
          for (const result of decide(command)) {
            assert.equal(result.decision, 'deny', JSON.stringify(result));
            assert.equal(result.effect, 'write');
            assert.equal(result.target.kind, 'runtime_sanctuary');
          }
        }
        for (const result of decide(`git -C ${ordinary} ${subcommand} ${flag} -- --output=${ordinary}/output`)) {
          assert.equal(result.decision, 'allow', JSON.stringify(result));
          assert.equal(result.effect, 'write');
        }
      });
  for (const result of decide(`git -C ${runtime} diff -- --output=${runtime}/pathspec`)) {
    assert.equal(result.decision, 'deny');
    assert.equal(result.effect, 'write');
  }
});

test('real shared hook entry refuse output syntax before an effect', () => {
  const shared = fileURLToPath(new URL('../../../scripts/native-effect-target-guard.mjs', import.meta.url));
  for (const [program, args] of [[process.execPath, [shared]]]) {
    for (const command of [
      'git diff HEAD~1',
      'git cat-file -p HEAD~1',
      'find . -name *.ts',
      'find ~/projects -maxdepth 1',
    ]) {
      const result = spawnSync(program, args, {
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
      outputForms[0],
      (out) => `git -C ${ordinary} log --pretty --output=${out}`,
      (out) => `git -C ${ordinary} log --format --output=${out}`,
      ...['log', 'show'].flatMap((subcommand) =>
        ['-L', '--decorate-refs'].map((flag) => (out) => `git -C ${ordinary} ${subcommand} ${flag} -- --output=${out}`),
      ),
      (out) => `find ${ordinary} -fprintf ${out} '%p\n'`,
    ]) {
      const result = spawnSync(program, args, {
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

test('owned OS fixtures verify that uniq and git output syntax creates files', () => {
  const output = join(ordinary, 'os-output');
  const uniq = spawnSync('/usr/bin/uniq', [input, output], { encoding: 'utf8' });
  assert.equal(uniq.status, 0, uniq.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'a\nb\n');
  const gitOutput = join(ordinary, 'git-output');
  for (const args of [
    ['init', ordinary],
    ['-C', ordinary, 'add', 'input'],
    [
      '-C',
      ordinary,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'owned fixture',
    ],
    ['-C', ordinary, 'log', '--oneline', `--output=${gitOutput}`],
  ]) {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.match(readFileSync(gitOutput, 'utf8'), /owned fixture/);
  for (const flag of ['--pretty', '--format']) {
    const file = join(ordinary, flag.slice(2));
    const result = spawnSync('git', ['-C', ordinary, 'log', flag, `--output=${file}`], { encoding: 'utf8' });
    assert.equal(result.status, flag === '--pretty' ? 0 : 128, result.stderr);
    // Git opens output before reporting an invalid bare --format; exit failure does not prove no effect.
    assert.ok(existsSync(file), flag);
  }
  for (const [index, args] of [
    ['diff', '-L'],
    ['diff-tree', 'HEAD'],
    ['diff-index', 'HEAD'],
    ['diff-files'],
    ['rev-list', 'HEAD'],
  ].entries()) {
    const file = join(ordinary, `git-family-${index}`);
    const result = spawnSync('git', ['-C', ordinary, ...args, `--output=${file}`], { encoding: 'utf8' });
    assert.ok(existsSync(file), `${JSON.stringify(args)}:exit=${result.status}:${result.stderr}`);
  }
  // The policy cases above retain legacy spellings; the installed uniq need not support them.
  // Exercise their portable equivalents when witnessing actual filesystem effects.
  for (const [index, [args, expected]] of [
    [['-s', '1'], ['a']],
    [['-f', '1'], ['a']],
    [['-c'], ['2 a', '1 b']],
  ].entries()) {
    const file = join(ordinary, `uniq-portable-${index}`);
    const result = spawnSync('/usr/bin/uniq', [...args, input, file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.trim().replace(/\s+/g, ' ')),
      expected,
    );
  }
  for (const subcommand of ['log', 'show'])
    for (const flag of ['-L', '--decorate-refs']) {
      const file = join(ordinary, `git-separator-${subcommand}-${flag}`);
      const result = spawnSync('git', ['-C', ordinary, subcommand, flag, '--', `--output=${file}`], {
        encoding: 'utf8',
      });
      assert.ok(existsSync(file), `${subcommand} ${flag}:exit=${result.status}:${result.stderr}`);
    }
});
