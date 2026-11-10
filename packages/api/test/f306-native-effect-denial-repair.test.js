import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  linkSync,
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
import ts from 'typescript';
import { gateBackgroundDecision } from '../../../scripts/gate-background-decision.mjs';
import { GH_COHORT_FILES } from '../../../scripts/native-effect-gh-cohort.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { copyManagedGhCohort } from './helpers/managed-gh-cohort.js';
import { nativeHookPrograms, nativeHookTestEnv } from './helpers/native-hook-programs.js';

// Human276 / census271: only the policy runs. None of these command strings execute.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-denial-repair-')));
const main = join(root, 'projects/relay-station/cat-cafe');
const runtime = join(root, 'projects/relay-station/cat-cafe-runtime');
const worktree = join(root, 'projects/relay-station/cat-cafe-feature');
for (const path of [main, worktree, join(runtime, 'packages/api/uploads'), join(runtime, 'scripts/guarded-bin')])
  mkdirSync(path, { recursive: true });
const wrapper = join(runtime, 'scripts/guarded-bin/gh');
copyManagedGhCohort(runtime);
const ordinaryRoot = join(root, 'ordinary');
copyManagedGhCohort(ordinaryRoot);
const ordinaryWrapper = join(ordinaryRoot, 'scripts/guarded-bin/gh');
after(() => rmSync(root, { recursive: true, force: true }));

function decide(command, expected, cwd = worktree) {
  for (const tool_name of ['Bash', 'exec_command']) {
    const result = decideNativeHookPayload(
      {
        tool_name,
        ...(tool_name === 'exec_command' ? { turn_id: 'repair' } : {}),
        cwd,
        tool_input: { command, cmd: command },
      },
      { selfHost: () => ({ confidence: 'none' }) },
    );
    assert.equal(result.decision, expected, `${command}\n${JSON.stringify(result)}`);
  }
}

test('ordinary cp and safe copy flags attribute runtime inputs only to external destinations', () => {
  for (const prefix of ['cp', 'cp -n', 'cp -p', '/bin/cp'])
    decide(`${prefix} ${runtime}/packages/api/uploads/avatar.png ${root}/avatar.png`, 'allow');
  decide(
    `S=${root}; mkdir -p "$S/export" && cp ${runtime}/packages/api/uploads/avatar.png "$S/export/avatar.png"`,
    'allow',
  );
  decide(`cp ${root}/avatar.png ${runtime}/packages/api/uploads/avatar.png`, 'deny');
  decide(`cp ${runtime}/packages/api/uploads/avatar.png avatar.png`, 'allow');
});

test('fetch options retain refresh versus protected destination semantics', () => {
  for (const options of [
    '--no-auto-maintenance',
    '--no-tags',
    '--refmap=',
    '--refmap=refs/heads/*:refs/remotes/origin/*',
  ]) {
    decide(`git fetch ${options} origin refs/heads/main:refs/remotes/origin/main`, 'allow', main);
    decide(`git fetch ${options} origin +feature:refs/heads/main`, 'deny', main);
  }
  decide('git fetch --no-auto-maintenance origin main', 'allow', main);
  decide(`R=${main}; git -C $R fetch -q origin main`, 'allow', main);
  decide(`R=${main}; git -C "$R" fetch origin +feature:refs/heads/main`, 'deny', main);
  decide(`R=${runtime}; git -C "$R" reset --hard`, 'deny');
});

test('environment PATH is program configuration rather than a write target on uncertain argv', () => {
  decide(
    `env -i PATH="${runtime}/scripts/guarded-bin:/usr/bin:/bin" HOME="${root}" TMPDIR="\${TMPDIR:-/tmp}" NODE_ENV=test pnpm exec tsc --noEmit > ${root}/tsc.log 2>&1`,
    'allow',
  );
  decide(
    `env -i PATH="${runtime}/scripts/guarded-bin:/usr/bin:/bin" pnpm exec tsc --noEmit > ${runtime}/tsc.log`,
    'deny',
  );
  decide(`env PATH=${root}/bin:$PATH pnpm --filter @example/test build > ${root}/build.log 2>&1`, 'allow');
});

test('pinned managed gh accepts help and normal workflow operations without exempting lookalikes', () => {
  for (const args of [
    'api --help',
    'auth status',
    'workflow list',
    'api repos/o/r/commits/main --jq .sha',
    "pr create --repo o/r --title fixed --body 'reviewed text'",
    'pr review 12 --repo o/r --approve --body ok',
  ])
    decide(`${wrapper} ${args}`, 'allow');
  decide(`${root}/unverified/guarded-bin/gh pr create --repo o/r --body-file ${root}/body`, 'deny');
  decide(`${ordinaryWrapper} api user --jq .login`, 'allow');
  decide(`printf changed > ${ordinaryWrapper}; ${ordinaryWrapper} pr create --repo o/r --body safe`, 'deny');
  decide(`node -e 'unprovedSetup()'; ${wrapper} pr create --repo o/r --body safe`, 'deny');
  decide(`${wrapper} api --method POST repos/o/r/dispatches --input ${root}/body --jq --help`, 'deny');
});

