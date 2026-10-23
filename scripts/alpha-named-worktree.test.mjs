import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from './lib/alpha-named-fixture.mjs';
import { lifecycleConfig } from './lib/worktree-reaper-probes.mjs';
import { decideNativeHookPayload } from './native-effect-target-guard.mjs';
import { finishWorktree, ownedWorktreeFacts } from './worktree-finish.mjs';

test('canonical named Alpha launcher carries one tuple from actual main to isolated child', (t) => {
  const f = namedAlphaFixture(t);
  f.captureChild();
  writeFileSync(
    join(f.mainRoot, '.env'),
    'API_SERVER_PORT=3004\nFRONTEND_URL=http://foreign.invalid\nCAT_CAFE_DATA_DIR=/must-not-use\n',
  );
  const result = f.run([
    'start',
    '--instance',
    'f290-communication',
    '--ports',
    NAMED_ALPHA_PORTS,
    '--allow-empty-redis',
  ]);
  const env = f.childEnvironment(result);
  assert.equal(env.CAT_CAFE_DEPLOYMENT_ID, 'alpha');
  assert.equal(env.CAT_CAFE_RUNTIME_ROOT, f.alphaRoot);
  assert.equal(env.CAT_CAFE_DATA_DIR, join(f.alphaRoot, '.cat-cafe'));
  assert.equal(env.API_SERVER_PORT, '5312');
  assert.equal(env.FRONTEND_PORT, '5311');
  assert.equal(env.PREVIEW_GATEWAY_PORT, '5411');
  assert.equal(env.REDIS_PORT, '15397');
  assert.equal(env.API_SERVER_HOST, '127.0.0.1');
  assert.equal(env.FRONTEND_URL, 'http://localhost:5311');
  assert.equal(env.REDIS_DATA_DIR, join(f.alphaRoot, '.cat-cafe/redis'));
  assert.equal(env.CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED, '1');
  assert.equal(env.CAT_CAFE_DIRECT_NO_WATCH, '1');
  const coords = JSON.parse(env.CAT_CAFE_ALPHA_COORDINATES);
  assert.equal(coords.targetSha, f.git(['rev-parse', 'HEAD'], f.alphaRoot));
  assert.equal(coords.targetSha, f.git(['rev-parse', 'origin/main']));
  assert.equal(f.readCalls().includes('redis-cli '), false, 'fresh named startup never queries old Redis');
});

test('named Alpha preserves managed preview context across dotenv and does not mint it from dotenv', (t) => {
  const f = namedAlphaFixture(t);
  f.captureChild();
  writeFileSync(
    join(f.mainRoot, '.env'),
    'CAT_CAFE_PREVIEW_EXPIRES_AT=forged-from-dotenv\nCAT_CAFE_PREVIEW_CLEANUP_RESULT=forged-from-dotenv\n',
  );
  const args = ['start', '--instance', 'f290-communication', '--ports', NAMED_ALPHA_PORTS];
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const resultPath = join(f.directory, 'owner-result.json');
  const managed = f.childEnvironment(
    f.run(args, { env: { CAT_CAFE_PREVIEW_EXPIRES_AT: expiry, CAT_CAFE_PREVIEW_CLEANUP_RESULT: resultPath } }),
  );
  assert.equal(managed.CAT_CAFE_PREVIEW_EXPIRES_AT, expiry);
  assert.equal(managed.CAT_CAFE_PREVIEW_CLEANUP_RESULT, resultPath);
  const direct = f.childEnvironment(f.run(args));
  assert.equal(direct.CAT_CAFE_PREVIEW_EXPIRES_AT, '');
  assert.equal(direct.CAT_CAFE_PREVIEW_CLEANUP_RESULT, '');
});

test('actual native guard admits only the registered main-lineage named Alpha child', (t) => {
  const f = namedAlphaFixture(t);
  const child = `pnpm alpha:start --instance f290-communication --ports ${NAMED_ALPHA_PORTS} --allow-empty-redis`;
  const decide = (command, cwd = f.mainRoot) =>
    decideNativeHookPayload(
      {
        turn_id: 'named-alpha',
        tool_name: 'exec_command',
        cwd,
        tool_input: { cmd: command },
      },
      { selfHost: () => ({ confidence: 'none' }) },
    );
  const command = `pnpm preview:process start --port 5311 --cwd ${f.mainRoot} -- ${child}`;
  const allowed = decide(command);
  assert.equal(allowed.decision, 'allow', JSON.stringify(allowed));
  assert.equal(allowed.target.value, `preview://alpha${f.mainRoot}:5311`);
  assert.equal(allowed.effect, 'service_mutation');
  for (const invalid of [
    `${command} --force`,
    `${command} --no-sync`,
    `${command} --env-file /tmp/evil`,
    `${command} --dir /tmp/arbitrary`,
    `${command} --branch feature`,
    `${command} --remote other`,
    command.replace('5311 --cwd', '3001 --cwd'),
    command.replace('15397', '6399'),
    command.replace('pnpm alpha:start', 'env CAT_CAFE_DEPLOYMENT_ID= pnpm alpha:start'),
  ])
    assert.equal(decide(invalid).decision, 'deny', invalid);
  assert.equal(decide(command, f.alphaRoot).decision, 'deny', 'launcher belongs to the actual main coordinate');
  writeFileSync(join(f.alphaRoot, 'scripts/alpha-worktree.sh'), '# dirty\n');
  assert.equal(decide(command).decision, 'deny', 'tracked dirty implementation cannot start');
});

