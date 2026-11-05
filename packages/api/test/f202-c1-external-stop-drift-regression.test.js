import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';
import { ExternalPluginRuntimeSupervisor } from '../dist/domains/plugin/external-runtime/index.js';
import {
  completeExternalHandshake,
  createExternalRuntimeHarness,
  EXTERNAL_INSTANCE_ID,
  externalManifest,
  FakePluginProcessAdapter,
} from './plugin-external-runtime-helpers.js';

/**
 * F202 Train C1 — the deliberate external-stop behavior change, pinned against a real
 * supervised child process rather than a recording double.
 *
 * The carrier router selects a carrier; it does not re-judge runnability
 * (`runtime-carrier.ts` §"Selection authority only"). The supervisor it removed that
 * judgement from used to run an authority fence *before* forwarding a stdio stop, so an
 * instance whose inventory authority had drifted could not be stopped at all: the fence
 * threw `INSTANCE_NOT_RUNNABLE`, the caller marked the instance failed, and the child
 * process stayed alive — an orphan the Host could no longer reach.
 *
 * `f202-c1-carrier-neutral-lifecycle.test.js` proves the router *delegates*; a recording
 * carrier can never prove the process is even asked to die. These cases own that half: a
 * real `ExternalPluginRuntimeSupervisor`, a real `PluginRuntimeCarrierRouter.stop()`, and
 * real inventory drift. Restoring the old fence turns them red; a recording carrier stays
 * green either way.
 *
 * Be exact about what is still a double, because the sin these cases exist to correct is a
 * test claiming more than it proved. `FakeExternalPluginProcess` is in-memory and its
 * `terminate()` resolves `exited` itself, so no OS process is ever reaped here. What is
 * genuinely pinned is the seam that regressed: stop reaches `terminate()` with no authority
 * fence in front of it, the execution is released, and a second stop is a no-op. Coverage of
 * a real reaped child belongs to the spawn-level suites, not to this drift regression.
 *
 * DRIFT_STATES are exactly the states the removed fence rejected even in its stop-tolerant
 * mode — it already allowed `disabling` / `error` / `disabled` activation, so those would
 * pass with or without the fence and prove nothing.
 */
const DRIFT_STATES = [
  {
    name: 'retired while its process is still running',
    patch: { lifecycleState: 'retired', retiredAt: 2_000 },
    // Measured, not assumed: a retired instance keeps `healthy` after its child is gone,
    // because every runtime-state writer fences on `lifecycleState === 'installed'`. The
    // process does die — the inventory row is what stays stale. Reported as its own finding;
    // pinned here so the residue is visible in code instead of only in review prose, and so
    // closing it has to come back through this case.
    expectedRuntimeState: 'healthy',
  },
  {
    name: 'lost the configuration that admitted it',
    patch: { configReadiness: 'incomplete' },
    expectedRuntimeState: 'stopped',
  },
  {
    name: 'caught mid re-enable',
    patch: { activationState: 'enabling' },
    expectedRuntimeState: 'stopped',
  },
];

async function runningExternalInstance() {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-c1-stop-drift-'));
  const harness = await createExternalRuntimeHarness({ rootDir });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
  });
  const router = new PluginRuntimeCarrierRouter(harness.inventory);
  router.register(supervisor);

  const starting = router.start(EXTERNAL_INSTANCE_ID);
  const child = await processes.nextProcess();
  await completeExternalHandshake(child);
  await starting;

  return { ...harness, child, processes, router, supervisor };
}

async function driftAuthority(inventory, patch) {
  await inventory.transaction((transaction) => {
    const instance = transaction.instances.get(EXTERNAL_INSTANCE_ID);
    transaction.instances.put({ ...instance, ...patch, updatedAt: 2_000 });
  });
}

async function instanceRecord(inventory) {
  const snapshot = await inventory.snapshot();
  return snapshot.instances.find((candidate) => candidate.pluginInstanceId === EXTERNAL_INSTANCE_ID);
}

for (const drift of DRIFT_STATES) {
  test(`terminates, unfenced, the process of an instance that has ${drift.name}`, async () => {
    const running = await runningExternalInstance();
    assert.equal(running.child.terminateCalls, 0, 'precondition: the child is alive before the drift');

    await driftAuthority(running.inventory, drift.patch);

    // The old fence threw INSTANCE_NOT_RUNNABLE here and left the child running.
    await running.router.stop(EXTERNAL_INSTANCE_ID, 'host_stop');

    assert.equal(running.child.terminateCalls, 1, 'the drifted child must actually be terminated');
    assert.deepEqual(await running.child.exited, { code: null, signal: 'SIGTERM' }, 'the process must really exit');
    assert.equal(
      (await instanceRecord(running.inventory)).runtimeState,
      drift.expectedRuntimeState,
      'the stop must complete as a stop, never leaving a failed-stop projection behind',
    );
    assert.equal(
      (await instanceRecord(running.inventory)).lastRuntimeError,
      undefined,
      'a deliberate stop must not be recorded as a runtime failure',
    );

    // Active authority is released, so a second stop is a no-op rather than a second kill.
    await running.router.stop(EXTERNAL_INSTANCE_ID, 'host_stop');
    assert.equal(running.child.terminateCalls, 1, 'the supervisor must no longer hold the execution');
    assert.equal(running.processes.processes.length, 1, 'stopping must not respawn the package');
  });
}