test('canonical source and the deterministic staged wrapper both preserve managed identity', () => {
  const staged = new URL('../../../packages/mcp-server/dist/runtime/scripts/guarded-bin/gh', import.meta.url).pathname;
  decide(`${staged} api repos/o/r/commits/main --jq .sha`, 'allow');
  const relocated = join(root, 'relocated-stage');
  for (const file of GH_COHORT_FILES) {
    const emitted = file.replace(/\.ts$/, '.mjs');
    const target = join(relocated, emitted);
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(new URL('../../../packages/mcp-server/dist/runtime/' + emitted, import.meta.url), target);
  }
  decide(`${relocated}/scripts/guarded-bin/gh pr comment 1 --repo o/r --body safe`, 'allow');
  decide(`NODE_OPTIONS=--import=${root}/untrusted.mjs ${staged} pr comment 1 --body ok`, 'deny');
});

test('a copied gh entry cannot grant a secret-send exemption with poisoned scanner imports', () => {
  copyManagedGhCohort(join(root, 'forged'));
  const forged = join(root, 'forged/scripts/guarded-bin/gh');
  const libs = join(root, 'forged/scripts/lib');
  mkdirSync(join(root, 'forged/scripts/guarded-bin'), { recursive: true });
  mkdirSync(libs, { recursive: true });
  copyFileSync(wrapper, forged);
  writeFileSync(join(libs, 'secret-payload-files.mjs'), 'export function assertSecretFree() {}');
  writeFileSync(join(libs, 'secret-outbound-args.mjs'), 'export function prepareSecretSafeSend() {}');
  decide(`${forged} pr comment 1 --repo o/r --body-file ${root}/body.txt`, 'deny');
});

test('managed gh cohort enumerates every local static and dynamic import consumed by the packager', () => {
  const repository = new URL('../../../', import.meta.url);
  const seen = new Set();
  function collect(file) {
    const logical = file.pathname.slice(repository.pathname.length);
    if (seen.has(logical)) return;
    if (logical.startsWith('packages/api/dist/') || logical.startsWith('packages/mcp-server/dist/')) return;
    seen.add(logical);
    if (logical.endsWith('.json')) return;
    for (const dependency of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles)
      if (dependency.fileName.startsWith('.')) collect(new URL(dependency.fileName, file));
  }
  collect(new URL('scripts/guarded-bin/gh', repository));
  assert.deepEqual([...seen].sort(), [...GH_COHORT_FILES].sort());
});

test('bounded readonly SQL supports metadata and sequences without external file or extension functions', () => {
  for (const prefix of ['sqlite3 -readonly', 'sqlite3'])
    decide(
      `${prefix} "file:${runtime}/evidence.sqlite?mode=ro" "select count(*) from tasks; pragma table_info(tasks);"`,
      'allow',
    );
  decide(`sqlite3 -readonly ${runtime}/evidence.sqlite '.schema tasks' '.tables'`, 'allow');
  for (const query of [
    "select writefile('out', data) from t;",
    "select load_extension('x');",
    'pragma journal_mode=wal;',
    '.output /tmp/file',
    'delete from tasks;',
  ])
    decide(`sqlite3 -readonly ${runtime}/evidence.sqlite "${query}"`, 'deny');
});

test('local HTTP and log input paths are independent of ordinary output paths', () => {
  decide(`curl -sS http://127.0.0.1:3004/api/cats -o ${root}/cats.json`, 'allow');
  decide(`tail -50 ${runtime}/api.log > ${root}/tail.log`, 'allow');
  decide(`tail -50 ${runtime}/api.log > tail.log`, 'allow');
  decide(`node ${runtime}/scripts/worktree-inventory.mjs --repo ${runtime} > ${root}/inventory.json`, 'allow');
  decide(`tail -50 ${runtime}/api.log > ${runtime}/tail.log`, 'deny');
  decide(`tail -50 ${runtime}/api.log > tail.log`, 'deny', runtime);
  decide(`curl -sS http://127.0.0.1:3004/api/cats -o ${runtime}/cats.json`, 'deny');
  decide(`curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:3004/api/cats`, 'allow', runtime);
  decide(`curl -sS http://127.0.0.1:3004/api/cats -o ${root}/cats.json`, 'allow', runtime);
  decide(`curl -X POST http://127.0.0.1:3004/api/cats -o ${root}/cats.json`, 'deny', runtime);
  for (const redirect of ['> -', '2> -'])
    decide(`curl -sS http://127.0.0.1:3004/api/cats -o ${root}/cats.json ${redirect}`, 'deny', runtime);
  const protectedFile = join(runtime, 'protected.log');
  writeFileSync(protectedFile, 'keep');
  symlinkSync(protectedFile, join(root, 'output-link'));
  linkSync(protectedFile, join(root, 'output-hardlink'));
  for (const alias of ['output-link', 'output-hardlink'])
    decide(`tail -50 ${runtime}/api.log > ${root}/${alias}`, 'deny');
});

