import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync as removeFixture,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const { decideNativeHookPayload } = await import('../../../scripts/native-effect-target-guard.mjs');
const { shellInvocation } = await import('../../../scripts/native-effect-shell-tokenizer.mjs');
const { classifyShellSegment, splitShellExecutionSegments } = await import(
  '../../../scripts/native-effect-shell-classifier.mjs'
);

// Slice 2b (thread_muj3x2kabkbmx42l): of the 58 real denials left after #4840, 31 were
// attribution errors -- the guard picked a target the command does not act on. A command's
// targets are its operands (with the variables it bound expanded), its redirections and its
// working directory; not text it only binds, not the directory a glob's parent excludes,
// not the repository selector of `git -C`. Every case below is a corpus sample, rebuilt on
// a synthetic tree. The deny cases hold today and must keep holding.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'f306-operand-attribution-')));
after(() => removeFixture(fixtureRoot, { recursive: true, force: true }));
const station = join(fixtureRoot, 'projects', 'relay-station');
const mainRoot = join(station, 'cat-cafe');
const runtimeRoot = join(station, 'cat-cafe-runtime');
for (const directory of [mainRoot, runtimeRoot, join(station, 'cat-cafe-feature')]) {
  mkdirSync(directory, { recursive: true });
}
const stationAlias = join(fixtureRoot, 'station-alias');
symlinkSync(station, stationAlias, 'dir');

const NO_SELF_HOST = { selfHost: () => ({ confidence: 'none' }) };
function decideBoth(command, cwd) {
  const claude = decideNativeHookPayload({ tool_name: 'Bash', cwd, tool_input: { command } }, NO_SELF_HOST);
  const codex = decideNativeHookPayload(
    { turn_id: 'turn-2b', tool_name: 'exec_command', cwd, tool_input: { cmd: command } },
    NO_SELF_HOST,
  );
  assert.equal(claude.decision, codex.decision, `providers disagree on: ${command}`);
  return claude;
}
function expect(decision, command, cwd = mainRoot) {
  const result = decideBoth(command, cwd);
  assert.equal(
    result.decision,
    decision,
    `expected ${decision}: ${command}\n→ ${result.reasonCode} (${result.effect} → ${result.target.kind})`,
  );
}

