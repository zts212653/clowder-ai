import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { assertGuardedOrUnproved } from './helpers/native-effect-policy-assertions.js';
import { gateHookProgram, nativeHookPrograms, nativeHookTestEnv } from './helpers/native-hook-programs.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-friction-')));
const main = join(root, 'cat-cafe'),
  runtime = join(root, 'cat-cafe-runtime');
mkdirSync(main);
mkdirSync(runtime);
after(() => rmSync(root, { recursive: true, force: true }));
const noHost = { selfHost: () => ({ confidence: 'none' }) };
function parity(command, expected, cwd = runtime) {
  for (const tool_name of ['Bash', 'exec_command']) {
    const result = decideNativeHookPayload({ tool_name, cwd, tool_input: { command, cmd: command } }, noHost);
    if (expected === 'deny') assertGuardedOrUnproved(result, `${command}: ${JSON.stringify(result)}`);
    else assert.equal(result.decision, expected, `${command}: ${JSON.stringify(result)}`);
  }
}

// Sonnet source 0001790869173913-003298-84d04e2c: option and launcher families.
test('Git read options cannot abbreviate or cluster external-command features', () => {
  for (const command of [
    'git grep -nOtouch a',
    "git grep '-n'O'touch' a",
    'git grep --open=touch a',
    'git grep --open-files-in-p=x a',
    'git cat-file --textc -p HEAD',
  ])
    parity(command, 'deny');
  for (const command of [
    'git grep -n -e kill -- docs',
    'git grep -nA2 kill HEAD -- docs',
    'git cat-file -p HEAD:package.json',
  ])
    parity(command, 'allow');
});

test('fetch protects aliases and unresolved destinations across redirect and option shapes', () => {
  for (const suffix of ['2>&1', '2>/dev/null', '>/dev/null 2>&1', '2>&1 | tail -3'])
    parity(`git fetch origin main:main ${suffix}`, 'deny', main);
  for (const option of ['--progress', '--filter=blob:none', '-4', '--no-auto-gc', '--refetch', '--unknown-option'])
    parity(`git fetch ${option} origin +feature:refs/heads/main`, 'deny', main);
  for (const ref of ['heads/main', 'Main', 'refs/heads/Main', 'refs/heads/m*'])
    parity(`git fetch origin +feature:${ref}`, 'deny', main);
  for (const command of ['git fetch origin main 2>&1', 'git fetch --progress origin main']) parity(command, 'allow');
});

test('process launchers retain execution effects while their patterns remain data', () => {
  for (const command of [
    'find . -name x -exec kill {} +',
    'find / -name x -exec kill -9 12345 {} +',
    'xargs kill',
    'setsid kill 12345',
    'parallel kill 12345',
    'ssh host kill 12345',
    'find . -exec touch /tmp/sentinel \\;',
    "find . -exec node -e \"require('fs').writeFileSync('/tmp/sentinel','x')\" \\;",
  ])
    parity(command, 'deny');
  for (const command of ["find . -name 'kill -9' -print", 'echo xargs kill', "rg 'find -exec kill' docs"])
    parity(command, 'allow');
});

test('execution wrappers cannot hide repository rewrites', () => {
  for (const wrapper of ['env', 'command', 'nice', 'setsid']) {
    parity(`${wrapper} git push --force origin main`, 'deny', main);
    parity(`${wrapper} git fetch origin +feature:refs/heads/main`, 'deny', main);
    parity(`${wrapper} git fetch --unknown-option origin +feature:heads/Main`, 'deny', main);
  }
  parity('env git fetch origin main', 'deny');
  parity('env git fetch --progress origin main 2>&1', 'deny');
});

