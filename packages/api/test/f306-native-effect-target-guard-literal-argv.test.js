import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { sedScriptEffect } from '../../../scripts/native-effect-sed-classifier.mjs';
import { expandSegmentBindings, FORGOTTEN } from '../../../scripts/native-effect-shell-expansion.mjs';
import { shellInvocation } from '../../../scripts/native-effect-shell-tokenizer.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-literal-argv-')));
after(() => rmSync(root, { recursive: true, force: true }));
const main = join(root, 'projects/relay-station/cat-cafe');
const runtime = join(root, 'projects/relay-station/cat-cafe-runtime');
for (const path of [main, runtime]) mkdirSync(path, { recursive: true });
const noHost = { selfHost: () => ({ confidence: 'none' }) };

function expect(decision, command) {
  for (const payload of [
    { tool_name: 'Bash', cwd: main, tool_input: { command } },
    { turn_id: 'literal-argv', tool_name: 'exec_command', cwd: main, tool_input: { cmd: command } },
  ]) {
    const result = decideNativeHookPayload(payload, noHost);
    assert.equal(result.decision, decision, `${command}\n${result.reasonCode} (${result.effect})`);
  }
}

test('sed script effects and script-file uncertainty are independent of file globbing', () => {
  for (const script of ['1,5p', '/write/p', 's/hello/world/g', 's#e#w#g', '1,5{p;d;}', 's/[w/e]/read/g']) {
    expect('allow', `sed -n -e '${script}' ${runtime}/*.log`);
  }
  for (const option of [
    `-e 'w ${runtime}/out'`,
    `'w ${runtime}/out'`,
    `-ne'w ${runtime}/out'`,
    `--expression='w ${runtime}/out'`,
    `-e 's/a/b/w ${runtime}/out'`,
    `-e 'e printf x'`,
    `-e 's/a/b/e'`,
    `-f /tmp/payload.sed`,
    `-nf/tmp/payload.sed`,
    `--file=/tmp/payload.sed`,
    `-e 'p' -f /tmp/payload.sed`,
    `-e 'p' -e 'W ${runtime}/out'`,
    `--expr='s/a/b/e'`,
    `--f=/tmp/payload.sed`,
    `-e '/[a/w]/w ${runtime}/out'`,
    `-e 's/[a/w]/b/w ${runtime}/out'`,
  ])
    expect('deny', `sed -n ${option} ${runtime}/*.log`);
  expect('allow', `sed -n ${runtime}/*.log -e 'p'`);
  expect('allow', `sed -n -ep -e 's/a/b/' ${runtime}/*.log`);
});

test('sort scratch directories write and compression programs are not certified reads', () => {
  for (const option of [
    `-T ${runtime}`,
    `-nT${runtime}`,
    `--temporary-directory=${runtime}`,
    `--temp=${runtime}`,
    '--compress-program=/tmp/payload',
    '--compress-program /tmp/payload',
    '--comp=/tmp/payload',
  ])
    expect('deny', `sort ${option} ${runtime}/*.log`);
  expect('allow', `sort -- ${runtime}/*.log`);
  expect('allow', `sort -k1,2 -t: ${runtime}/*.log`);
});

test('sed command boundaries distinguish script data from following effects', () => {
  for (const script of [
    '# w /tmp/unused\np',
    'a\\\nw /tmp/unused',
    's#w#e#g',
    '/[w/e]/p',
    's/[[:alpha:]/]/e/g',
    'y/ew/we/',
    'p;q',
    ':next;p;b next',
  ])
    assert.equal(sedScriptEffect(script), 'read', script);
  for (const script of [
    'p\ne printf x',
    's/a/b/e',
    '/a/{p;e printf x\n}',
    'p;w /tmp/unused',
    'a\\\ntext\nw /tmp/unused',
    'r /dev/null\nw /tmp/unused',
    '# read\nw /tmp/unused',
    's/[a/w]/b/w /tmp/unused',
  ])
    assert.notEqual(sedScriptEffect(script), 'read', script);
});