test('named status/stop consume the existing launcher record coordinates without a start preflight', (t) => {
  const f = namedAlphaFixture(t);
  const stateDir = join(f.directory, 'preview-records');
  mkdirSync(stateDir);
  const prior = process.env.CAT_CAFE_PREVIEW_PROCESS_DIR;
  process.env.CAT_CAFE_PREVIEW_PROCESS_DIR = stateDir;
  t.after(() => {
    if (prior === undefined) delete process.env.CAT_CAFE_PREVIEW_PROCESS_DIR;
    else process.env.CAT_CAFE_PREVIEW_PROCESS_DIR = prior;
  });
  const id = createHash('sha256').update(`${f.mainRoot}\0${5311}`).digest('hex').slice(0, 16);
  const record = {
    version: 1,
    id,
    cwd: f.mainRoot,
    port: 5311,
    command: ['pnpm', 'alpha:start', '--instance', 'f290-communication', '--ports', NAMED_ALPHA_PORTS],
  };
  writeFileSync(join(stateDir, `${id}.json`), JSON.stringify(record));
  for (const action of ['status', 'stop']) {
    const verdict = decideNativeHookPayload(
      {
        tool_name: 'exec_command',
        cwd: '/tmp',
        tool_input: { cmd: `pnpm --dir ${f.mainRoot} preview:process ${action} --cwd ${f.mainRoot} --port 5311` },
      },
      { selfHost: () => ({ confidence: 'none' }) },
    );
    assert.equal(verdict.decision, 'allow', JSON.stringify(verdict));
    assert.equal(verdict.target.value, `preview://alpha${f.mainRoot}:5311`);
  }
  record.command[record.command.length - 1] = '5311,3002,5411,5511,6399';
  writeFileSync(join(stateDir, `${id}.json`), JSON.stringify(record));
  const verdict = decideNativeHookPayload(
    {
      tool_name: 'Bash',
      cwd: f.mainRoot,
      tool_input: { command: `pnpm --dir ${f.mainRoot} preview:process stop --cwd ${f.mainRoot} --port 5311` },
    },
    { selfHost: () => ({ confidence: 'none' }) },
  );
  assert.equal(verdict.decision, 'deny');
});