describe('F306 final attribution: metadata is data; known writes have a positive effect', () => {
  test('unsupported execution syntax is not evidence of a read', () => {
    for (const tail of ['<', '"unfinished', '"$(printf x)"', '`printf x`', '$OPTIONS', '<(printf x)', '<<EOF']) {
      for (const program of ['sort', 'sed', 'gsed', 'redis-cli -p 6399']) {
        const command = `${program} ${tail}`;
        assert.equal(shellInvocation(command).complete, false, command);
        assert.equal(classifyShellSegment(command), 'unknown', command);
      }
    }
    for (const command of ['sort {fd}>/tmp/file', 'sort < # missing target']) {
      assert.equal(shellInvocation(command).complete, false, command);
    }
    for (const prefix of [String.raw`printf \>`, `printf '>'`, 'printf ">"']) {
      assert.deepEqual(splitShellExecutionSegments(`${prefix}| cat`), [prefix, 'cat']);
      assert.deepEqual(splitShellExecutionSegments(`${prefix}& cat`), [prefix, 'cat']);
    }
  });

  test('literal argv across redirects agrees with real shells; only the probe executes', () => {
    const input = join(fixtureRoot, 'input');
    const output = join(fixtureRoot, 'output');
    writeFileSync(input, 'input\n');
    const args = ['probe', '--body', "'text > < ; $()'", '--title', 'a\\>b', '"back\\slash"'];
    const redirects = [
      `<'${input}'`,
      `0< '${input}'`,
      `>'${output}'`,
      `2>>'${output}'`,
      `<> '${output}'`,
      `>|'${output}'`,
      '2>&1',
      '0<&0',
      `&>'${output}'`,
    ];
    for (const shell of ['/bin/bash', '/bin/zsh'].filter(existsSync)) {
      for (const redirect of redirects) {
        for (let at = 0; at <= args.length; at += 1) {
          const command = [...args.slice(0, at), redirect, ...args.slice(at)].join(' ');
          const parsed = shellInvocation(command);
          assert.equal(parsed.complete, true, command);
          assert.equal(parsed.redirections.length, 1, command);
          const result = spawnSync(shell, ['-c', `probe() { printf '%s\\0' "$@" >&3; }; exec 3>&1; ${command}`], {
            encoding: 'utf8',
            timeout: 5000,
          });
          assert.equal(result.status, 0, `${shell}: ${command}\n${result.stderr}`);
          assert.deepEqual(
            parsed.words.slice(1).map((word) => word.value),
            result.stdout.split('\0').slice(0, -1),
            command,
          );
        }
      }
    }
  });

  test('redirects anywhere in sort argv cannot hide its output option', () => {
    for (const command of [
      `sort < /tmp/in -o ${runtimeRoot}/file`,
      `sort </tmp/in --output=${runtimeRoot}/file`,
      `< /tmp/in sort -o ${runtimeRoot}/file`,
      `sort -o < /tmp/in ${runtimeRoot}/file`,
    ]) {
      const result = decideBoth(command, mainRoot);
      assert.equal(result.decision, 'deny', command);
      assert.equal(result.effect, 'write', command);
    }
    expect('allow', `sort < /tmp/in ${runtimeRoot}/file`);
    expect('allow', `< /tmp/in sort ${runtimeRoot}/file`);
  });

  test('Redis data words never become the subcommand across redirections', () => {
    for (const command of [
      'redis-cli < /tmp/in -p 6399 SET key GET',
      'redis-cli < /tmp/in -p 6399 HSET key GET value',
      '< /tmp/in redis-cli -p 6399 SET key GET',
      'redis-cli -p < /tmp/in 6399 SET key GET',
    ]) {
      const result = decideBoth(command, mainRoot);
      assert.equal(result.decision, 'deny', command);
      assert.equal(result.effect, 'service_mutation', command);
    }
    expect('allow', 'redis-cli < /tmp/in -p 6399 GET HSET');
    for (const command of ['UNKNOWN GET', '--unknown GET', 'UNKNOWN "$(printf GET)"']) {
      const result = decideBoth(`redis-cli -p 6399 ${command}`, mainRoot);
      assert.equal(result.decision, 'deny', command);
      assert.equal(result.effect, 'unknown', command);
    }
  });

  test('message masking preserves redirections between options and their data', () => {
    for (const redirect of ['> /tmp/log', '2>/tmp/log', '< /tmp/in', '>| /tmp/log', '&>/tmp/log', '0<&0']) {
      expect('allow', `gh pr create --title x ${redirect} --body '${runtimeRoot}'`);
      expect('allow', `gh pr create --body ${redirect} '${runtimeRoot}'`);
      expect('deny', `gh pr create ${redirect} --body-file ${runtimeRoot}/body`);
      expect('deny', `gh pr create ${redirect} -- --body ${runtimeRoot}/operand`);
      expect('deny', `gh pr create ${redirect} --body "$(rm -rf ${runtimeRoot})"`);
    }
    expect('deny', `gh pr create --body > ${runtimeRoot}/out 'harmless text'`);
    expect('deny', `gh pr create --body < ${runtimeRoot}/input 'harmless text'`);
    expect('allow', `> /tmp/log gh pr create --body '${runtimeRoot}'`);
  });

  test('PR title/body literals name no local resource', () => {
    for (const option of ['--title', '--title=', '-t', '-t=', '--body', '--body=', '-b', '-b=']) {
      const joiner = option.endsWith('=') ? '' : ' ';
      expect(
        'allow',
        `gh pr create --repo owner/repo ${option}${joiner}'redis-cli -p 6399 HSET x y z; ${runtimeRoot}'`,
      );
    }
    expect('allow', `gh pr edit 42 --title 'runtime ${runtimeRoot}' --body 'redis-cli 6399'`);
    expect('allow', `gh pr comment 42 --body 'redis-cli 6399 ${runtimeRoot}'`);
    expect('allow', `gh issue create --title '6399 redis' --body '${runtimeRoot}'`);
    expect('allow', `gh pr create -t'6399 redis' -b'${runtimeRoot}'`);
    expect('allow', `gh pr create -Rowner/repo -t'6399 redis' -b'${runtimeRoot}'`);
  });

  test('message input files, actual substitutions and output redirections stay visible', () => {
    expect('deny', `gh pr create --body-file ${runtimeRoot}/body.md`);
    expect('deny', `gh pr create --template ${runtimeRoot}/template.md`);
    expect('deny', `gh pr create --body '${runtimeRoot}' > ${runtimeRoot}/out`);
    expect('deny', `gh pr create --body "$(rm -rf ${runtimeRoot})"`);
    expect('deny', `gh pr create -- --body ${runtimeRoot}/operand`);
    expect('deny', `gh pr create --unknown-option --body ${runtimeRoot}/operand`);
    expect('deny', `gh pr create --body-file --title ${runtimeRoot}/operand`);
  });

  test('Redis program and command determine a service mutation, not words in its arguments', () => {
    for (const command of ['HSET x y z', 'HDEL x y', 'EVAL "return 1" 0', 'EVALSHA deadbeef 0']) {
      const result = decideBoth(`redis-cli -p 6399 ${command}`, mainRoot);
      assert.equal(result.decision, 'deny');
      assert.equal(result.effect, 'service_mutation');
      assert.equal(result.reasonCode, 'redis_sanctuary_mutation');
    }
    expect('allow', "printf '%s' 'redis-cli -p 6399 HSET x y z'");
    expect('allow', "redis-cli -p 6399 GET 'HSET'");
    // Removing the unknown fallback is not part of this correction.
    const unknown = decideBoth('redis-cli -p 6399 UNKNOWN_COMMAND x', mainRoot);
    assert.equal(unknown.reasonCode, 'protected_target_unparsed');
  });

  test('in-place editors, output options and read-write redirection identify writes', () => {
    for (const command of [
      `sed -i '' 's/x/y/' ${runtimeRoot}/file`,
      `sed -ni.bak 's/x/y/' ${runtimeRoot}/file`,
      `sed --in-place=.bak 's/x/y/' ${runtimeRoot}/file`,
      `sed < /tmp/in -i '' 's/x/y/' ${runtimeRoot}/file`,
      `sed -e < /tmp/in 's/x/y/' -i '' ${runtimeRoot}/file`,
      `sort -o ${runtimeRoot}/file /tmp/input`,
      `sort --output=${runtimeRoot}/file /tmp/input`,
      `: <> ${runtimeRoot}/file`,
    ]) {
      const result = decideBoth(command, mainRoot);
      assert.equal(result.decision, 'deny');
      assert.equal(result.effect, 'write', command);
      assert.equal(result.reasonCode, 'runtime_sanctuary_mutation');
    }
    expect('allow', `sed -e 's/-i/x/' ${runtimeRoot}/file`);
    expect('allow', `sort -- -output ${runtimeRoot}/file`);
    expect('allow', `printf '%s' '<> ${runtimeRoot}/file'`);
    expect('allow', `printf '%s' \\>\\<${runtimeRoot}/file`);
    expect('deny', `printf 'rm -rf ${runtimeRoot}' | sh`);
  });
});

