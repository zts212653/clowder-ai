import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { collect, interceptManifestReads, ownerManifestFixture } from './helpers/owner-manifest-fixture.js';

const faults = {
  missing: { mutate: (path) => fs.rm(path), error: /Incomplete content owner manifest/ },
  malformed: { mutate: (path) => fs.writeFile(path, '{broken'), error: SyntaxError },
  identity: {
    mutate: (path) => fs.writeFile(path, '{"contentRef":"another"}'),
    error: /Invalid content owner manifest identity/,
  },
  unreadable: {
    mutate: async (path) => {
      await fs.rm(path);
      await fs.mkdir(path);
    },
    error: /EISDIR/,
  },
};

for (const [name, fault] of Object.entries(faults)) {
  test(`${name} canonical row rejects only after the admitted batch drains, then a repaired scan is fresh`, async (t) => {
    const f = await ownerManifestFixture(t);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let admitted;
    const first = new Promise((resolve) => {
      admitted = resolve;
    });
    let failedPath;
    let originalBytes;
    const counter = interceptManifestReads(t, f, async ({ path, args, index, original }) => {
      if (index === 1) {
        failedPath = path;
        originalBytes = await original(path, ...args);
        await fault.mutate(path);
        admitted();
      } else await gate;
      return original(path, ...args);
    });
    let settled = false;
    const running = collect(f.store.retainedMediaHeads('owner'));
    running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = assert.rejects(running, fault.error);
    try {
      await first;
      await setImmediate();
      assert.equal(counter.stats().paths.length, 4);
      assert.equal(settled, false, 'the failed row cannot close its consumer while other reads are admitted');
    } finally {
      release();
      await rejected;
    }
    assert.equal(counter.stats().active, 0);
    assert.equal(counter.stats().paths.length, 4, 'failure admits no later batch');
    await fs.rm(failedPath, { recursive: true, force: true });
    await fs.writeFile(failedPath, originalBytes);
    assert.equal((await collect(f.store.retainedMediaHeads('owner'))).length, f.refs.length);
  });
}

test('early iterator return drains its batch and closes the directory without reading later batches', async (t) => {
  const f = await ownerManifestFixture(t);
  const originalOpen = fs.opendir;
  let closed = 0;
  fs.opendir = async (...args) => {
    const directory = await originalOpen(...args);
    if (String(args[0]) !== f.manifestRoot) return directory;
    const iterator = directory[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => iterator.next(),
      return: async () => {
        const value = await iterator.return();
        closed++;
        return value;
      },
    };
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.opendir = originalOpen;
    syncBuiltinESMExports();
  });
  const counter = interceptManifestReads(t, f, ({ path, args, original }) => original(path, ...args));
  const iterator = f.store.retainedMediaHeads('owner');
  assert.equal((await iterator.next()).done, false);
  assert.equal(counter.stats().paths.length, 4);
  assert.equal(counter.stats().active, 0);
  await iterator.return();
  assert.equal(closed, 1);
  assert.equal(counter.stats().paths.length, 4);
  assert.equal((await collect(f.store.retainedMediaHeads('owner'))).length, f.refs.length);
});
