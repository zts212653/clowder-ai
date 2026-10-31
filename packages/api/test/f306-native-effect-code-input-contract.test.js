import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { nativeHookPrograms, nativeHookTestEnv } from './helpers/native-hook-programs.js';

// Sources: 0001791034032278-000485-37cbf073; 0001791035019057-000596-6c26fbd4;
// 0001791060581057-001626-0915f7ae.
// Threat-shaped commands below only enter pure decision functions or hook JSON stdin.
const main = '/tmp/f306-policy/projects/relay-station/cat-cafe';
const payload = (command, tool_name, cwd = main) => ({
  tool_name,
  cwd,
  tool_input: { command, cmd: command },
  ...(tool_name === 'exec_command' ? { tool_use_id: 'inert-code-input' } : {}),
});
const decide = (command, provider, cwd) =>
  decideNativeHookPayload(payload(command, provider, cwd), { selfHost: () => ({ confidence: 'none' }) });
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const wrappers = [
  (x) => `builtin ${x}`,
  (x) => `gtimeout 5 ${x}`,
  (x) => `doas ${x}`,
  (x) => `chronic ${x}`,
  (x) => `xargs -n1 ${x}`,
  (x) => `watch ${x}`,
  (x) => `su -c ${quote(x)}`,
  (x) => `ssh host ${quote(x)}`,
  (x) => `tmux new-session -d ${quote(x)}`,
  (x) => `screen -dm ${x}`,
  (x) => `docker exec c ${x}`,
  (x) => `kubectl exec pod -- ${x}`,
  (x) => `bash -c -- ${quote(x)}`,
  (x) => `bash -s <<< ${quote(x)}`,
  (x) => `printf '%s\n' ${quote(x)} | sh`,
  (x) => `echo ${quote(x)} | bash`,
  (x) => `bash -c 'exec "$@"' _ ${x}`,
  (x) => `bash -c 'eval "$1"' _ ${quote(x)}`,
  (x) => `set -- ${x}; "$@"`,
  (x) => `f() { "$@"; }; f ${x}`,
  (x) => `trap ${quote(x)} EXIT`,
  (x) => `coproc ${x}`,
  (x) => `git -c core.pager=${quote(x)} log`,
];
const threats = [
  'git push --force origin main',
  'git push origin :main',
  'git push origin --delete main',
  'git push origin +main:main',
  'git branch -D main',
  'git update-ref -d refs/heads/main',
  'git fetch origin +x:main',
];
test('indirect execution retains destructive branch evidence on the same chain', () => {
  for (const cwd of ['/tmp', main])
    for (const provider of ['Bash', 'exec_command'])
      for (const threat of threats)
        for (const wrapper of wrappers) {
          const command = wrapper(threat);
          assert.equal(decide(command, provider, cwd).decision, 'deny', `${provider} ${cwd}: ${command}`);
        }
});
const data = [
  "echo 'git push --force origin main'",
  "printf '%s' 'git push --force origin main' | cat",
  "git --git-dir /tmp/r grep -n 'git push --force origin main'",
  "git -c advice.statusHints=false grep -n 'git push --force origin main'",
  "npm exec -- printf '%s' 'git push --force origin main'",
  'bash -c \'printf "%s" "$1"\' _ \'git push --force origin main\'',
  "set -- 'git push --force origin main'; printf '%s' \"$1\"",
  "echo git; echo 'push --force origin main'",
  "printf '%s' git | cat; echo 'push --force origin main'",
  'bash -c \'echo "$USER"\'',
  "printf '%s' 'echo \"$USER\"' | sh",
];
test('proven data and unrelated statements cannot invent an execution chain', () => {
  for (const command of data)
    for (const provider of ['Bash', 'exec_command']) assert.equal(decide(command, provider).decision, 'allow', command);
});
const generated = [
  'bash -c -- "$(date)"',
  'builtin eval "$(date)"',
  'printf "%s" "$(date)" | sh',
  'bash -s <<< "$(date)"',
  'source <(printf "%s" "$(date)")',
  '. /dev/stdin <<< "$(date)"',
  'bash -c "echo $USER"',
  'bash -c "echo $PWD"',
  'bash -c "echo $HOME"',
  'bash -c \'exec "$@"\' _ "$(date)"',
];
test('code origin survives hook environment resolution and stdin transport', () => {
  const before = { ...process.env };
  try {
    for (const set of [true, false]) {
      for (const name of ['USER', 'PWD', 'HOME']) {
        if (set) process.env[name] = 'literal-from-hook';
        else delete process.env[name];
      }
      for (const command of generated)
        for (const provider of ['Bash', 'exec_command'])
          assert.equal(decide(command, provider).decision, 'deny', `${set}: ${command}`);
    }
  } finally {
    for (const name of ['USER', 'PWD', 'HOME']) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});
test('literal stdin is read as code by both real hook entries', () => {
  const rows = [
    ["printf '%s' 'git push --force origin main' | sh", true],
    ["printf -- '%s' 'git push --force origin main' | sh", true],
    ["V='git push --force origin main'; printf '%s' \"$V\" | sh", true],
    ["V=$(printf '%s' 'git push --force origin main'); printf '%s' \"$V\" | sh", true],
    ["V='git push --force origin main'; source <(printf '%s' \"$V\")", true],
    ['set -- git push --force origin main; if false; then set -- echo OK; fi; "$@"', true],
    ["bash -s <<< 'git push --force origin main'", true],
    ["source <(printf '%s' 'git push --force origin main')", true],
    [". /dev/stdin <<< 'git push --force origin main'", true],
    ["printf '%s' 'echo OK' | sh", false],
    ['bash -s <<< \'printf "%s" OK\'', false],
    ...generated.map((command) => [command, true]),
  ];
  for (const [program, script, provider] of nativeHookPrograms())
    for (const [command, denied] of rows) {
      const result = spawnSync(program, [script], {
        input: JSON.stringify(payload(command, provider)),
        encoding: 'utf8',
        timeout: 10_000,
        env: nativeHookTestEnv({ PATH: process.env.PATH, USER: 'hook-user', PWD: '/tmp' }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        JSON.parse(result.stdout || '{}').hookSpecificOutput?.permissionDecision === 'deny',
        denied,
        command,
      );
    }
});
test('unused positional values do not become another code operands evidence', () => {
  const command = "bash -c 'eval \"$2\"' _ 'git push --force origin main' \"$(printf 'echo OK')\"";
  for (const provider of ['Bash', 'exec_command'])
    assert.equal(decide(command, provider, '/tmp').decision, 'allow', command);
});
test('positional scopes and alternative set writes retain only their own evidence', () => {
  const inner = `bash -c ${quote('eval "$1"')} _ "$(printf 'echo OK')"`;
  const cases = [
    [`bash -c ${quote(inner)} _ 'git push --force origin main'`, 'allow'],
    ["bash -c 'eval \"$0\"' 'git push --force origin main'", 'deny'],
    ['set -- git push --force origin main; if false; then set -- echo OK; fi; "$@"', 'deny'],
    ['set -- git; if true; then set -- push --force origin main; fi; "$@"', 'allow'],
  ];
  for (const [command, expected] of cases)
    for (const provider of ['Bash', 'exec_command'])
      assert.equal(decide(command, provider, '/tmp').decision, expected, command);
});
test('generated grep option words cannot be certified as search data', () => {
  for (const provider of ['Bash', 'exec_command']) {
    assert.equal(
      decide("git grep \"$(printf '%s' '--open=git push --force origin main')\" a", provider, '/tmp').decision,
      'deny',
    );
    assert.equal(decide("git grep -e \"$(printf '%s' 'git push --force origin main')\"", provider).decision, 'allow');
  }
});
test('generated Git control options cannot be certified as data', () => {
  const commands = [
    'git branch $(echo -D) main',
    'git branch `echo -D` main',
    'git branch "$(echo -D)" main',
    'git push $(echo --force) origin main',
    'git update-ref $(echo -d) refs/heads/main',
    'git fetch origin $(echo +topic:main)',
  ];
  for (const command of commands)
    for (const provider of ['Bash', 'exec_command'])
      assert.equal(decide(command, provider, '/tmp').decision, 'deny', command);
});
test('launcher child argv retains the source frame of its outer expansion', () => {
  const threat = 'git push --force origin main';
  const consumers = [
    (word) => `printf x | xargs -I{} sh -c ${word}`,
    (word) => `find . -maxdepth 0 -exec sh -c ${word} \\;`,
    (word) => `npm exec -- sh -c ${word}`,
    (word) => `gtimeout 5 sh -c ${word}`,
  ];
  const sources = [
    [`V=$(printf '%s' ${quote(threat)}); `, '"$V"'],
    [`V=$(printf '%s' ${quote(threat)}); `, `"\${V}"`],
    [`set -- "$(printf '%s' ${quote(threat)})"; `, '"$1"'],
    [`set -- "$(printf '%s' ${quote(threat)})"; `, '"$@"'],
  ];
  for (const consumer of consumers)
    for (const [prefix, word] of sources)
      for (const provider of ['Bash', 'exec_command'])
        assert.equal(decide(prefix + consumer(word), provider, '/tmp').decision, 'deny', prefix + consumer(word));
});
test('launcher stdin is evidence only for the child positions consuming it', () => {
  const threat = 'git push --force origin main';
  const rows = [
    [`printf '%s' ${quote(threat)} | xargs -I{} sh -c '{}'`, 'deny'],
    [`printf '%s' ${quote(threat)} | xargs --replace=CODE sh -c CODE`, 'deny'],
    [`printf '%s' ${quote(threat)} | xargs -I{} sh -c 'eval "$1"' _ '{}'`, 'deny'],
    [`printf '%s' ${quote(threat)} | xargs sh -c 'eval "$*"' _`, 'deny'],
    [`printf '%s' ${quote(threat)} | find . -maxdepth 0 -exec sh -s \\;`, 'deny'],
    [`printf main | xargs -n1 git push --force origin`, 'deny'],
    [`echo origin main | xargs git push --force`, 'deny'],
    [`printf '%s' ${quote(threat)} | xargs -I{} printf '%s' '{}'`, 'allow'],
    [`printf '%s' ${quote(threat)} | xargs -I{} sh -c 'echo OK'`, 'allow'],
    [`printf '%s' ${quote(threat)} | xargs -I{} sh -c 'printf "%s" "$1"' _ '{}'`, 'allow'],
    [`printf '%s' ${quote(threat)} | xargs sh -c 'printf "%s" "$1"' _`, 'allow'],
    [`V=$(printf '%s' ${quote(threat)}); find . -maxdepth 0 -exec printf '%s' "$V" \\;`, 'allow'],
  ];
  for (const [command, expected] of rows)
    for (const provider of ['Bash', 'exec_command'])
      assert.equal(decide(command, provider, '/tmp').decision, expected, command);
});
test('classified data operands do not become shell execution evidence', () => {
  const threat = 'git push --force origin main';
  const commands = [
    `git commit -m ${quote(`docs: never ${threat}`)} -- docs/a.md`,
    `git commit -m "$(printf '%s' ${quote(`docs: never ${threat}`)})" -- docs/a.md`,
    `git tag -a v1 -m ${quote(`never ${threat}`)}`,
    `git tag -a v1 -m "$(printf '%s' ${quote(`never ${threat}`)})"`,
    `gh pr edit 1 --body ${quote(`never ${threat}`)}`,
    `gh issue comment 1 --body ${quote(`never ${threat}`)}`,
    `curl -s -X POST -d ${quote(JSON.stringify({ text: threat }))} http://localhost:3004/api/x`,
    `sed -n ${quote(`/${threat}/p`)} docs/a.md`,
    `awk ${quote(`/${threat}/ {print}`)} docs/a.md`,
    `jq --arg t ${quote(threat)} '.x=$t' a.json`,
    `sqlite3 db.sqlite ${quote(`insert into notes values('${threat}')`)}`,
    `redis-cli -p 6398 set k ${quote(threat)}`,
    `pnpm test -- -t ${quote(threat)}`,
    `node --test --test-name-pattern=${quote(threat)} test/x.test.js`,
  ];
  for (const command of commands)
    for (const provider of ['Bash', 'exec_command'])
      assert.equal(decide(command, provider, '/tmp').decision, 'allow', command);
});
test('pipeline provenance crosses data filters until a later code consumer', () => {
  const threat = 'git push --force origin main';
  const denied = [
    `echo ${quote(threat)} | cat | sh`,
    `printf '%s\n' ${quote(threat)} | sed 's/a/b/' | bash`,
    `echo ${quote(threat)} | tr a b | sh`,
    `echo ${quote(threat)} | head -1 | sort | uniq | sh`,
    `(echo ${quote(threat)}) | sh`,
    `{ echo ${quote(threat)}; } | sh`,
    `echo ${quote(threat)} | python3`,
    `echo ${quote(threat)} | docker exec -i c sh`,
    `echo ${quote(threat)} | xargs -I{} tmux new-session -d '{}'`,
    `echo main | xargs -I{} git push --force origin {}`,
    `set -- git push --force origin main; "$@" > /tmp/o`,
    `f() { "$@"; }; f git push --force origin main > /tmp/o`,
    `docker run --rm img git push --force origin main > /tmp/o`,
    `systemd-run git push --force origin main > /tmp/o`,
    `echo ${quote(threat)} | cat | sh > /tmp/o`,
    `tmux send-keys ${quote(threat)} Enter`,
    `tmux send-keys -t 0 ${quote(threat)} C-m`,
    `git rebase -x ${quote(threat)} HEAD~1`,
    `git bisect run sh -c ${quote(threat)}`,
    `awk ${quote(`BEGIN{print "${threat}" | "sh"}`)} </dev/null`,
    `awk ${quote(`BEGIN{"${threat}" | getline x}`)} </dev/null`,
    `sed 's/x/y/e' <<< ${quote(threat)}`,
    `gh alias set x ${quote(`!${threat}`)}`,
  ];
  const allowed = [
    `echo ${quote(threat)} | cat`,
    `echo ${quote(threat)} | printf '%s' 'echo OK' | sh`,
    `echo ${quote(threat)} | xargs -I{} printf '%s' '{}'`,
    `tmux send-keys ${quote(threat)}`,
    ...[
      'pbcopy',
      'xclip -selection clipboard',
      'wl-copy',
      'less',
      'more',
      'bat',
      'nl',
      'fold -w 20',
      'rev',
      'tac',
      'od',
      'fmt',
      'diff - fixture',
      'paste - fixture',
      'md5',
    ].map((sink) => `echo ${quote(`run: ${threat}`)} | ${sink}`),
    `rg ${quote(threat)} docs | less`,
    `rg -l ${quote(threat)} docs | xargs sed -i '' 's/a/b/'`,
  ];
  for (const [commands, expected] of [
    [denied, 'deny'],
    [allowed, 'allow'],
  ])
    for (const command of commands)
      for (const provider of ['Bash', 'exec_command'])
        assert.equal(decide(command, provider, '/tmp').decision, expected, command);
});
for (const shell of ['/bin/bash', '/bin/zsh'])
  test(`printf-only stdin and positional execution oracle with ${shell}`, { skip: !existsSync(shell) }, () => {
    const marker = 'printf CODE_INPUT_MARK';
    const commands = [
      `printf '%s' ${quote(marker)} | sh`,
      `bash -s <<< ${quote(marker)}`,
      `. /dev/stdin <<< ${quote(marker)}`,
      `bash -c -- ${quote(marker)}`,
      `builtin eval ${quote(marker)}`,
      `bash -c 'exec "$@"' _ printf CODE_INPUT_MARK`,
      `bash -c 'eval "$1"' _ ${quote(marker)}`,
      `printf '%s' ${quote(marker)} | xargs -I{} sh -c '{}'`,
      `printf '%s' ${quote(marker)} | xargs sh -c 'eval "$*"' _`,
      `printf '%s' ${quote(marker)} | find . -maxdepth 0 -exec sh -s \\;`,
    ];
    if (shell.endsWith('zsh')) commands.push(`source <(printf '%s' ${quote(marker)})`);
    for (const command of commands) {
      const result = spawnSync(shell, shell.endsWith('zsh') ? ['-f', '-c', command] : ['-c', command], {
        encoding: 'utf8',
        timeout: 2_000,
        env: { PATH: '/usr/bin:/bin' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'CODE_INPUT_MARK', command);
    }
  });
