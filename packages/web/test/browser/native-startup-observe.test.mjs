import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

async function waitFailed(reportPath, pid) {
  const deadline = Date.now() + 150000;
  let state;
  while (Date.now() < deadline) {
    try {
      const current = JSON.parse(await fs.readFile(reportPath, 'utf8'));
      if (current.pid === pid) {
        assert.notEqual(current.phase, 'ready', 'An injected startup fault must never report ready');
        if (current.phase === 'failed') {
          state = current;
          break;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(250);
  }
  assert.ok(state, 'No durable failed report appeared within 150 seconds');
  return state;
}

function assertFault(state, fault) {
  assert.ok(state.message?.length, 'The native error must have a diagnostic reason');
  if (fault === 'occupied') {
    assert.match(state.message, /port .* already occupied/i);
    assert.ok(state.elapsedMs < 10000);
  } else if (fault === 'child-exit') {
    assert.match(state.message, /API.*(?:exit|42)/i);
    assert.ok(state.elapsedMs < 20000, 'A dead child must not consume the full readiness timeout');
  } else {
    assert.match(state.message, /API.*(?:timeout|within|120000|120s)/i);
    assert.ok(state.elapsedMs >= 119000 && state.elapsedMs < 135000, 'Keep the real 120s timeout unchanged');
  }
}

// Read-only observer for an explicitly launched, author-owned installed app.
// Fault preparation, exact-installation shutdown and payload restoration are
// separate, auditable steps. This test never starts/stops apps or changes data.
test('installed startup failure is observable before dismissing its native dialog', { timeout: 165000 }, async () => {
  const launchPath = process.env.CAT_CAFE_STARTUP_E2E_LAUNCH;
  assert.ok(launchPath && path.isAbsolute(launchPath), 'Supply the owned fault launch receipt');
  const launch = JSON.parse(await fs.readFile(launchPath, 'utf8'));
  assert.ok(['occupied', 'child-exit', 'timeout'].includes(launch.fault));
  assert.ok(Number.isInteger(launch.pid) && launch.pid > 0);
  const app = await fs.realpath(launch.app);
  const instance = await fs.realpath(launch.instance);
  assert.notEqual(app, instance);
  const marker = JSON.parse(await fs.readFile(path.join(app, 'desktop-instance.json'), 'utf8'));
  assert.equal(await fs.realpath(marker.CAT_CAFE_DESKTOP_INSTANCE_ROOT), instance);
  for (const key of ['FRONTEND_PORT', 'API_SERVER_PORT', 'REDIS_PORT']) {
    const port = Number(marker[key]);
    assert.ok(port > 1024 && port < 65536 && ![3003, 3004, 6399].includes(port));
  }
  const state = await waitFailed(path.join(instance, 'data/logs/startup-state.json'), launch.pid);
  assertFault(state, launch.fault);
  const result = {
    ...launch,
    failedState: state,
    observation: 'durable report while native error remains undisposed',
    nativeDialogPixelsVerified: false,
  };
  await fs.writeFile(`${launchPath}.observed.json`, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({ fault: launch.fault, pid: launch.pid, failedAfterMs: state.elapsedMs, reason: state.message }),
  );
});
