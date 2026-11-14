import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens } from '../../dist/utils/token-counter.js';
import { preparationFixture as fixture } from '../helpers/work-preparation-fixture.js';

test('preparation stays unknown until exact scoped original-source read; retries do not fabricate events', async (t) => {
  const f = fixture(t);
  const response = await f.post('prepare', { activity: 'video', query: 'paper sequence' });
  assert.equal(response.statusCode, 200);
  const prep = response.json();
  assert.equal(prep.delivery, 'unknown');
  assert.ok(estimateTokens(JSON.stringify(prep)) <= 900);
  assert.equal(prep.pointers.length, 2);
  assert.ok(f.nativeReads.every((limit) => limit <= 20));
  assert.equal(f.opportunities.get(prep.opportunityId)?.occurredAt, 1000);
  const pointer = prep.pointers[0];
  const handle = pointer.read.handle;
  assert.deepEqual(f.episodes.listByCue('owner', pointer.cueId), []);
  assert.equal((await f.post('outcome', { handle, requestId: 'out-0', outcome: 'applied' })).statusCode, 409);
  for (const headers of [
    { 'x-test-cat': 'kimi31-pro' },
    { 'x-test-thread': 'other' },
    { 'x-test-invocation': 'other' },
  ])
    assert.equal((await f.post('drill', { handle, requestId: 'foreign' }, headers)).statusCode, 404);
  f.state.now = 2000;
  const read = await f.post('drill', { handle, requestId: 'read-1' });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().payload.original, pointer.source.anchor);
  f.state.now = 2500;
  assert.equal((await f.post('drill', { handle, requestId: 'read-1' })).statusCode, 200);
  const events = f.episodes.listByCue('owner', pointer.cueId);
  assert.deepEqual(
    events.map((event) => event.consumptionOutcome),
    ['presented', 'drilled'],
  );
  assert.ok(events.every((event) => event.occurredAt === 2000 && event.readOrigin === 'explicit_read'));
});

test('already read versions do not occupy the two-pointer budget; a new epoch or revision is reevaluated', async (t) => {
  const f = fixture(t);
  const first = (await f.post('prepare', { activity: 'html', query: 'Rules  for HTML' })).json();
  for (const pointer of first.pointers)
    assert.equal((await f.post('drill', { handle: pointer.read.handle, requestId: pointer.cueId })).statusCode, 200);
  const second = (await f.post('prepare', { activity: 'html', query: 'rules for html' })).json();
  assert.deepEqual(
    second.pointers.map((p) => p.source.anchor),
    ['F332', 'F333'],
  );
  f.items[0].source.revision = 'r2';
  f.items[1].source.revision = 'r2';
  f.state.revision = 'r2';
  const revised = (await f.post('prepare', { activity: 'html', query: 'rules for html' })).json();
  assert.deepEqual(
    revised.pointers.map((p) => p.source.revision),
    ['r2', 'r2'],
  );
  f.state.epoch++;
  const fresh = (await f.post('prepare', { activity: 'html', query: 'rules for html' })).json();
  assert.equal(fresh.pointers[0].source.anchor, 'F330');
});

test('corrected sources and revoked scope close prepared handles before any presented event', async (t) => {
  const f = fixture(t);
  const prep = (await f.post('prepare', { activity: 'video', query: 'paper' })).json();
  const [a, b] = prep.pointers;
  f.state.revision = 'r2';
  assert.equal((await f.post('drill', { handle: a.read.handle, requestId: 'changed' })).statusCode, 404);
  assert.ok(f.episodes.listByCue('owner', a.cueId).every((event) => event.axis === 'invalidation'));
  f.state.current = false;
  assert.equal((await f.post('drill', { handle: b.read.handle, requestId: 'revoked' })).statusCode, 404);
  assert.ok(f.episodes.listByCue('owner', b.cueId).every((event) => event.axis === 'invalidation'));
  f.state.current = true;
  f.state.revision = 'r1';
  assert.equal((await f.post('drill', { handle: a.read.handle, requestId: 'retry-invalidated' })).statusCode, 409);
  assert.ok(f.episodes.listByCue('owner', a.cueId).every((event) => event.axis === 'invalidation'));
});

test('one work budget bounds all native sources and cancellation leaves no presentation', async (t) => {
  const f = fixture(t);
  f.state.nativeSources = 4;
  const result = (await f.post('prepare', { activity: 'html', query: 'HTML rules' })).json();
  assert.ok(result.pointers.length <= 2);
  assert.ok(f.nativeReads.reduce((a, b) => a + b, 0) <= 20);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_cue_events').get().n, 0);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (
      await f.service.prepare({
        auth: f.auth,
        activity: 'video',
        query: 'paper',
        receivedAt: 3000,
        signal: controller.signal,
      })
    ).status,
    'cancelled',
  );
  const cutoff = await f.service.prepare({
    auth: f.auth,
    activity: 'html',
    query: 'rules',
    receivedAt: 3000,
    signal: new AbortController().signal,
    deadlineAt: Date.now() - 1,
  });
  assert.equal(cutoff.status, 'source_unavailable');
  f.state.hang = true;
  const before = performance.now();
  const timeout = (await f.post('prepare', { activity: 'video', query: 'blocked source' })).json();
  assert.equal(timeout.status, 'source_unavailable');
  assert.deepEqual(timeout.pointers, []);
  assert.ok(performance.now() - before < 2500);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_cue_events').get().n, 0);
});

test('persistent preparation bookkeeping contains only source statistics and coordinates, never native bodies', async (t) => {
  const f = fixture(t);
  f.items[0].native = { canonicalBody: 'SOURCE_BODY_MUST_NOT_PERSIST' };
  const prep = (await f.post('prepare', { activity: 'video', query: 'private query words' })).json();
  assert.equal(prep.status, 'ok');
  assert.deepEqual(
    Object.keys(prep.sources[0]),
    ['sourceId'],
    'ordinary tool results do not expose pre-ACL candidate counts or stop reasons',
  );
  const row = f.db
    .prepare('SELECT * FROM memory_cue_preparation_opportunities WHERE opportunity_id=?')
    .get(prep.opportunityId);
  const stored = JSON.stringify(row);
  assert.equal(stored.includes('SOURCE_BODY_MUST_NOT_PERSIST'), false);
  assert.equal(stored.includes('private query words'), false);
  assert.equal(row.discovery_version, 'knowledge-discovery-v1');
  assert.deepEqual(Object.keys(JSON.parse(row.discovery_sources_json)[0]).sort(), [
    'inspected',
    'sourceId',
    'stopReason',
  ]);
});

test('a failed explicit-read receipt stays retryable and does not fabricate consumption', async (t) => {
  const f = fixture(t);
  const prep = (await f.post('prepare', { activity: 'video', query: 'paper' })).json();
  const pointer = prep.pointers[0];
  const recordRead = f.service.recordRead.bind(f.service);
  f.service.recordRead = () => {
    throw new Error('isolated receipt write unavailable');
  };
  const failed = await f.post('drill', { handle: pointer.read.handle, requestId: 'commit-retry' });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().retryable, true);
  assert.equal(failed.json().payload, undefined);
  assert.deepEqual(f.episodes.listByCue('owner', pointer.cueId), []);
  f.service.recordRead = recordRead;
  assert.equal((await f.post('drill', { handle: pointer.read.handle, requestId: 'commit-retry' })).statusCode, 200);
  assert.equal(f.episodes.listByCue('owner', pointer.cueId).length, 2);
});
