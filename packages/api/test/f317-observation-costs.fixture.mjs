import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as turn } from 'node:timers/promises';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { desktopWindowFixture } from './f317-window.fixture.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Real staging/Broker/runtime failure outlet; only IO and the two clocks are controlled. */
export async function observationCostFailure(t, { snapshotMode = 'none', overlap = false, clockJump = 0 } = {}) {
  const f = await desktopWindowFixture();
  let wall = 2_000;
  let monotonic = 0;
  let polls = 0;
  let closes = 0;
  let releases = 0;
  let inject = false;
  let injectionEvents = 0;
  let heldReaders = 0;
  let presence;
  const readers = deferred();
  const drain = deferred();
  const failures = [];
  const advance = (ms) => {
    wall += ms;
    monotonic += ms;
  };
  t.mock.method(performance, 'now', () => monotonic);
  let runtime;
  const originals = { readFile: fs.readFile, lstat: fs.lstat, parse: JSON.parse, clone: structuredClone };
  t.after(async () => {
    drain.resolve();
    Object.assign(fs, { readFile: originals.readFile, lstat: originals.lstat });
    JSON.parse = originals.parse;
    globalThis.structuredClone = originals.clone;
    syncBuiltinESMExports();
    await runtime?.shutdown();
    await f.cleanup();
  });
  fs.readFile = async (...args) => {
    if (inject && snapshotMode === 'read' && String(args[0]) === runtime.brokerStore.path) {
      advance(35);
      injectionEvents++;
    }
    return originals.readFile(...args);
  };
  JSON.parse = (raw, ...args) => {
    if (inject && snapshotMode === 'parse' && typeof raw === 'string' && raw.includes('"sessions"')) {
      advance(45);
      injectionEvents++;
    }
    return originals.parse(raw, ...args);
  };
  globalThis.structuredClone = (value, ...args) => {
    if (inject && snapshotMode === 'clone' && value?.schemaVersion === 1 && Array.isArray(value.sessions)) {
      advance(55);
      injectionEvents++;
    }
    return originals.clone(value, ...args);
  };
  fs.lstat = async (...args) => {
    if (overlap && polls === 2 && heldReaders < 2) {
      heldReaders++;
      if (heldReaders === 1) readers.resolve();
      if (heldReaders === 2) drain.resolve();
      await drain.promise;
      advance(3);
    }
    return originals.lstat(...args);
  };
  syncBuiltinESMExports();
  // File stores capture their fileOps at construction. Install the controlled
  // read port first so the real store, rather than a later unused binding, uses it.
  runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    messageStore: new MessageStore(),
    now: () => wall,
    onDesktopFailure: (_id, failure) => {
      failures.push(failure);
    },
    desktopExecutor: {
      open: async (spec) => {
        spec.signal.addEventListener('abort', () => spec.onClosed(), { once: true });
        return {
          poll: async () => {
            polls++;
            return 'visible';
          },
          show: async () => {},
          close: async () => {
            closes++;
          },
        };
      },
    },
  });
  const snapshot = runtime.brokerStore.snapshot.bind(runtime.brokerStore);
  const renew = runtime.broker.renewRuntimeLease.bind(runtime.broker);
  let renewed = false;
  runtime.broker.renewRuntimeLease = async (connectionId) => {
    const expiry = await renew(connectionId);
    if (polls === 2) renewed = true;
    return expiry;
  };
  let injected = false;
  runtime.brokerStore.snapshot = async (diagnostics) => {
    if (polls !== 2 || !renewed || injected) return snapshot(diagnostics);
    injected = true;
    if (snapshotMode === 'queue') {
      const entered = deferred();
      const hold = deferred();
      const transaction = runtime.brokerStore.transaction(async () => {
        entered.resolve();
        await hold.promise;
      });
      await entered.promise;
      const pending = snapshot(diagnostics);
      await turn();
      advance(25);
      injectionEvents++;
      hold.resolve();
      await transaction;
      return pending;
    }
    inject = true;
    try {
      return await snapshot(diagnostics);
    } finally {
      inject = false;
    }
  };
  const locate = runtime.packages.resolveInstalledPackage.bind(runtime.packages);
  let verifyCalls = 0;
  let publicationReady = false;
  let publicationDelayed = false;
  const transaction = runtime.brokerStore.transaction.bind(runtime.brokerStore);
  runtime.brokerStore.transaction = (work) =>
    transaction(async (tx) => {
      // The final input refresh may legitimately replace an earlier reply after
      // slow preparation. To exercise the stale-publication failure outlet, spend
      // the15s inside the actual final transaction, after the last native reply.
      if (publicationReady && !publicationDelayed) {
        publicationDelayed = true;
        advance(15_001);
        wall += clockJump;
      }
      return work(tx);
    });
  runtime.packages.resolveInstalledPackage = async (digest) => {
    const pkg = await locate(digest);
    return {
      ...pkg,
      verifyStaticIntegrity: async (diagnostics) => {
        const current = polls === 2 ? ++verifyCalls : 0;
        await (pkg.verifyStaticIntegrity?.(diagnostics) ?? pkg.verifyIntegrity());
        if (current === 1) {
          if (presence) await presence;
          publicationReady = true;
        }
      },
      release: async () => {
        releases++;
        await pkg.release();
      },
    };
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
  const oldLease = (await snapshot()).staticFeatures.leases.at(-1);
  const failed = assert.rejects(runtime.desktopWindows.show(), /observation expired/);
  if (overlap) {
    await readers.promise;
    presence = runtime.ownerDesktop.presence();
  }
  await failed;
  for (let i = 0; i < 100 && releases === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(failures.length, 1);
  assert.equal(closes, 1);
  assert.equal(releases, 1);
  assert.equal(await runtime.desktopWindows.presence(), null);
  const after = await snapshot();
  assert.equal(after.sessions[0].phase, 'closed');
  assert.equal(after.staticFeatures.leases.at(-1).state, 'revoked');
  const failure = failures[0];
  if (snapshotMode !== 'none')
    assert.equal(injectionEvents, 1, 'the intended real snapshot operation was injected exactly once');
  assert.equal(failure.observation.error.reason, 'observation_expired');
  const serialized = JSON.stringify(failure);
  for (const secret of [f.root, oldLease.executionLease, oldLease.runtimeLeaseId, 'bindingNonce'])
    assert.equal(serialized.includes(secret), false);
  assert.ok(serialized.length < 12_288);
  return failure.observation;
}