test('repository refresh cannot discard invocation environment prefixes', () => {
  const [program, hook, provider] = nativeHookPrograms().at(-1);
  for (const prefix of [
    "GIT_SSH_COMMAND='touch /tmp/not-executed'",
    'GIT_PROXY_COMMAND=x',
    'GIT_ASKPASS=x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.sshCommand GIT_CONFIG_VALUE_0=x',
    'env GIT_SSH_COMMAND=x',
    'FOO=1',
    'sudo -E',
  ]) {
    const command = `${prefix} git fetch origin`;
    parity(command, 'deny');
    const judged = spawnSync(program, [hook], {
      env: nativeHookTestEnv(),
      input: JSON.stringify({ tool_name: provider, cwd: runtime, tool_input: { command } }),
      encoding: 'utf8',
    });
    assert.equal(judged.status, 0, judged.stderr);
    assert.ok(!judged.stdout.includes('read_only'), command);
  }
  parity('git fetch origin', 'allow');
  parity('git fetch origin 2>&1', 'allow');
});

// Cloud R4 source github:pr-comment:4173008464. Only JSON classification is executed.
test('fetch ref narrowing retains wrapper and Git-selector coordinates', () => {
  const commands = [
    `env -C ${runtime} git fetch --prune origin`,
    `env --chdir=${runtime} git fetch origin main:refs/heads/review-main`,
    `sudo --chdir ${runtime} git fetch --prune origin 2>&1`,
    `nice env -C ${runtime} git fetch --prune origin`,
    `env -C ${root} env -C cat-cafe-runtime git fetch --prune origin`,
    `env -C ${main} git -C ../cat-cafe-runtime fetch --prune origin`,
    `env -C ${runtime} env -S 'git fetch --prune origin'`,
    `FOO=1 git -C ${runtime} fetch --prune origin`,
  ];
  for (const command of commands) parity(command, 'deny', '/tmp');
  for (const [program, script, tool_name] of nativeHookPrograms())
    for (const command of commands) {
      const judged = spawnSync(program, [new URL(script, import.meta.url).pathname], {
        env: nativeHookTestEnv(),
        input: JSON.stringify({ tool_name, cwd: '/tmp', tool_input: { command, cmd: command } }),
        encoding: 'utf8',
      });
      assert.equal(judged.status, 0, judged.stderr);
      assert.ok(!judged.stdout.includes('read_only'), command);
    }
  parity(`env -C ${main} git fetch --prune origin`, 'allow', '/tmp');
  parity('git fetch origin main:refs/heads/review-main', 'allow', main);
  parity('git fetch origin runtime/main-sync:refs/heads/review-runtime', 'allow', main);
  parity('git fetch --prune origin 2>&1', 'allow', runtime);
});

// Cloud source 4159641291: Git consumes global option values before <command>.
test('Git global values cannot become a fake subcommand', () => {
  for (const option of [
    '--git-dir /tmp/repo/.git',
    '--work-tree /tmp/repo',
    '--namespace foo',
    '--config-env advice.statusHints=HINTS',
    '--attr-source HEAD',
    '--exec-path=/tmp/git-exec',
    '--literal-pathspecs',
    '--glob-pathspecs',
    '--noglob-pathspecs',
    '--icase-pathspecs',
    '-C/tmp/repo',
    '-cadvice.statusHints=false',
    '--bare --git-dir=/tmp/repo.git',
  ]) {
    parity(`git ${option} push --force origin main`, 'deny', main);
    parity(`env git ${option} reset --hard`, 'deny');
  }
  parity("git --git-dir /tmp/repo/.git grep -n 'git push --force origin main'", 'allow', main);
});

// Cloud source 4159641299: npm exec owns either child argv or a shell command.
test('npm command dispatch retains protected effects and literal child data', () => {
  for (const command of [
    'npm exec -- git push --force origin main',
    'npm --prefix /tmp/repo exec -- git push --force origin main',
    "npm x --call='git push --force origin main'",
    "npm exec --package=pnpm -c 'git push --force origin main'",
  ])
    parity(command, 'deny', main);
  parity("npm x --call='git reset --hard'", 'deny');
  parity("npm exec -- printf '%s' 'git push --force origin main'", 'allow', main);
});

// Cloud source 4160016830: valid boolean assignments still own exec strings.
test('npm boolean assignments cannot hide executable children', () => {
  for (const flag of ['--include-workspace-root', '--workspaces', '--ignore-scripts', '--yes', '--offline']) {
    for (const value of ['true', 'false']) {
      parity(`npm exec ${flag}=${value} -c 'git push --force origin main'`, 'deny', main);
      parity(`npm ${flag}=${value} exec -- git push --force origin main`, 'deny', main);
    }
  }
});

