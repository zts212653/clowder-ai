import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { executedInvocations } from '../../../scripts/lib/shell-invocation.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { assertGuardedOrUnproved } from './helpers/native-effect-policy-assertions.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-call-contract-')));
const main = join(root, 'cat-cafe');
const runtime = join(root, 'cat-cafe-runtime');
mkdirSync(main);
mkdirSync(runtime);
after(() => rmSync(root, { recursive: true, force: true }));
const noHost = { selfHost: () => ({ confidence: 'none' }) };
function parity(command, expected, cwd = main) {
  for (const tool_name of ['Bash', 'exec_command']) {
    const result = decideNativeHookPayload({ tool_name, cwd, tool_input: { command, cmd: command } }, noHost);
    if (expected === 'unproved') assertGuardedOrUnproved(result, command);
    else assert.equal(result.decision, expected, `${tool_name}: ${command}: ${JSON.stringify(result)}`);
  }
}

// Census source874, PATH-is-data probe. This is classification, never protected execution.
test('PATH search coordinates remain execution configuration, not a write target', () => {
  const systemPath = `${dirname(process.execPath)}:/usr/bin:/bin`;
  for (const prefix of [`PATH=${runtime}/scripts/guarded-bin:${systemPath}`, `env PATH=${runtime}/bin:${systemPath}`]) {
    parity(`${prefix} node -e 'console.log(1)'`, 'allow');
    parity(`${prefix} node -e 'console.log("${runtime}")' > /tmp/f306-output`, 'allow');
    parity(`${prefix} printf '%s' 'runtime:restart' > /tmp/f306-output`, 'allow');
    parity(`${prefix} printf x > ${runtime}/sentinel`, 'deny');
    parity(`${prefix} git push --force origin main`, 'deny');
    parity(`${prefix} sort -o /tmp/f306-output /tmp/input`, 'unproved', runtime);
  }
  parity(`NODE_OPTIONS='--require ${runtime}/loader.js' node -e 'console.log(1)'`, 'unproved');
  parity(`env BASH_ENV=${runtime}/bootstrap sh -c 'echo x'`, 'unproved');
  parity(`env -C ${runtime} PATH=/usr/bin node -e 'console.log(1)'`, 'unproved');
  parity(`PATH=/usr/bin node ${runtime}/code.js`, 'unproved');
  parity(`PATH=/usr/bin node -r ${runtime}/loader.js /tmp/code.js`, 'unproved');
  parity(`PATH=${runtime}/bin eval 'rm -rf ${runtime}'`, 'deny');
  parity(`PATH=${runtime}/bin $PROGRAM ${runtime}`, 'unproved');
});

test('the shared reader preserves program, environment, code and redirection roles', () => {
  const raw = `env PATH=${runtime}/bin:/usr/bin node -e 'console.log(1)' > /tmp/f306-output`;
  const reader = executedInvocations(raw, { cwd: main });
  const call = reader.directInvocations[0];
  assert.equal(reader.complete, true);
  assert.equal(call.program, 'node');
  assert.deepEqual(call.environment, [`PATH=${runtime}/bin:/usr/bin`]);
  assert.deepEqual(call.operands, ['-e', 'console.log(1)']);
  assert.equal(call.redirections[0].operand.value, '/tmp/f306-output');
});

// Source thread_mum3ld39n6eu6fga#0001791014694622-001790-7917f757.
test('standard Alpha accepts launcher options and equivalent outer package coordinates', () => {
  for (const outer of ['pnpm', `pnpm --dir ${main}`]) {
    for (const child of [
      'pnpm alpha:start',
      'pnpm alpha:start -- --no-quick',
      'pnpm alpha:start --no-quick',
      'env CAT_CAFE_API_PORT=3012 CAT_CAFE_WEB_PORT=3011 pnpm alpha:start',
    ])
      parity(`${outer} preview:process start --cwd ${main} --port 3011 -- ${child}`, 'allow');
    for (const action of ['status', 'stop'])
      parity(`${outer} preview:process ${action} --cwd ${main} --port 3011`, 'allow');
  }
  parity(`pnpm --dir ${main} preview:process status --cwd ${main} --port 3011 && git status --short`, 'allow');
});

test('Alpha configuration and child identity remain bounded', () => {
  const protectedRuntimeApiPort = 3002;
  for (const child of [
    `env CAT_CAFE_API_PORT=${protectedRuntimeApiPort} pnpm alpha:start`,
    'env REDIS_URL=redis://localhost:6399 pnpm alpha:start',
    'pnpm alpha:start -- --ports 3001,3002,4100,4111,6399',
  ])
    parity(`pnpm preview:process start --cwd ${main} --port 3011 -- ${child}`, 'deny');
  for (const child of [
    'env NODE_OPTIONS=--require=/tmp/load.js pnpm alpha:start',
    'pnpm alpha:start -- --dir /tmp/other',
    'node /tmp/preview.js',
  ])
    parity(`pnpm preview:process start --cwd ${main} --port 3011 -- ${child}`, 'allow');
  parity(`pnpm --dir ${runtime} preview:process start --cwd ${runtime} --port 3011 -- pnpm alpha:start`, 'deny');
  parity(`pnpm --dir ${runtime} preview:process start --cwd ${main} --port 3011 -- pnpm alpha:start`, 'deny');
});

test('data, readonly coordinates and protected rewrites retain continuity', () => {
  parity(`python3 -c 'print("pnpm runtime:restart")'`, 'allow');
  parity(`node -e 'console.log("kill -TERM 123456")'`, 'allow');
  parity(`cat ${runtime}/package.json`, 'allow');
  parity('redis-cli -p 6399 GET example', 'allow');
  parity('redis-cli -p 6399 SET example x', 'deny');
  parity('git fetch origin +feature:refs/heads/main', 'deny');
  parity(`rm -rf ${runtime}`, 'deny');
});
