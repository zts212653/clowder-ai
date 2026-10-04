import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from './lib/alpha-named-fixture.mjs';
import { decideNativeHookPayload } from './native-effect-target-guard.mjs';

test('canonical named Alpha launcher carries one tuple from actual main to isolated child', (t) => {
  const f = namedAlphaFixture(t);
  f.captureChild();
  writeFileSync(
    join(f.mainRoot, '.env'),
    'API_SERVER_PORT=3004\nFRONTEND_URL=http://foreign.invalid\nCOLLECTIVE_SERVICE_PORT=5211\nCAT_CAFE_DATA_DIR=/must-not-use\n',
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
  assert.equal(env.COLLECTIVE_SERVICE_PORT, '5511');
  assert.equal(env.REDIS_PORT, '15397');
  assert.equal(env.API_SERVER_HOST, '127.0.0.1');
  assert.equal(env.FRONTEND_URL, 'http://localhost:5311');
  assert.equal(env.NEXT_PUBLIC_COLLECTIVE_SERVICE_URL, 'http://127.0.0.1:5511');
  assert.equal(env.REDIS_DATA_DIR, join(f.alphaRoot, '.cat-cafe/redis'));
  assert.equal(env.CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED, '1');
  assert.equal(env.CAT_CAFE_DIRECT_NO_WATCH, '1');
  const coords = JSON.parse(env.CAT_CAFE_ALPHA_COORDINATES);
  assert.equal(coords.targetSha, f.git(['rev-parse', 'HEAD'], f.alphaRoot));
  assert.equal(coords.targetSha, f.git(['rev-parse', 'origin/main']));
  assert.equal(f.readCalls().includes('redis-cli '), false, 'fresh named startup never queries old Redis');
});

test('named Alpha preserves managed preview expiry across dotenv and does not mint one from dotenv', (t) => {
  const f = namedAlphaFixture(t);
  f.captureChild();
  writeFileSync(join(f.mainRoot, '.env'), 'CAT_CAFE_PREVIEW_EXPIRES_AT=forged-from-dotenv\n');
  const args = ['start', '--instance', 'f290-communication', '--ports', NAMED_ALPHA_PORTS];
  const expiry = new Date(Date.now() + 60_000).toISOString();
  assert.equal(
    f.childEnvironment(f.run(args, { env: { CAT_CAFE_PREVIEW_EXPIRES_AT: expiry } })).CAT_CAFE_PREVIEW_EXPIRES_AT,
    expiry,
  );
  assert.equal(f.childEnvironment(f.run(args)).CAT_CAFE_PREVIEW_EXPIRES_AT, '');
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

test('named start rejects path overrides and protected tuples before contacting any Redis', (t) => {
  const f = namedAlphaFixture(t);
  for (const args of [
    ['--ports', '5311,5312,5411,5511,6399'],
    ['--ports', '05311,5312,5411,5511,15397'],
    ['--ports', '5311,5311,5411,5511,15397'],
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
  const result = f.run(['init', '--instance', 'new-site', '--ports', NAMED_ALPHA_PORTS]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git(['branch', '--show-current'], created), 'alpha/new-site-main-sync');
  assert.equal(f.git(['rev-parse', 'HEAD'], created), f.git(['rev-parse', 'origin/main']));
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve damaged original');
  assert.equal(f.readCalls().includes('redis-cli '), false);
  assert.equal(existsSync(legacy), true);
});

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
  const tuple = '5321,5322,5421,5521,15407';
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