// Source 0001790824051243-002156-ad3ad555 (exact argv); other spellings are regression variants.
test('HTTP argv is a candidate and cannot prove protected reads without its execution environment', () => {
  for (const command of [
    "curl --request GET --fail --silent --show-error --header 'X-Cat-Cafe-User: default-user' 'http://localhost:3004/api/recall/metrics?days=30'",
    "curl -fsS -H 'X-Text: kill runtime 6399' http://localhost:3004/api/metrics",
    "curl --header='X-Text: stop' --get --data-urlencode 'days=30' http://localhost:3004/api/metrics",
    "curl -G -d 'days=30' -I http://127.0.0.1:3004/api/metrics",
    "curl -X GET --data '{}' http://localhost:3004/api/metrics",
    'curl -fsS http://localhost:3004/api/x',
    'curl -q -fsS http://localhost:3004/api/metrics',
    'curl --disable --head http://localhost:3004/api/metrics',
    'curl -fsS -q http://localhost:3004/api/metrics',
  ])
    parity(command, 'deny');
  parity('curl http://example.com/ordinary', 'allow', main);
  for (const tool_name of ['Bash', 'exec_command']) {
    const result = decideNativeHookPayload(
      {
        tool_name,
        cwd: runtime,
        tool_input: { command: 'curl -q http://localhost:3004/health', cmd: 'curl -q http://localhost:3004/health' },
      },
      noHost,
    );
    assert.equal(result.effect, 'unknown');
    assert.equal(result.reasonCode, 'unrecognised_effect_deferred');
  }
  for (const command of [
    "curl --data '{}' http://localhost:3004/api/metrics",
    "curl --get -X POST --data 'days=30' http://localhost:3004/api/metrics",
    'curl --get --data-binary @/tmp/payload http://localhost:3004/api/metrics',
    'curl -H X:1 -o out http://localhost:3004/api/metrics',
    'curl --config /tmp/curlrc http://localhost:3004/api/metrics',
    'curl --get --upload-file /tmp/data http://localhost:3004/api/metrics',
    'curl http://localhost:3004/a http://example.com/b',
  ])
    parity(command, 'deny');
});

// Source 0001790737200774-000216-d7b33565: equivalent SQL; original SQL is unavailable.
test('SQLite recognizes a single readonly statement with SQL-aware termination', () => {
  for (const sql of [
    'select count(*) from recall_events;',
    "select '; kill update runtime'; -- comment",
    '/* comment */ SELECT 1;',
    'with t as (select 1) select * from t;',
    'select edit from documents;',
  ]) {
    parity(`sqlite3 -readonly /tmp/evidence.sqlite ${JSON.stringify(sql)}`, 'allow');
  }
  for (const sql of [
    'select 1; select 2;',
    'select 1; ATTACH "/tmp/x" AS x;',
    'select writefile("/tmp/x", "x");',
    'select load_extension("/tmp/x");',
    "select edit('x', 'touch /tmp/sentinel');",
    "select fts3_tokenizer('x', X'00');",
    '.output /tmp/x',
    'PRAGMA query_only=off;',
    'SELECT "unterminated',
    'SELECT 1 /* unterminated',
  ]) {
    parity(`sqlite3 -readonly /tmp/evidence.sqlite ${JSON.stringify(sql)}`, 'deny');
  }
});

// Sources 0001790478017438-000450-0b76ad1b, 0001790824280525-002161-eb48ac3c.
test('file and repository observations compose and keep adjacent writes guarded', () => {
  for (const command of [
    "git grep -n 'kill git reset --hard' origin/main -- docs",
    'git cat-file -p origin/main:package.json',
    'du -sh docs',
    'sleep 0.01',
    'shasum -a 256 scripts/a.mjs scripts/b.mjs',
    `shasum -a 256 ${runtime}/a ${runtime}/b && git status --short`,
    'kill -0 12345',
    "rg 'kill' scripts/alpha-runtime.sh",
    "rg 'pkill killall' docs",
  ])
    parity(command, 'allow');
  for (const command of [
    'kill -TERM 12345',
    'kill 0',
    'pkill -0 redis',
    'kill -0 12345; kill -TERM 12345',
    'git cat-file -p HEAD; git reset --hard',
    'shasum -a 256 a; touch b',
    'git grep --open-files-in-pager=evil x',
    'git cat-file --filters HEAD:a',
  ])
    parity(command, 'deny');
});

