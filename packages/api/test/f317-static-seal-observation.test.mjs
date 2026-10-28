import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { DesktopWindowObserver } from '../src/domains/plugin/desktop-window-runtime/observer.ts';
import { sealStaticPackage } from '../src/domains/plugin/external-runtime/static-package-seal.ts';

async function tree(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'f317-seal-observation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 20; i++) await fs.writeFile(join(root, `asset-${i}.txt`), `frozen-${i}`);
  return root;
}

function instrument(t, wrap) {
  const original = { lstat: fs.lstat, readdir: fs.readdir };
  t.after(() => {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  });
  for (const method of ['lstat', 'readdir']) fs[method] = (...args) => wrap(() => original[method](...args));
  syncBuiltinESMExports();
}

test('one seal check overlaps independent metadata without exceeding four outstanding filesystem requests', async (t) => {
  const root = await tree(t);
  const check = await sealStaticPackage(root, async () => {});
  let active = 0;
  let peak = 0;
  instrument(t, async (read) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await turn();
      return await read();
    } finally {
      active--;
    }
  });
  await check();
  assert.ok(peak > 1, 'independent metadata must not consume freshness one file at a time');
  assert.ok(peak <= 4, 'metadata concurrency stays bounded');
});

test('concurrent consumers share the generation IO budget without reusing an earlier successful check', async (t) => {
  const root = await tree(t);
  const check = await sealStaticPackage(root, async () => {});
  let active = 0;
  let peak = 0;
  instrument(t, async (read) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await turn();
      return await read();
    } finally {
      active--;
    }
  });
  await Promise.all(Array.from({ length: 8 }, check));
  assert.ok(peak <= 4, 'one private generation has one bounded IO budget across consumers');
  await fs.writeFile(join(root, 'asset-0.txt'), 'tampered');
  const results = await Promise.allSettled(Array.from({ length: 8 }, check));
  assert.ok(results.every((result) => result.status === 'rejected'));
  await fs.writeFile(join(root, 'asset-0.txt'), 'frozen-0');
  await assert.rejects(check(), /damaged/, 'restoring bytes cannot reseal a damaged generation');
});

test('independent metadata latency does not unnecessarily expire a genuine poll; stale polls still fail closed', async (t) => {
  const root = await tree(t);
  const check = await sealStaticPackage(root, async () => {});
  let now = 2_000;
  instrument(t, async (read) => {
    // Model a 900ms asynchronous metadata service. Concurrent requests can
    // complete in the same virtual wave; no wall-clock timeout assertion.
    const readyAt = now + 900;
    await turn();
    const result = await read();
    now = Math.max(now, readyAt);
    return result;
  });
  let extraDelay = 0;
  const probe = new DesktopWindowObserver({
    id: 'fixture',
    lease: 'lease',
    freshnessMs: 15_000,
    now: () => now,
    isCurrent: () => true,
    window: { poll: async () => 'visible' },
    connection: { renewRuntimeLease: async () => {} },
    features: {
      run: async (_lease, publish) => {
        await check();
        now += extraDelay;
        await publish({ contributionIds: ['window'] });
      },
    },
  });
  await probe.observe();
  assert.equal(probe.observation?.state, 'visible');
  assert.equal(probe.observation?.expiresAt - probe.observation?.observedAt, 15_000);
  extraDelay = 15_001;
  await assert.rejects(probe.observe(), /observation expired/, 'slow authority never makes an old reply fresh');
  assert.equal(probe.diagnostic().error.reason, 'observation_expired');
});

test('a failed parallel scan drains its other readers before returning the original rejection', async (t) => {
  const root = await tree(t);
  const check = await sealStaticPackage(root, async () => {});
  const lstat = fs.lstat;
  const fault = Object.assign(new Error('fixture IO failure'), { code: 'EIO' });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let active = 0;
  fs.lstat = async (path, ...args) => {
    active++;
    try {
      if (String(path).endsWith('/asset-0.txt')) throw fault;
      if (String(path).endsWith('/asset-1.txt')) {
        enter();
        await held;
      }
      return await lstat(path, ...args);
    } finally {
      active--;
    }
  };
  syncBuiltinESMExports();
  t.after(() => {
    release();
    fs.lstat = lstat;
    syncBuiltinESMExports();
  });
  let settled = false;
  const failed = check().then(
    () => assert.fail('failed scan admitted'),
    (error) => {
      settled = true;
      return error;
    },
  );
  const siblingStarted = await Promise.race([entered.then(() => true), failed.then(() => false)]);
  assert.equal(siblingStarted, true, 'independent siblings must start before a failed walk can settle');
  await turn();
  assert.equal(settled, false, 'pending sibling IO must finish before cleanup can remove the tree');
  let secondRejected = false;
  const second = check().catch((error) => {
    secondRejected = /damaged/.test(error.message);
  });
  await turn();
  assert.equal(secondRejected, true, 'first IO failure latches damage before draining held siblings');
  release();
  assert.equal(await failed, fault);
  await second;
  assert.equal(active, 0);
  await assert.rejects(check(), /damaged/);
});

test('other seal IO can independently exhaust observation freshness without any store transaction', async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const pending = [];
  t.after(async () => {
    release();
    await Promise.allSettled(pending);
  });
  const root = await tree(t);
  const check = await sealStaticPackage(root, async () => {});
  let now = 2_000;
  let monotonic = 0;
  t.mock.method(performance, 'now', () => monotonic);
  let occupied = 0;
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const lstat = fs.lstat;
  instrument(t, async (read) => read());
  fs.lstat = async (path, ...args) => {
    if (String(path).includes('/asset-') && occupied < 4) {
      if (++occupied === 4) enter();
      await held;
    }
    return lstat(path, ...args);
  };
  syncBuiltinESMExports();
  pending.push(check());
  await entered;
  const observer = new DesktopWindowObserver({
    id: 'fixture',
    lease: 'lease',
    freshnessMs: 15_000,
    now: () => now,
    isCurrent: () => true,
    window: { poll: async () => 'visible' },
    connection: { renewRuntimeLease: async () => {} },
    features: {
      run: async (_lease, publish, diagnostics) => {
        await check(diagnostics.packageDiagnostics);
        await publish({ contributionIds: ['window'] });
      },
    },
  });
  const failed = assert.rejects(observer.observe(), /observation expired/);
  pending.push(failed);
  await turn(); // The newer consumer has queued behind the four held operations.
  now += 24_000;
  monotonic += 24_000;
  release();
  await Promise.all(pending);
  const diagnostic = observer.diagnostic();
  assert.equal(observer.observation, undefined);
  assert.equal(diagnostic.error.reason, 'observation_expired');
  assert.equal(diagnostic.costs.seal.maxQueueWaitMs, 24_000);
  assert.equal(diagnostic.costs.seal.longestQueueWait.slotWaitMs, 24_000);
  assert.equal(diagnostic.costs.seal.longestQueueWait.resumeDelayMs, 0);
  assert.equal(diagnostic.costs.seal.longestQueueWait.releasedBy.caller, 'other');
  assert.equal(diagnostic.costs.seal.longestQueueWait.releasedBy.operation, 'lstat');
  assert.equal(diagnostic.costs.seal.longestQueueWait.waitingAhead, 16);
  assert.equal(
    diagnostic.costs.seal.longestQueueWait.releasedBy.ioAwaitMs,
    0,
    'the final handoff is a later short read; the sixteen queued predecessors include the earlier stall',
  );
  assert.equal(diagnostic.costs.seal.ioPeak, 4);
  assert.equal(diagnostic.costs.seal.lstatCalls, 22, 'the newer consumer still completes the entire tree check');
});