test('named start rejects path overrides and protected tuples before contacting any Redis', (t) => {
  const f = namedAlphaFixture(t);
  for (const args of [
    ['--ports', '5311,5312,5411,6399'],
    ['--ports', '05311,5312,5411,15397'],
    ['--ports', '5311,5311,5411,15397'],
    ['--ports', NAMED_ALPHA_PORTS, '--dir', f.alphaRoot],
    ['--ports', NAMED_ALPHA_PORTS, '--no-sync'],
  ]) {
    const result = f.run(['start', '--instance', 'f290-communication', ...args]);
    assert.notEqual(result.status, 0, result.stdout);
  }
  assert.equal(f.readCalls().includes('redis-cli '), false);
  const alias = join(f.directory, 'alias');
  symlinkSync(f.mainRoot, alias, 'dir');
  const result = spawnSync(
    'bash',
    [
      join(alias, 'scripts/alpha-worktree.sh'),
      'start',
      '--instance',
      'f290-communication',
      '--ports',
      NAMED_ALPHA_PORTS,
    ],
    { cwd: alias, env: f.env, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.equal(f.readCalls().includes('redis-cli '), false);
  assert.equal(readFileSync(join(f.mainRoot, '.gitignore'), 'utf8').includes('.cat-cafe/'), true);
});

test('named init creates only its main-derived registered checkout and preserves a legacy Alpha', (t) => {
  const f = namedAlphaFixture(t);
  const legacy = join(f.directory, 'cat-cafe-main-test');
  f.git(['worktree', 'add', '-b', 'main-test/main-sync', legacy, 'origin/main']);
  mkdirSync(join(legacy, '.cat-cafe/redis'), { recursive: true });
  const sentinel = join(legacy, '.cat-cafe/redis/dump.rdb');
  writeFileSync(sentinel, 'preserve damaged original');
  const created = join(f.directory, 'cat-cafe-alpha-new-site');
  const result = f.run(['init', '--instance', 'new-site', '--ports', NAMED_ALPHA_PORTS], { cwd: f.directory });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git(['branch', '--show-current'], created), 'alpha/new-site-main-sync');
  assert.equal(f.git(['rev-parse', 'HEAD'], created), f.git(['rev-parse', 'origin/main']));
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve damaged original');
  assert.equal(f.readCalls().includes('redis-cli '), false);
  assert.equal(existsSync(legacy), true);
  const finish = { repo: f.mainRoot, path: created, owner: f.env.CAT_CAFE_CAT_ID, sourceRef: 'task:alpha-init' };
  const { lifecycle } = ownedWorktreeFacts(finish);
  assert.equal(lifecycle.policy, 'merged');
  assert.ok(Number.isFinite(Date.parse(lifecycle.createdAt)));
  assert.equal(lifecycleConfig(f.mainRoot, '--local')?.owner, undefined, 'declaration is private to the new tree');
  const repeated = f.run(['init', '--instance', 'new-site', '--ports', NAMED_ALPHA_PORTS], {
    env: { CAT_CAFE_CAT_ID: 'another-caller' },
  });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(lifecycleConfig(created, '--worktree'), lifecycle, 'existing owner and birth stay unchanged');
  assert.equal(finishWorktree(finish).storageDisposition, 'removed');
  assert.equal(finishWorktree({ ...finish, mode: 'check' }).state, 'released');
  assert.equal(existsSync(created), false);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve damaged original');
});

for (const failure of ['missing owner', 'shared-only config']) {
  test(`named init refuses ${failure} before creating an undeclared checkout`, (t) => {
    const f = namedAlphaFixture(t);
    if (failure === 'shared-only config') f.git(['config', 'extensions.worktreeConfig', 'false']);
    const result = f.run(['init', '--instance', 'undeclared', '--ports', NAMED_ALPHA_PORTS], {
      env: failure === 'missing owner' ? { CAT_CAFE_CAT_ID: '' } : {},
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, failure === 'missing owner' ? /invalid --owner/ : /worktreeConfig/);
    assert.equal(existsSync(join(f.directory, 'cat-cafe-alpha-undeclared')), false);
    assert.equal(f.git(['branch', '--list', 'alpha/undeclared-main-sync']), '');
    assert.equal(f.readCalls(), '', 'refusal happens before dependency installation or service probes');
  });
}

test('a main advance during compilation cannot widen the once-frozen named Alpha target', (t) => {
  const f = namedAlphaFixture(t);
  f.captureChild();
  const frozen = f.git(['rev-parse', 'origin/main']);
  writeFileSync(join(f.mainRoot, 'next-main'), 'a later independently committed main');
  f.git(['add', 'next-main']);
  f.git(['commit', '-m', 'concurrent main advance']);
  const next = f.git(['rev-parse', 'HEAD']);
  const pnpm = join(f.directory, 'bin/pnpm');
  writeFileSync(pnpm, `${readFileSync(pnpm, 'utf8')}\ngit -C "$ALPHA_TEST_MAIN_ROOT" push origin main >/dev/null\n`, {
    mode: 0o755,
  });
  const result = f.run(['start', '--instance', 'f290-communication', '--ports', NAMED_ALPHA_PORTS], {
    env: { ALPHA_TEST_MAIN_ROOT: f.mainRoot },
  });
  const env = f.childEnvironment(result);
  assert.equal(JSON.parse(env.CAT_CAFE_ALPHA_COORDINATES).targetSha, frozen);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.alphaRoot), frozen);
  assert.equal(f.git(['rev-parse', 'origin/main']), next);
});

test('a live process in the named checkout prevents a new tuple from rebuilding its serving tree', async (t) => {
  const f = namedAlphaFixture(t);
  const serving = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: f.alphaRoot, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    serving.once('spawn', resolve);
    serving.once('error', reject);
  });
  t.after(() => serving.kill());
  const tuple = '5321,5322,5421,15407';
  const command = `pnpm preview:process start --port 5321 --cwd ${f.mainRoot} -- pnpm alpha:start --instance f290-communication --ports ${tuple}`;
  const decision = decideNativeHookPayload(
    { turn_id: 'serving-alpha', tool_name: 'exec_command', cwd: f.mainRoot, tool_input: { cmd: command } },
    { selfHost: () => ({ confidence: 'none' }) },
  );
  assert.equal(decision.decision, 'deny');
  const start = f.run(['start', '--instance', 'f290-communication', '--ports', tuple]);
  assert.notEqual(start.status, 0);
  assert.match(start.stderr, /checkout has a live process/);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.alphaRoot), f.head);
  assert.doesNotMatch(f.readCalls(), /pnpm|redis-cli/);
});

test('named lifecycle cannot blindly borrow another instance preview key or sync a serving tree', (t) => {
  const f = namedAlphaFixture(t);
  for (const command of ['stop', 'status', 'sync']) {
    const result = f.run([command, '--instance', 'f290-communication', '--ports', NAMED_ALPHA_PORTS]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only init\/start/);
  }
  assert.equal(f.readCalls(), '');
});