// Source 0001790796549905-001209-1aeb576b: equivalent refspec; original refspec is unavailable.
test('fetch judges destination refs independently of the source branch', () => {
  for (const command of [
    'git fetch origin main:refs/heads/review-main',
    'git fetch origin runtime/main-sync:refs/heads/review-runtime',
    'git fetch --depth 1 origin main:refs/heads/review-main',
  ])
    parity(command, 'allow', main);
  for (const command of [
    'git fetch origin feature:refs/heads/main',
    'git fetch origin +feature:refs/heads/master',
    'git fetch origin feature:refs/heads/runtime/main-sync',
  ])
    parity(command, 'deny', main);
  parity('git fetch origin main:refs/heads/review-main', 'deny', runtime);
});

// Source 0001790739000031-000277-fbabf853: API method/field regression variants.
test('GitHub API observations are remote reads and fields change the default method', () => {
  for (const command of [
    'gh api repos/owner/repo/pulls/1',
    'gh api --method GET -f state=open repos/owner/repo/pulls',
    "gh api -H 'X-Note: kill runtime 6399' repos/owner/repo/pulls/1",
  ])
    parity(command, 'allow');
  for (const command of [
    'gh api -f state=closed repos/owner/repo/pulls/1',
    'gh api -X DELETE repos/owner/repo/pulls/1',
    'gh api --input /tmp/body repos/owner/repo/pulls/1',
  ]) {
    for (const tool_name of ['Bash', 'exec_command']) {
      const result = decideNativeHookPayload(
        { tool_name, cwd: runtime, tool_input: { command, cmd: command } },
        noHost,
      );
      assert.notEqual(result.effect, 'read', command);
      assertGuardedOrUnproved(result, command);
    }
  }
});

// Source 0001790850340639-002909-a8c0d6a1; fixture coordinates preserve the Alpha owner contract.
test('preview observations compose per segment, including the matching Alpha package coordinate', () => {
  const preview = `pnpm preview:process status --cwd ${main} --port 3011`;
  parity(`${preview} && tail -n 3 /tmp/preview.log`, 'allow', main);
  parity(`pnpm --dir ${main} preview:process status --cwd ${main} --port 3011`, 'allow', main);
  parity(`${preview} && rm -rf ${runtime}`, 'deny', main);
  parity(`${preview} && curl -X POST http://localhost:3004/api/test`, 'deny', runtime);
});

// Source 0001790835119501-002457-5e0f23e5; real hook, no candidate shell execution.
test('gate hook distinguishes data from execution, including nested shell positions', () => {
  const [gateProgram, gateScript] = gateHookProgram();
  for (const [command, deny] of [
    ["gh pr comment 4970 --body 'Validation: pnpm gate passed'", false],
    ["echo 'pnpm gate'", false],
    ["rg 'pnpm gate' docs", false],
    ["cat <<'EOF'\npnpm gate\nEOF", false],
    ["cat <<'EOF' | cat\npnpm gate\nEOF", false],
    ["cat <<'EOF' | gh pr comment 1 --body-file -\npnpm gate\nEOF", false],
    ['pnpm gate', true],
    ["bash -c 'pnpm gate'", true],
    ['echo "$(pnpm gate)"', true],
    ['echo "$(printf ")"; pnpm gate)"', true],
    ['cat <(printf "("; pnpm gate)', true],
    ['echo "$(# a literal closing )\npnpm gate)"', true],
    ["eval 'pnpm gate'", true],
    ["bash <<'EOF'\npnpm gate\nEOF", true],
    ["cat <<'EOF' | bash\npnpm gate\nEOF", true],
  ]) {
    const result = spawnSync(gateProgram, [gateScript], {
      env: nativeHookTestEnv(),
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('"deny"'), deny, command);
  }
});