test('external log output does not authorize an unknown program running in the runtime cwd', () => {
  for (const command of [
    `node --test scripts/protected.test.mjs > ${root}/test.log`,
    `node docs/probe.mjs fixed > ${root}/probe.log`,
    `pnpm exec tsx --test packages/api/test/protected.test.js > ${root}/tsx.log`,
  ])
    decide(command, 'deny', runtime);
});

test('foreground lightweight script loops are read in their declared bindings; gates stay managed', () => {
  const payload = (command) => ({ tool_name: 'Bash', cwd: worktree, tool_input: { command } });
  assert.equal(
    gateBackgroundDecision(payload('for c in check:skills:manifest check:sources; do pnpm -s "$c"; done')),
    false,
  );
  assert.equal(gateBackgroundDecision(payload('for c in check:sources gate; do pnpm -s "$c"; done')), true);
  assert.equal(gateBackgroundDecision(payload('pnpm "$UNKNOWN_SCRIPT"')), true);
  assert.equal(gateBackgroundDecision(payload('set -- pnpm gate; "$@"')), true);
});

test('literal scratch variables keep their path prefix and observation patterns remain data', () => {
  decide(`S=${root}; rm -rf $S/s1822; mkdir -p $S/s1822`, 'allow', main);
  decide(`pgrep -fl 'git fetch origin main|git-remote-https|git-credential'`, 'allow', main);
  decide(`S=${runtime}; rm -rf $S/s1822`, 'deny');
});

test('managed status and help do not become lifecycle stops in a named deployment', () => {
  const options = {
    selfHost: () => ({
      confidence: 'unreadable',
      facet: {
        v: 1,
        installation: { deploymentId: 'runtime', projectRoot: runtime },
        runtime: { worktree: runtime, apiPid: 4242, apiPort: 18080 },
        hostDependencies: [],
      },
    }),
    observeHost: () => ({ readHostPids: () => ({ pids: [], complete: false }) }),
  };
  for (const command of [
    `pnpm --dir ${main} preview:process status --port 3171 --cwd ${main} --json`,
    'pnpm preview:process start --help',
    '/bin/launchctl help kill',
    'pnpm runtime:restart --expected-target-sha ' + 'a'.repeat(40) + ' --help',
    'pnpm runtime:restart -- --help',
  ]) {
    for (const tool_name of ['Bash', 'exec_command']) {
      const result = decideNativeHookPayload({ tool_name, cwd: main, tool_input: { command, cmd: command } }, options);
      assert.equal(result.decision, 'allow', `${command}: ${JSON.stringify(result)}`);
    }
  }
  for (const command of [
    'pnpm runtime:restart',
    'pnpm runtime:restart -- -- --help',
    'pnpm runtime:stop --remote --help',
    'pnpm runtime:stop --branch --help',
  ]) {
    const result = decideNativeHookPayload(
      { tool_name: 'exec_command', cwd: main, tool_input: { cmd: command } },
      options,
    );
    assert.equal(result.decision, 'deny', command);
  }
});

test('source, staged and private hook CLIs consume the repaired roles and keep real output writes blocked', () => {
  const env = nativeHookTestEnv();
  delete env.CAT_CAFE_DEPLOYMENT_ID;
  const stage = new URL(
    '../../../packages/mcp-server/dist/runtime/scripts/native-effect-target-guard.mjs',
    import.meta.url,
  ).pathname;
  const programs = [...nativeHookPrograms(), [process.execPath, stage, 'exec_command']];
  const cases = [
    [`cp ${runtime}/packages/api/uploads/avatar.png avatar.png`, 'allow'],
    [`${ordinaryWrapper} api user --jq .login`, 'allow'],
    [`env PATH=${root}/bin:$PATH pnpm --filter @example/test build > ${root}/build.log 2>&1`, 'allow'],
    [`cp ${root}/avatar.png ${runtime}/packages/api/uploads/avatar.png`, 'deny'],
    ['git fetch --refmap= origin +feature:refs/heads/main', 'deny'],
    [`${wrapper} api --method POST repos/o/r/dispatches --input ${root}/body --jq --help`, 'deny'],
    [`node --test scripts/protected.test.mjs > ${root}/test.log`, 'deny', runtime],
    [`GH_HOST=example.invalid ${wrapper} pr comment 1 --repo o/r --body ok`, 'deny'],
    [`export NODE_OPTIONS=--import=${root}/untrusted.mjs; ${wrapper} pr comment 1 --repo o/r --body ok`, 'deny'],
    [`cp ${runtime}/packages/api/dist -R ${root}`, 'deny'],
    ["for id in 1 2; do gh api repos/o/r/actions/jobs/$id --jq '.id'; done", 'allow'],
  ];
  for (const [program, script, tool_name] of programs)
    for (const [command, expected, cwd = worktree] of cases) {
      const result = spawnSync(program, [script], {
        env,
        encoding: 'utf8',
        input: JSON.stringify({
          tool_name,
          cwd,
          ...(tool_name === 'exec_command' ? { turn_id: 'actual-repaired-cli' } : {}),
          tool_input: { command, cmd: command },
        }),
      });
      assert.equal(result.status, 0, result.stderr);
      const actual = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision : 'allow';
      assert.equal(actual, expected, `${script}: ${command}\n${result.stdout}`);
    }
});