describe('F306 slice 2b: a variable a command binds is not an action; its value is an operand', () => {
  test('binding the runtime path and reading through it is a read', () => {
    expect('allow', `R=${runtimeRoot}; cat "$R/x"`);
    expect('allow', `U=${runtimeRoot}/uploads; ls -la $U | head -5`);
    expect('allow', `for f in ${runtimeRoot}/.env ${mainRoot}/.env; do [ -f "$f" ] && echo "$f"; done`);
  });

  test('destroying the runtime through a variable is still destroying the runtime', () => {
    expect('deny', `R=${runtimeRoot}; rm -rf "$R"`);
    expect('deny', `R=${runtimeRoot} && rm -rf "\${R}"`);
    expect('deny', `for d in ${runtimeRoot}; do rm -rf "$d"; done`);
    // A substitution in a binding runs.
    expect('deny', `R=$(rm -rf ${runtimeRoot}); echo "$R"`);
    expect('deny', `for d in $(rm -rf ${runtimeRoot}); do echo "$d"; done`);
    expect('deny', `D=..; rm -rf "$D"/*`);
  });

  test('single quotes and child scopes do not create outer operands', () => {
    expect('allow', `R=${runtimeRoot}; rm -f '$R'`);
    expect('allow', `R=/tmp/ordinary; (R=${runtimeRoot}; cat "$R/x"); rm -f "$R/x"`);
    expect('allow', `R=/tmp/ordinary; false && R=${runtimeRoot}; rm -f "$R/x"`);
  });
});

describe('F306 slice 2b: a glob selects only below its own parent', () => {
  test('a glob under /tmp or a relative feature path cannot select the runtime', () => {
    expect('allow', `cp /tmp/x/* ${mainRoot}/docs/y/`);
    expect('allow', `D=docs/research/x && rm -f "$D"/reports/*`);
    expect('allow', `rm -f docs/cat-cafe-fixture/reports/*`);
  });

  test('a glob whose parent holds the runtime still selects it', () => {
    expect('deny', `rm -rf ${station}/*`);
    expect('deny', `rm -rf ../*`);
    expect('deny', `rm -rf ${station}/cat-cafe-*`);
  });

  test('bare and dotted globs share the physical parent; unrelated parents stay ordinary', () => {
    for (const pattern of [
      'cat-cafe-*',
      'cat-cafe-runtime*',
      './cat-cafe-*',
      './cat-cafe-runtime*',
      'cat-cafe-runtim[e]',
    ]) {
      for (const cwd of [station, stationAlias]) expect('deny', `rm -rf ${pattern}`, cwd);
    }
    expect('allow', 'rm -rf /tmp/cat-cafe-*', station);
    expect('allow', 'rm -rf /tmp/cat-cafe-*', mainRoot);
  });
});