test('real sed only certifies reads when synthetic sentinel writes remain absent', () => {
  // These programs only read fixed text and optionally write a test-owned file.
  // No shell/command execution, external scripts, runtime data or services.
  const forms = [
    ['p', false],
    ['s/[w/e]/read/g', false],
    ['/[w/e]/p', false],
    ['a\\\nw SENTINEL', false],
    ['# w SENTINEL\np', false],
    ['w SENTINEL', true],
    ['1,2w SENTINEL', true],
    ['/[a/w]/w SENTINEL', true],
    ['s/[a/w]/b/w SENTINEL', true],
    [':label\nw SENTINEL', true],
    ['a\\\ntext\nw SENTINEL', true],
    ['r /dev/null\nw SENTINEL', true],
    ['1{\np\nw SENTINEL\n}', true],
  ];
  for (const delimiter of ['/', '#', '|', ':', '@']) {
    forms.push([`s${delimiter}[a${delimiter}w]${delimiter}e${delimiter}g`, false]);
    forms.push([`s${delimiter}[a${delimiter}w]${delimiter}e${delimiter}w SENTINEL`, true]);
  }
  for (const [index, [form, writes]] of forms.entries()) {
    const output = join(root, `sed-sentinel-${index}`);
    const script = form.replaceAll('SENTINEL', output);
    const result = spawnSync('/usr/bin/sed', ['-n', '-e', script], {
      input: 'a/w\n',
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${script}\n${result.stderr}`);
    assert.equal(existsSync(output), writes, script);
    assert.equal(sedScriptEffect(script), writes ? 'write' : 'read', script);
  }
});

test('known read roles survive filename expansion and comments without an argv certificate', () => {
  for (const command of [
    `sort -- ${runtime}/*.log`,
    `sort ${runtime}/*.log`,
    `sed -n '1,5p' ${runtime}/*.log`,
    `sed -n -e '1,5p' ${runtime}/*.log`,
    `sort -- ${runtime}/a.log # inspect`,
    `sort -- ${runtime}/a.log # ; rm -rf /; > ${runtime}/out`,
  ])
    expect('allow', command);
  for (const command of [
    `sort ${runtime}/*.log -o ${runtime}/out`,
    `sort --compress-program -- -o ${runtime}/out`,
    `sort --comp -- -o ${runtime}/out`,
    `sort -{r,o} ${runtime}/out`,
    `sort -* ${runtime}/out`,
    `sed -n '1,5p' ${runtime}/*.log -i.bak`,
    `sort -- ${runtime}/*.log > ${runtime}/out`,
    `sort -- ${runtime}/*.log "$(rm -rf ${runtime})"`,
    `sort -- ${runtime}/a.log # inspect\nrm -rf ${runtime}`,
    `echo \`echo x # inner comment\`; rm -rf ${runtime}`,
    `echo "$(echo x # inner comment\n)"; rm -rf ${runtime}`,
  ])
    expect('deny', command);
});

test('the reported glob/comment reads run under both shells and do not modify their fixtures', () => {
  const file = join(runtime, 'a.log');
  writeFileSync(file, 'bravo\nalpha\n');
  const commands = [`sort -- ${runtime}/*.log`, `sed -n '1,5p' ${runtime}/*.log`, `sort -- ${file} # inspect`];
  for (const shell of ['/bin/bash', '/bin/zsh'].filter(existsSync)) {
    for (const command of commands) {
      const result = spawnSync(shell, ['-c', command], { cwd: main, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, command.startsWith('sort') ? 'alpha\nbravo\n' : 'bravo\nalpha\n');
      assert.equal(readFileSync(file, 'utf8'), 'bravo\nalpha\n');
    }
  }
});

test('brace expansion cannot hide real GH file options inside a body word', () => {
  for (const option of ['--body-file', '--template']) {
    const command = `gh pr create --body {safe,${option}=${runtime}/body.md}`;
    expect('deny', command);
    assert.equal(shellInvocation(command).complete, false);
  }
});

test('option-position brace and pathname expansions cannot certify sort as read-only', () => {
  for (const option of ['-{r,o}', '-*', '-?', '-[or]']) {
    const command = `sort ${option} ${runtime}/file`;
    expect('deny', command);
    assert.equal(shellInvocation(command).complete, false, command);
  }
  expect('deny', `gh pr create --body ${runtime}/*`);
});

test('quoting and escaping keep JSON, brace text and wildcard characters literal', () => {
  for (const value of [
    `'{safe,--body-file=${runtime}/body.md}'`,
    `"{safe,--template=${runtime}/body.md}"`,
    `' {"path":"${runtime}","pattern":"*?[x]"} '`,
    `\\{safe,--body-file=${runtime}/body.md\\}`,
    `pre"{safe,--body-file=${runtime}/body.md}"post`,
    `'${runtime}/*?[x]'`,
  ]) {
    const command = `gh pr create --body ${value}`;
    assert.equal(shellInvocation(command).complete, true, command);
    expect('allow', command);
  }
});

test('unquoted expansions in adjacent pieces, redirects and command words stay incomplete', () => {
  for (const command of [
    'probe "prefix"{a,b}',
    'probe "prefix"*',
    'pro?e x',
    'probe > /tmp/*',
    'probe {1..3}',
    'probe {a,{b,c}}',
    'probe ~/file',
    'probe =cat',
    'probe $VALUE',
    'probe "$VALUE"',
    'probe $(printf x)',
    'probe `printf x`',
  ])
    assert.equal(shellInvocation(command).complete, false, command);
});

test('known variables cannot turn shell field splitting into a quoted data word', () => {
  expect('deny', `B='safe --body-file=${runtime}/body.md'; gh pr create --body $B`);
  expect('allow', `B='safe --body-file=${runtime}/body.md'; gh pr create --body "$B"`);
  expect('deny', `for B in 'safe --body-file=${runtime}/body.md'; do gh pr create --body $B; done`);
  expect('deny', `B='-r -o'; sort $B ${runtime}/file`);
  expect('deny', `B='-r:-o'; IFS=:; sort $B ${runtime}/file`);
  expect('allow', `B='-r -o'; sort "$B" ${runtime}/file`);
  // Uncertainty about argv never downgrades a recognised dangerous root operation.
  expect('deny', `R='/ /tmp/probe'; rm -rf $R`);
  const forgotten = new Map([
    [FORGOTTEN, null],
    ['B', ['abc']],
  ]);
  assert.equal(expandSegmentBindings('probe $B', forgotten)[0].argvPreserved, false);
  assert.equal(expandSegmentBindings('probe "$B"', forgotten)[0].argvPreserved, true);
});

test('parameter values are not rescanned for comments or tilde/brace syntax', () => {
  for (const leaf of ['a#note', '~note']) {
    const value = `${runtime}/${leaf}`;
    expect('allow', `B='${value}'; gh pr create --body $B`);
    const bindings = new Map([['B', [value]]]);
    assert.equal(expandSegmentBindings('probe $B', bindings)[0].argvPreserved, true);
    for (const shell of ['/bin/bash', '/bin/zsh'].filter(existsSync)) {
      const result = spawnSync(shell, ['-c', `B='${value}'; printf '<%s>' $B`], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `<${value}>`);
    }
  }
});

test('real shells expand braces and globs; probe prints argv without executing its arguments', () => {
  writeFileSync(join(main, '-o'), '');
  const cases = [
    ['--body {safe,--body-file=/tmp/body}', ['--body', 'safe', '--body-file=/tmp/body']],
    ['-{r,o} /tmp/output', ['-r', '-o', '/tmp/output']],
    ['-* /tmp/output', ['-o', '/tmp/output']],
    ['-? /tmp/output', ['-o', '/tmp/output']],
    ['-[or] /tmp/output', ['-o', '/tmp/output']],
    ['"{safe,unsafe}"', ['{safe,unsafe}']],
    [String.raw`\{safe,unsafe\}`, ['{safe,unsafe}']],
    ['"*?[or]"', ['*?[or]']],
    ['$B', ['safe', '--body-file=/tmp/body']],
    ['"$B"', ['safe --body-file=/tmp/body']],
  ];
  for (const shell of ['/bin/bash', '/bin/zsh'].filter(existsSync)) {
    for (const [args, expected] of cases) {
      // bash word-splits scalar parameters by default; zsh does so with SH_WORD_SPLIT.
      const mode = shell.endsWith('zsh') ? 'setopt SH_WORD_SPLIT; ' : '';
      const result = spawnSync(
        shell,
        ['-c', `${mode}B='safe --body-file=/tmp/body'; probe() { printf '%s\\0' "$@"; }; probe ${args}`],
        { cwd: main, encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.split('\0').slice(0, -1), expected, `${shell}: ${args}`);
    }
  }
});

test('every certified generated literal argv agrees with both real shells', () => {
  const pieces = [
    'word',
    "''",
    '""',
    String.raw`a\ b`,
    "'{a,b}'",
    '"*?[x]"',
    String.raw`\{a,b\}`,
    String.raw`"a\q"`,
    '{a,b}',
    '*',
    '[x]',
    '$B',
  ];
  const commands = ['probe \\\n literal'];
  for (const left of pieces) for (const right of pieces) commands.push(`probe ${left}${right} tail`);
  for (const shell of ['/bin/bash', '/bin/zsh'].filter(existsSync)) {
    let certified = 0;
    for (const command of commands) {
      const parsed = shellInvocation(command);
      if (!parsed.complete) continue;
      certified += 1;
      const result = spawnSync(shell, ['-c', `probe() { printf '%s\\0' "$@"; }; ${command}`], {
        cwd: main,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        parsed.words.slice(1).map(({ value }) => value),
        result.stdout.split('\0').slice(0, -1),
        command,
      );
    }
    assert.ok(certified >= 60, `${shell} must exercise positive certificates, not only rejection`);
  }
});
