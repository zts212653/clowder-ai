import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readIndependentThreadWorks, WorkCatalogue } from '../dist/domains/collaborative-content/works/catalogue.js';
import { workCatalogueFixture } from './helpers/work-catalogue-fixture.js';

test('an admitted catalogue reports bounded request-local phases after both fresh fences', async (t) => {
  const f = await workCatalogueFixture(t);
  for (let i = 0; i < 12; i++) await f.create(`private-canary-${i}`);
  const catalogue = new WorkCatalogue(f.service);
  const reports = [];
  const result = await catalogue.withRead(
    'owner',
    (reader) => readIndependentThreadWorks(reader, 'owner', 'selected-thread'),
    (report) => reports.push(report),
  );
  assert.equal(result.length, 12, 'real owner files and version annotations remain authoritative');
  assert.equal(reports.length, 1, 'request-local Work timing must reach the admitted caller');
  const report = reports[0];
  assert.equal(report.outcome, 'success');
  assert.deepEqual(report.counts, { pages: 2, heads: 12, selectedVersions: 12, returned: 12 });
  assert.deepEqual(Object.keys(report.phases).sort(), [
    'admission',
    'discovery',
    'finalAuthorization',
    'manifestValidation',
    'selectedVersions',
    'visibility',
  ]);
  for (const ms of [report.elapsedMs, ...Object.values(report.phases)]) assert.ok(Number.isFinite(ms) && ms >= 0);
  for (const value of Object.values(report.mainLoop)) assert.ok(Number.isFinite(value) && value >= 0);
  assert.ok(report.mainLoop.utilization <= 1);
  assert.doesNotMatch(JSON.stringify(report), /private-canary|selected-thread|contentRef|work:|owner|workspace|sha256/);
  await f.create('new-private-canary');
  const next = await catalogue.withRead(
    'owner',
    (reader) => readIndependentThreadWorks(reader, 'owner', 'selected-thread'),
    (value) => reports.push(value),
  );
  assert.equal(next.length, 13);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].counts.heads, 12, 'later requests cannot mutate the previous report');
  assert.equal(reports[1].counts.heads, 13);
});

test('a throwing timing observer cannot replace the successful result or exact consumer failure', async (t) => {
  const f = await workCatalogueFixture(t);
  await f.create('private-canary');
  const catalogue = new WorkCatalogue(f.service);
  let calls = 0;
  const report = () => {
    calls++;
    throw new Error('observer unavailable');
  };
  const result = await catalogue.withRead(
    'owner',
    (reader) => reader.readThread({ ownerUserId: 'owner', threadId: 'selected-thread' }),
    report,
  );
  assert.equal(result.artifacts.length, 1);
  const exact = new Error('consumer unavailable');
  await assert.rejects(
    catalogue.withRead(
      'owner',
      async (reader) => {
        await reader.readThread({ ownerUserId: 'owner', threadId: 'selected-thread' });
        throw exact;
      },
      report,
    ),
    (error) => error === exact,
  );
  assert.equal(calls, 2);
});

test('principal denial reports failure without starting owner discovery or retaining caller identity', async (t) => {
  const f = await workCatalogueFixture(t);
  await f.create('private-canary');
  const counter = f.countReads();
  counter.reset();
  const reports = [];
  await assert.rejects(
    new WorkCatalogue(f.service).withRead(
      'owner',
      (reader) => reader.readThread({ ownerUserId: 'foreign-owner', threadId: 'private-thread' }),
      (value) => reports.push(value),
    ),
    /access_denied/,
  );
  assert.equal(counter.stats().stateReads, 0);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, 'failed');
  assert.deepEqual(reports[0].counts, { pages: 0, heads: 0, selectedVersions: 0, returned: 0 });
  assert.ok(Object.values(reports[0].phases).every((value) => value === 0));
  assert.doesNotMatch(JSON.stringify(reports), /foreign-owner|private-thread|private-canary/);
});

test('an empty target Work catalogue attributes initial authorization without selected-version reads', async (t) => {
  const f = await workCatalogueFixture(t);
  await f.create('elsewhere-canary', 'another-thread');
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  f.setAuthorize(async ({ scope }) => {
    if (!scope) clock += 1200;
  });
  const reports = [];
  const result = await new WorkCatalogue(f.service).withRead(
    'owner',
    (reader) => readIndependentThreadWorks(reader, 'owner', 'empty-thread'),
    (report) => reports.push(report),
  );
  assert.deepEqual(result, []);
  assert.equal(reports.length, 1);
  assert.equal(
    reports[0].phases.admission,
    1200,
    'initial authority wait must not disappear from the measured subphases',
  );
  assert.deepEqual(reports[0].counts, { pages: 1, heads: 1, selectedVersions: 0, returned: 0 });
});