describe('F306 slice 2b: an absolute write target is not the working directory', () => {
  test('writing to /tmp from inside the runtime writes to /tmp', () => {
    expect('allow', `mkdir -p /tmp/probe && cd /tmp/probe && echo hi > x`, runtimeRoot);
  });

  test('a relative write inside the runtime is a write into the runtime', () => {
    expect('deny', `mkdir -p newdir`, runtimeRoot);
    expect('deny', `echo x > file`, runtimeRoot);
  });
});

describe('F306 slice 2b: `git -C` selects a repository; the operation names the target', () => {
  test('removing a sibling worktree or a feature ref from the main repository', () => {
    expect('allow', `git -C ${mainRoot} worktree remove --force ${station}/cat-cafe-feature && echo removed`, mainRoot);
    expect('allow', `git -C ${mainRoot} update-ref -d refs/heads/chore/x`, station);
    expect('allow', `git -C ${mainRoot} branch -d chore/x 2>&1`, station);
    // An identified removal with no resolved operand cannot become an ordinary-target allow.
    expect('deny', `M=${mainRoot}; git -C "$M" worktree remove "$UNRESOLVED" 2>/tmp/err`);
  });

  test('an absolute executable has the same read effect as its command name', () => {
    expect('allow', `/bin/ls -lt ${runtimeRoot}`, runtimeRoot);
    // A checkout-local executable still names its actual protected path.
    expect('deny', `${runtimeRoot}/custom-helper`);
  });

  test('protected targets named by the operation stay protected', () => {
    expect('deny', `git -C ${mainRoot} branch -D main`, station);
    expect('deny', `git -C ${mainRoot} reset --hard origin/main`, station);
    expect('deny', `git -C ${mainRoot} worktree remove ${runtimeRoot}`, station);
    expect('deny', `git -C ${mainRoot} update-ref -d refs/heads/main`, station);
  });
});

describe('F306 slice 2b: code in an argument is source, not operands (codex-astra ruling)', () => {
  test('`python3 -c`, `node -e` and `perl -e` source names no target', () => {
    expect('allow', `python3 -c "print(open('${runtimeRoot}/x.json').read())"`);
    expect('allow', `node -e 'console.log(require("${runtimeRoot}/x.json"))'`);
    expect('allow', `perl -0pi -e 's/redis-cli -p 6399 shutdown/x/' test/a.test.js`);
  });

  test('value-taking interpreter options do not hide a later code argument', () => {
    for (const option of ['-r /tmp/init.js', '--require /tmp/init.js', '--require=/tmp/init.js']) {
      expect('allow', `node ${option} -e "console.log('${runtimeRoot}')"`);
    }
    for (const option of ['-X dev', '-Xdev', '-W default', '-Wdefault']) {
      expect('allow', `python3 ${option} -c "print('${runtimeRoot}')"`);
    }
  });

  test('preload paths, script paths and redirections retain their real targets', () => {
    expect('deny', `node -r ${runtimeRoot}/init.js -e 'console.log(1)'`);
    expect('deny', `node --require=${runtimeRoot}/init.js -e 'console.log(1)'`);
    expect('deny', `python3 -X dev ${runtimeRoot}/script.py`);
    expect('deny', `python3 -X dev -c 'print(1)' > ${runtimeRoot}/out`);
    expect('allow', `node -r /tmp/init.js -e "console.log('${runtimeRoot}')" > /tmp/out`);
    expect('deny', `node -r /tmp/init.js -e "console.log('${runtimeRoot}')" > ${runtimeRoot}/out`);
    // Python -c terminates its option list; a later '-c' is a program argument.
    expect('deny', `python3 -c 'print(1)' -c ${runtimeRoot}/actual-argument`);
    expect('deny', `node -- -e ${runtimeRoot}/actual-script`);
  });

  test('`sh -c` / `bash -c` carry shell commands, judged as shell', () => {
    expect('deny', `bash -c "rm -rf ${runtimeRoot}"`);
    expect('deny', `sh -c 'cd ${runtimeRoot} && git reset --hard'`);
  });

  test('the interpreter still acts where it runs and where it writes', () => {
    expect('deny', `python3 -c "print(1)"`, runtimeRoot);
    expect('deny', `perl -pi -e 's/a/b/' ${runtimeRoot}/x.txt`);
  });
});
