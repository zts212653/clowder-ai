import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { type TestContext, test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import type { DesktopWindowFailure } from '../src/domains/plugin/desktop-window-runtime/types.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { desktopWindowFixture } from './f317-window.fixture.js';

type Fault = 'lease-expired' | 'grant-changed' | 'snapshot-io' | 'seal-missing' | 'observation-expired';

async function failedObservation(t: TestContext, fault: Fault) {
  const f = await desktopWindowFixture();
  let now = 2_000;
  let polls = 0;
  let closes = 0;
  let releases = 0;
  let root = '';
  let failSnapshot = false;
  const failures: DesktopWindowFailure[] = [];
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    messageStore: new MessageStore(),
    now: () => now,
    onDesktopFailure: (_id, failure) => {
      failures.push(failure);
      if (fault === 'snapshot-io') throw new Error('reporter failure must not stop cleanup');
    },
    desktopExecutor: {
      open: async (spec) => {
        spec.signal.addEventListener('abort', () => spec.onClosed(), { once: true });
        return {
          poll: async () => {
            if (++polls === 2) {
              if (fault === 'lease-expired') now += 122_000;
              if (fault === 'seal-missing') await rm(root, { recursive: true });
            }
            return 'visible' as const;
          },
          show: async () => {},
          close: async () => {
            closes++;
          },
        };
      },
    },
  });
  t.after(async () => {
    await runtime.shutdown();
    await f.cleanup();
  });
  const locate = runtime.packages.resolveInstalledPackage.bind(runtime.packages);
  runtime.packages.resolveInstalledPackage = async (digest) => {
    const pkg = await locate(digest);
    root = pkg.rootDir;
    return {
      ...pkg,
      verifyStaticIntegrity: async () => {
        await (pkg.verifyStaticIntegrity?.() ?? pkg.verifyIntegrity());
        if (polls === 2 && fault === 'observation-expired') {
          await new Promise((resolve) => setTimeout(resolve, 30));
          now += 15_001;
        }
      },
      release: async () => {
        releases++;
        await pkg.release();
      },
    };
  };
  const snapshot = runtime.brokerStore.snapshot.bind(runtime.brokerStore);
  runtime.brokerStore.snapshot = async () => {
    if (failSnapshot) {
      failSnapshot = false;
      throw Object.assign(new Error('owner-content nonce=TEST_SECRET_TOKEN /private/owner/source'), { code: 'EIO' });
    }
    return snapshot();
  };
  const renew = runtime.broker.renewRuntimeLease.bind(runtime.broker);
  runtime.broker.renewRuntimeLease = async (connectionId) => {
    const expiry = await renew(connectionId);
    if (polls === 2) {
      if (fault === 'snapshot-io') failSnapshot = true;
      if (fault === 'grant-changed') {
        await runtime.inventoryStore.transaction((tx) => {
          const session = awaitSnapshot.sessions.find((row) => row.connectionId === connectionId);
          assert.ok(session);
          const grants = tx.grants.get(session.pluginInstanceId);
          assert.ok(grants);
          tx.grants.put({ ...grants, grantRevision: grants.grantRevision + 1, effectiveGrants: [] });
        });
      }
    }
    return expiry;
  };
  const installer = new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [f.entry],
    fetchArchive: async () => f.bytes,
  });
  const installed = await installer.install(f.entry.catalogId, f.entry);
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  const awaitSnapshot = await snapshot();
  const oldLease = awaitSnapshot.staticFeatures?.leases.at(-1);
  assert.ok(oldLease);
  assert.ok(runtime.desktopWindows);
  await assert.rejects(runtime.desktopWindows.show());
  for (let i = 0; i < 100 && releases === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(failures.length, 1, 'abort reentry cannot replace the first observer failure');
  assert.equal(closes, 1, 'even a throwing reporter must leave the physical window closed');
  assert.equal(releases, 1);
  assert.equal(await runtime.desktopWindows.presence(), null);
  await assert.rejects(
    runtime.desktopWindows.features.run(oldLease.executionLease, async () => assert.fail('old effect')),
  );
  const after = await snapshot();
  assert.equal(after.sessions[0]?.phase, 'closed');
  assert.equal(after.staticFeatures?.leases.at(-1)?.state, 'revoked');
  const serialized = JSON.stringify(failures[0]);
  for (const secret of [
    'TEST_SECRET_TOKEN',
    'owner-content',
    '/private/owner',
    oldLease.executionLease,
    oldLease.runtimeLeaseId,
  ])
    assert.equal(serialized.includes(secret), false, secret);
  assert.ok(serialized.length < 8_192, 'failure evidence is bounded');
  const failure = failures[0];
  assert.ok(failure);
  return failure;
}

const cases = [
  ['lease-expired', 'lease-renew', 'lease-renew', 'SESSION_NOT_ACTIVE'],
  ['grant-changed', 'authority', 'authority-check', 'AUTHORITY_CHANGED'],
  ['snapshot-io', 'authority', 'feature-snapshot', 'EIO'],
  ['seal-missing', 'authority', 'package-verification', 'ENOENT'],
  ['observation-expired', 'authority', 'observation-publish', undefined],
] as const;

for (const [fault, phase, stage, code] of cases) {
  test(`${fault}: the running failure outlet retains the originating error and bounded substage timings`, async (t) => {
    const failure = await failedObservation(t, fault);
    assert.equal(failure.initiator, 'host-observer');
    assert.equal(failure.reason, 'poll-failed', 'the established public failure vocabulary stays unchanged');
    const observation = failure.observation;
    assert.ok(observation);
    assert.equal(observation.phase, phase);
    assert.equal(observation.pending, false);
    assert.ok(observation.error, 'the original exception must survive the actual runtime lost() outlet');
    const stages = observation.stages;
    assert.ok(stages);
    const origin = stages.find((entry) => entry.stage === stage);
    assert.equal(origin?.status, 'failed', `the original ${stage} failure must not be flattened to poll-failed`);
    assert.equal(origin?.error?.code, code);
    assert.ok(stages.length <= 9);
    assert.ok(stages.every((entry) => Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0));
    if (fault === 'lease-expired') assert.equal(observation.error.sessionCloseReason, 'runtime_lease_expired');
    if (fault === 'observation-expired') {
      assert.equal(observation.error.reason, 'observation_expired');
      const verification = stages.find((entry) => entry.stage === 'package-verification');
      assert.ok(verification && verification.elapsedMs >= 20);
    }
    t.diagnostic(JSON.stringify({ fault, observation }));
  });
}
