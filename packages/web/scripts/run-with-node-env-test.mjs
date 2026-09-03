import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserTestResourceLease, commandRunsBrowserTests } from './browser-test-resource-lease.mjs';

const [cmd, ...args] = process.argv.slice(2);
const scriptPath = fileURLToPath(import.meta.url);
const gateResourceRunnerPath = resolve(dirname(scriptPath), '../../../scripts/run-with-gate-resource-permit.mjs');
const BROWSER_RESOURCE_STAGES = new Set(['standalone-web-browser', 'test-web-browser']);

if (!cmd) {
  console.error('Usage: node scripts/run-with-node-env-test.mjs <cmd> [...args]');
  process.exit(1);
}

function browserPermitState(env) {
  const held = env.CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD;
  const mode = env.CAT_CAFE_FULL_GATE_RESOURCE_MODE;
  const stage = env.CAT_CAFE_FULL_GATE_RESOURCE_STAGE;
  const hasMarker = held !== undefined || mode !== undefined || stage !== undefined;
  if (!hasMarker) return 'absent';
  if (held === '1' && mode === 'exclusive' && BROWSER_RESOURCE_STAGES.has(stage)) return 'held';
  return 'invalid';
}

async function spawnAndRelay(command, commandArgs, env, lease = null) {
  const child = spawn(command, commandArgs, {
    stdio: 'inherit',
    env,
  });

  let forwardedSignal = null;
  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      forwardedSignal = signal;
      child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  const result = await new Promise((resolveChild) => {
    child.on('error', (error) => resolveChild({ code: 1, error, signal: null }));
    child.on('exit', (code, signal) => resolveChild({ code, error: null, signal }));
  });
  await lease?.release();
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);

  if (result.error) console.error(result.error);
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if (forwardedSignal) {
    process.kill(process.pid, forwardedSignal);
    return;
  }
  process.exit(result.code ?? 1);
}

const runsBrowserTests = commandRunsBrowserTests(args);
if (runsBrowserTests && existsSync(gateResourceRunnerPath)) {
  const permitState = browserPermitState(process.env);
  if (permitState === 'invalid') {
    console.error(
      'Browser tests require an exclusive browser-stage gate resource permit; refusing a partial or mismatched marker.',
    );
    process.exit(1);
  }
  if (permitState === 'absent') {
    await spawnAndRelay(
      process.execPath,
      [
        gateResourceRunnerPath,
        '--mode',
        'exclusive',
        '--stage',
        'standalone-web-browser',
        '--',
        process.execPath,
        scriptPath,
        cmd,
        ...args,
      ],
      process.env,
    );
  }
}

// In the home repository, both standalone and full-gate browser commands have
// already crossed the same exclusive host-heavy admission boundary. Keeping the
// old browser-only lock here would create a second, differently ordered lock and
// preserve the deadlock surface the canonical pool replaced. Published/package
// copies do not contain the repository runner, so they retain the compatibility
// lease as a fail-closed fallback.
const browserTestLease =
  runsBrowserTests && !existsSync(gateResourceRunnerPath) ? await acquireBrowserTestResourceLease() : null;

await spawnAndRelay(
  cmd,
  args,
  {
    ...process.env,
    CAT_CAFE_DEPLOYMENT_ID: 'test',
    NODE_ENV: 'test',
  },
  browserTestLease,
);
