import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matterOpeningDirectory } from '../../dist/domains/memory/matters/matter-opening-directory.js';
import { estimateTokens } from '../../dist/utils/token-counter.js';
import { actor, failCatalog, fixture, items, read } from '../helpers/matter-opening-cache-fixture.js';

test('a failed refresh serves the last successful directory with its original age and failure log', async (t) => {
  const f = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await f.create('cached title', 'cached summary');
  await read(f.service);
  const error = failCatalog(t, f.service),
    warnings = [],
    hits = [];
  now += 65000;
  const stale = await read(f.service, {
    invocationId: 'cache-fallback',
    logger: { warn: (fields) => warnings.push(fields), info: (fields) => hits.push(fields) },
  });
  assert.match(stale, /cached title/);
  assert.match(stale, /cached summary/);
  assert.match(stale, /缓存.*65\s*秒/);
  assert.equal(warnings[0].err, error);
  assert.equal(warnings[0].invocationId, 'cache-fallback');
  assert.deepEqual(hits[0], {
    invocationId: 'cache-fallback',
    threadId: 'here',
    catId: 'codex61-sol',
    ageSeconds: 65,
    retainedCount: 1,
    discardedCount: 0,
    renderedCount: 1,
  });
  now += 60000;
  assert.match(await read(f.service), /缓存.*125\s*秒/, 'fallback must not launder the snapshot age');
  assert.ok(estimateTokens(stale) <= 3072);
});

test('a first failure stays cold, while a successful empty directory is a reusable snapshot', async (t) => {
  const f = await fixture(t);
  const failure = t.mock.method(f.service, 'catalog', async () => {
    throw Error('cold');
  });
  assert.match(await read(f.service), /当前目录不可用/);
  failure.mock.restore();
  assert.equal(items(await read(f.service)).length, 0);
  failCatalog(t, f.service);
  const stale = await read(f.service);
  assert.match(stale, /缓存/);
  assert.match(stale, /cat_cafe_remember/);
  assert.equal(items(stale).length, 0);
});

test('cached entries remain isolated by user, cat, thread and service instance', async (t) => {
  const f = await fixture(t);
  await f.create('isolated title');
  await read(f.service);
  failCatalog(t, f.service);
  const project = t.mock.method(f.service, 'project', async () => {
    throw Error('wrong-scope-cache-used');
  });
  const cases = [
    [f.service, 'other-owner', 'codex61-sol', 'here'],
    [f.service, 'owner', 'codex-astra', 'here'],
    [f.service, 'owner', 'codex61-sol', 'elsewhere'],
    [{ catalog: f.service.catalog, project: f.service.project }, 'owner', 'codex61-sol', 'here'],
  ];
  for (const args of cases) {
    const text = await matterOpeningDirectory(...args);
    assert.doesNotMatch(text, /isolated title/);
    assert.match(text, /当前目录不可用/);
  }
  assert.equal(project.mock.callCount(), 0);
});

test('a fallback never replays newly private or recalled titles, summaries or IDs', async (t) => {
  const f = await fixture(t);
  const hidden = await f.create('PRIVATE title', 'PRIVATE summary');
  const recalled = await f.create('RECALLED title', 'RECALLED summary');
  await f.create('safe title');
  await read(f.service);
  hidden.message.visibility = 'whisper';
  hidden.message.whisperTo = ['codex-astra'];
  recalled.message.recall = { recalledAt: Date.now() };
  failCatalog(t, f.service);
  const hits = [];
  const stale = await read(f.service, { logger: { warn() {}, info: (fields) => hits.push(fields) } });
  assert.match(stale, /safe title/);
  assert.doesNotMatch(stale, /PRIVATE|RECALLED/);
  assert.ok(!stale.includes(hidden.matterId) && !stale.includes(recalled.matterId));
  assert.equal(items(stale).length, 1);
  assert.equal(hits[0].retainedCount, 1);
  assert.equal(hits[0].discardedCount, 2);
  assert.match(stale, /省略 2 条.*cat_cafe_search_evidence（不带 query）从头读取/);
  assert.ok(estimateTokens(stale) <= 3072);
});

test('changed sources or page revisions cannot carry an old interpretation into fallback', async (t) => {
  const f = await fixture(t);
  const changed = await f.create('CHANGED title', 'CHANGED summary');
  const revised = await f.create('REVISED title', 'REVISED summary');
  await f.create('still current');
  await read(f.service);
  changed.message.content += ' corrected';
  await f.service.write(actor, {
    operation: 'edit',
    requestId: 'correct-description',
    matterId: revised.matterId,
    expectedRevision: 1,
    title: 'new title',
    description: 'new summary',
  });
  failCatalog(t, f.service);
  const stale = await read(f.service);
  assert.match(stale, /still current/);
  assert.doesNotMatch(stale, /CHANGED|REVISED/);
});

test('unavailable permission checks fail closed without exposing cached pages', async (t) => {
  const f = await fixture(t);
  await f.create('UNVERIFIED title', 'UNVERIFIED summary');
  await read(f.service);
  failCatalog(t, f.service);
  t.mock.method(f.service, 'project', async () => {
    throw Error('source-read-failed');
  });
  const warnings = [];
  const stale = await read(f.service, { logger: { warn: (fields, message) => warnings.push({ fields, message }) } });
  assert.doesNotMatch(stale, /UNVERIFIED/);
  assert.match(stale, /当前目录不可用/);
  assert.equal(warnings[1].fields.err.message, 'source-read-failed');
  assert.equal(warnings[1].fields.stopReason, 'reader_rejected');
  assert.match(warnings[1].message, /cache revalidation unavailable/);
});

test('unchanged revisions and a remaining same-thread source cannot preserve a changed-source summary', async (t) => {
  const f = await fixture(t);
  const changed = await f.create('changed source remains readable', 'OLD interpretation');
  const stable = await f.create('stable source');
  await f.service.write(actor, {
    operation: 'append',
    requestId: 'append-stable',
    matterId: changed.matterId,
    expectedRevision: 1,
    sources: [
      {
        threadId: 'here',
        messageId: stable.message.id,
        segment: 'body',
        start: 0,
        end: stable.message.content.length,
        quote: stable.message.content,
      },
    ],
  });
  const warm = await read(f.service);
  assert.match(warm, /OLD interpretation/);
  const revision = items(warm).find((item) => item.matterId === changed.matterId).revision;
  changed.message.content += ' correction';
  failCatalog(t, f.service);
  const text = await read(f.service);
  const item = items(text).find((item) => item.matterId === changed.matterId);
  assert.equal(item.revision, revision);
  assert.equal(item.summaryStatus, 'sources_changed');
  assert.equal(item.threadSource, '含本线程来源');
  assert.doesNotMatch(text, /OLD interpretation/);
});

test('retired pages cannot be replayed from a successful snapshot', async (t) => {
  const f = await fixture(t);
  const retired = await f.create('RETIRED title', 'RETIRED summary');
  await f.create('active title');
  await read(f.service);
  await f.service.write(actor, {
    operation: 'retire',
    requestId: 'retire',
    matterId: retired.matterId,
    expectedRevision: 1,
  });
  failCatalog(t, f.service);
  const stale = await read(f.service);
  assert.match(stale, /active title/);
  assert.doesNotMatch(stale, /RETIRED/);
});
