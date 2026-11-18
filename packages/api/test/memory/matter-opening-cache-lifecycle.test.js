import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { matterOpeningDirectory } from '../../dist/domains/memory/matters/matter-opening-directory.js';
import { failCatalog, fixture, items, read } from '../helpers/matter-opening-cache-fixture.js';

test('a real 1650ms synchronous stall fails fresh work but the next budget restores a verified directory', async (t) => {
  const f = await fixture(t);
  await f.create('survives synchronous load', 'verified interpretation');
  await read(f.service);
  const catalog = f.service.catalog.bind(f.service);
  t.mock.method(f.service, 'catalog', async (...args) => {
    const start = performance.now();
    while (performance.now() - start < 1650) {
      /* an isolated shared-loop stall */
    }
    return catalog(...args);
  });
  const warnings = [];
  const text = await read(f.service, { logger: { warn: (fields) => warnings.push(fields) } });
  assert.match(text, /缓存/);
  assert.match(text, /survives synchronous load/);
  assert.match(text, /verified interpretation/);
  assert.equal(warnings[0].stopReason, 'source_work_budget');
  assert.ok(warnings[0].elapsedMs >= 1500);
});

test('bounded scopes evict the oldest success without changing another scope', async (t) => {
  const f = await fixture(t);
  await f.create('scoped directory');
  await read(f.service);
  for (let i = 0; i < 128; i++) {
    await matterOpeningDirectory(f.service, 'owner', 'codex61-sol', `scope-${i}`);
  }
  failCatalog(t, f.service);
  assert.match(await read(f.service), /当前目录不可用/);
  const latest = await matterOpeningDirectory(f.service, 'owner', 'codex61-sol', 'scope-127');
  assert.match(latest, /缓存/);
  assert.match(latest, /scoped directory/);
});

test('final revalidation catches a source revoked while a later cached page is being read', async (t) => {
  const f = await fixture(t);
  const pages = [await f.create('first title', 'first summary'), await f.create('second title', 'second summary')];
  const warm = items(await read(f.service));
  const revoked = pages.find((page) => page.matterId === warm[0].matterId);
  failCatalog(t, f.service);
  const original = f.service.project.bind(f.service);
  let calls = 0;
  t.mock.method(f.service, 'project', async (...args) => {
    const result = await original(...args);
    if (++calls === 2) revoked.message.recall = { recalledAt: Date.now() };
    return result;
  });
  const text = await read(f.service);
  assert.equal(items(text).length, 1);
  assert.ok(!text.includes(revoked.matterId));
  assert.doesNotMatch(text, new RegExp(revoked.message.id));
  assert.ok(calls > 2);
});

test('fresh work and cache revalidation each have a 1500ms budget and late work cannot publish', async (t) => {
  const f = await fixture(t);
  await f.create('BOUNDED title');
  await read(f.service);
  let clock = 0,
    freshEntered,
    cacheEntered,
    releaseFresh,
    releaseCache;
  const freshStarted = new Promise((resolve) => {
    freshEntered = resolve;
  });
  const cacheStarted = new Promise((resolve) => {
    cacheEntered = resolve;
  });
  const freshPause = new Promise((resolve) => {
    releaseFresh = resolve;
  });
  const cachePause = new Promise((resolve) => {
    releaseCache = resolve;
  });
  t.mock.method(f.service, 'catalog', async () => {
    freshEntered();
    return freshPause;
  });
  const originalSource = f.service.discoverySource.bind(f.service);
  let validationSignal;
  t.mock.method(f.service, 'discoverySource', (reader, options) => {
    validationSignal = options.signal;
    const source = originalSource(reader, options),
      project = source.project;
    source.project = async (candidate) => {
      cacheEntered();
      await cachePause;
      return project(candidate);
    };
    return source;
  });
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings = [];
  let done = false;
  const result = read(f.service, { logger: { warn: (fields) => warnings.push(fields) } }).then((text) => {
    done = true;
    return text;
  });
  try {
    await freshStarted;
    clock = 1500;
    t.mock.timers.tick(1500);
    assert.equal(await Promise.race([cacheStarted.then(() => 'cache'), result.then(() => 'finished')]), 'cache');
    clock = 2999;
    t.mock.timers.tick(1499);
    await setImmediate();
    assert.equal(done, false);
    clock = 3000;
    t.mock.timers.tick(1);
    const text = await result;
    assert.match(text, /当前目录不可用/);
    assert.doesNotMatch(text, /BOUNDED/);
    assert.equal(validationSignal.aborted, true);
    assert.equal(warnings[0].elapsedMs, 1500);
    assert.equal(warnings[0].budgetMs, 1500);
  } finally {
    releaseFresh({ items: [] });
    releaseCache();
    await result;
    await setImmediate();
  }
});
