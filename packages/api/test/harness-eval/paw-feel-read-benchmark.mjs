import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// Run after build: node test/harness-eval/paw-feel-read-benchmark.mjs BEFORE_DIST OUTPUT_JSON
const api = resolve(import.meta.dirname, '../..');
if (!process.argv[2] || !process.argv[3]) throw new Error('usage: paw-feel-read-benchmark.mjs BEFORE_DIST OUTPUT_JSON');
const paths = { before: resolve(process.argv[2]), after: join(api, 'dist') };
const load = (root, relative) => import(pathToFileURL(join(root, relative)));
const relative = 'infrastructure/harness-eval/';
const fixture = await import(pathToFileURL(join(api, 'test/harness-eval/helpers/paw-feel-source-case-fixture.js')));
const { inspectPawFeelMessage } = await load(paths.after, `${relative}friction/paw-feel-source.js`);
const { digestFrictionAnalysisFinding } = await load(paths.after, `${relative}friction/friction-finding-artifact.js`);
const { PawFeelBundleSnapshotSigner } = await load(paths.after, `${relative}paw-feel-disposition/bundle-snapshot.js`);
const modules = {};
for (const [name, root] of Object.entries(paths)) {
  modules[name] = {
    ...(await load(root, `${relative}paw-feel-disposition/read-model.js`)),
    ...(await load(root, `${relative}paw-feel-disposition/continuation/source-case-action-resolver.js`)),
    ...(await load(root, `${relative}paw-feel-disposition/continuation/follow-up-resolver.js`)),
  };
}
const now = '2026-09-12T00:00:00.000Z';
const cases = 200;
const markersPerMessage = 4;
const specs = Array.from({ length: cases }, (_, i) => ({
  findingKey: `case-${i}`,
  verdictId: `verdict-${i}`,
  journey: i % 2 === 0,
}));
const state = await fixture.harnessState(specs);
const messages = new Map();
const events = new Map();
const caseDir = join(state.root, 'case-events');
await mkdir(caseDir);
try {
  for (let i = 0; i < cases; i++) {
    const id = `source-${String(i).padStart(4, '0')}`;
    const message = {
      id,
      threadId: 'benchmark-thread',
      userId: 'benchmark-owner',
      catId: 'codex-sol',
      mentions: [],
      content: Array.from({ length: markersPerMessage }, (_, j) => `[爪感差: fixture+case ${i} marker ${j}]`).join(
        '\n',
      ),
      timestamp: Date.parse('2026-09-01T00:00:00.000Z') + i * 1000,
    };
    messages.set(id, message);
    const inspected = inspectPawFeelMessage(message);
    assert.equal(inspected.kind, 'canonical');
    assert.equal(inspected.candidates.length, markersPerMessage);
    for (const candidate of inspected.candidates) {
      events.set(candidate.signalId, [
        {
          eventId: `discovered:${candidate.signalId}`,
          signalId: candidate.signalId,
          type: 'discovered',
          actor: { kind: 'automation', id: 'paw-feel-reconciler' },
          occurredAt: candidate.occurredAt,
          source: {
            sourceMessageId: candidate.sourceMessageId,
            sourceThreadId: candidate.sourceThreadId,
            sourceCatId: candidate.sourceCatId,
            markerDigest: candidate.markerDigest,
            sameDigestOrdinal: candidate.sameDigestOrdinal,
            markerIndex: candidate.markerIndex,
          },
          backfilled: false,
          captureMethod: 'typed',
          captureAssessment: 'confirmed',
        },
      ]);
    }
    const bundle = join(state.root, 'bundles', `verdict-${i}`);
    const finding = JSON.parse(await readFile(join(bundle, 'finding.json'), 'utf8'));
    finding.sourceSignalRefs = inspected.candidates.map((candidate) => `source-message:${id}#${candidate.markerIndex}`);
    await writeFile(join(bundle, 'finding.json'), JSON.stringify(finding));
    const root = JSON.parse(await readFile(join(bundle, 'lifecycle-root.json'), 'utf8'));
    root.findingBinding.artifactSha256 = digestFrictionAnalysisFinding(finding);
    await writeFile(join(bundle, 'lifecycle-root.json'), JSON.stringify(root));
  }
  for (const [caseId, caseEvents] of state.events)
    await writeFile(join(caseDir, `${caseId}.json`), JSON.stringify(caseEvents));

  const metrics = { before: [], after: [] };
  const expected = new Map();
  const queries = [
    { sort: 'oldest', limit: 20 },
    { sort: 'newest', limit: 20 },
    { sort: 'oldest', limit: 20, resolution: 'open' },
    { sourceMessageId: 'source-0000', limit: 20 },
  ];
  const run = async (name, query, key) => {
    let caseReads = 0;
    let syncArtifactReads = 0;
    const original = fs.readFileSync;
    fs.readFileSync = (...args) => {
      if (String(args[0]).startsWith(state.root)) syncArtifactReads++;
      return original(...args);
    };
    syncBuiltinESMExports();
    const module = modules[name];
    const sourceCaseResolver = new module.PawFeelSourceCaseActionResolver({
      harnessFeedbackRoot: state.root,
      eventLog: {
        async read(caseId) {
          caseReads++;
          return JSON.parse(await readFile(join(caseDir, `${caseId}.json`), 'utf8'));
        },
      },
      sourceVerifier: {
        verifyIdentity() {
          throw new Error('read model must supply its verified exact-source identity');
        },
      },
    });
    const model = new module.PawFeelDispositionReadModel({
      eventLog: {
        async listSignalIds() {
          return [...events.keys()];
        },
        async listSignalIdsBySourceMessageId(id) {
          return [...events]
            .filter(([, value]) => value[0].source.sourceMessageId === id)
            .map(([signalId]) => signalId);
        },
        async read(signalId) {
          return events.get(signalId);
        },
        async readMany(signalIds) {
          return new Map(signalIds.map((id) => [id, events.get(id)]));
        },
      },
      messageStore: {
        async getById(id) {
          return messages.get(id);
        },
      },
      bundleSnapshotSigner: new PawFeelBundleSnapshotSigner(Buffer.alloc(32, 7)),
      now: () => now,
      followUpResolver: new module.PawFeelContinuingResponsibilityResolver({ sourceCaseResolver }),
    });
    const started = performance.now();
    let page;
    let elapsedMs;
    try {
      page = await model.list(query);
      elapsedMs = performance.now() - started;
    } finally {
      fs.readFileSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(page.projectionStatus, 'available');
    assert.equal(page.counts.total, query.sourceMessageId ? markersPerMessage : cases * markersPerMessage);
    assert.equal(page.denominator.reportOccurrences, page.counts.total);
    assert.equal(page.bundleCounts.total, query.sourceMessageId ? 1 : cases);
    for (const bundle of page.bundles) {
      assert.equal(bundle.members.length, markersPerMessage);
      await model.assertBundleSnapshot(
        bundle.bundleKey,
        bundle.members.map((item) => ({
          signalId: item.disposition.signalId,
          expectedSequence: item.disposition.sequence,
        })),
        bundle.membershipToken,
      );
    }
    if (!expected.has(key)) expected.set(key, page);
    else assert.deepEqual(page, expected.get(key), `${name} complete page differs at ${key}`);
    metrics[name].push({
      key,
      query,
      elapsedMs,
      caseReads,
      syncArtifactReads,
      returnedItems: page.items.length,
      returnedBundles: page.bundles.length,
    });
    return page;
  };
  for (let round = 0; round < 5; round++) {
    for (let index = 0; index < queries.length; index++) {
      for (const name of round % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
        const page = await run(name, queries[index], `query-${index}`);
        if (page.nextCursor && index < 2)
          await run(name, { ...queries[index], cursor: page.nextCursor }, `query-${index}-cursor`);
      }
    }
  }
  const result = {
    capturedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cohort: {
      cases,
      artifacts: cases,
      sourceMessages: cases,
      markersPerMessage,
      reportOccurrences: events.size,
      caseEventCounts: [...new Set([...state.events.values()].map((value) => value.length))],
      redis: false,
    },
    contract:
      'Full read-model pages deep-equal across implementations and repeated runs, including counts, denominator, issue/responsibility projections, whole bundles, membership tokens and cursors; fixed clock and signer.',
    limits:
      'Synthetic, warm local disk, 5 alternating rounds. Redis/message reads are in-memory. Measures only this complete read-model cohort, not production HTTP latency or p95.',
    paths,
    metrics,
  };
  await writeFile(resolve(process.argv[3]), JSON.stringify(result, null, 2));
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = {};
  for (const name of Object.keys(metrics)) {
    summary[name] = Object.fromEntries(
      [...expected.keys()].map((key) => {
        const rows = metrics[name].filter((row) => row.key === key);
        return [
          key,
          {
            medianMs: median(rows.map((row) => row.elapsedMs)),
            rangeMs: [Math.min(...rows.map((row) => row.elapsedMs)), Math.max(...rows.map((row) => row.elapsedMs))],
            caseReads: [...new Set(rows.map((row) => row.caseReads))],
            syncArtifactReads: [...new Set(rows.map((row) => row.syncArtifactReads))],
          },
        ];
      }),
    );
  }
  console.log(JSON.stringify({ ...result, metrics: undefined, summary }, null, 2));
} finally {
  await fixture.cleanupSourceCaseFixtures();
}
