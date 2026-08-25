import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  DesignGateEpisodeSourceProviderImpl,
  validateDesignGateEpisodeSelector,
} from '../../dist/infrastructure/harness-eval/design-gate/design-gate-episode-source-provider.js';

const HEAD = 'a21fd76826fd38401b44172ce551778ca29fdac0';
const MERGE = 'db0e818a0d49bca4deeea428e14236901cb4fc5a';
const LANDED = '76184494597686283c0999d6f6166d0096fd6d2e';
const REVIEW_MESSAGE_ID = '0001787501286658-000077-5d3e5e07';
const SOURCE_MAP_ID = 'f303-phase-c-pr3901';

function write(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), 'f303-design-gate-source-'));
  write(
    root,
    'docs/plans/2026-08-23-f303-phase-c-sop-evidence.md',
    `---\ndescription_author: codex-sol\n---\n# Plan\n## Finish line\nArchitecture cell: harness-eval\nMap delta: none\nCanonical source: packages/api/src/infrastructure/harness-eval/sop/sop-design-gate-evidence.ts#evaluateDesignGateEvidence\nConsumer evidence: packages/mcp-server/src/tools/publish-verdict-tool.ts\nClaim guard: pnpm gate\n`,
  );
  write(
    root,
    'docs/features/F083-design-gate-sop.md',
    '# F083\n## F303 architecture / contract integrity admission（维护加固）\n- preservation_boundary_delta: Map delta: none plus consumer boundary.\n',
  );
  write(root, 'packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts', 'export {};\n');
  write(root, 'packages/mcp-server/src/tools/publish-verdict-tool.ts', 'export {};\n');
  write(
    root,
    'docs/harness-feedback/design-gate/receipts/f303-phase-c-pr3901-alpha.yaml',
    `kind: f303-landed-alpha-receipt
schemaVersion: 1
receiptId: f303-phase-c-pr3901-alpha
observedAt: "2026-08-23T16:52:00.000Z"
channel: alpha
landedRevision: ${LANDED}
includedMergeRevision: ${MERGE}
earlierSelfCheckRef: github:pr:zts212653/cat-cafe#3901@${HEAD}#validation/pnpm-gate
services:
  - { name: api, endpoint: "http://localhost:3012/health", statusCode: 200 }
  - { name: web, endpoint: "http://localhost:3011/", statusCode: 200 }
redisPort: 6398
consequence:
  kind: alpha_no_escape
  evidenceRef: alpha:f303-phase-c-pr3901-alpha#services
`,
  );
  write(
    root,
    `docs/harness-feedback/design-gate/source-maps/${SOURCE_MAP_ID}.yaml`,
    `kind: f303-design-gate-episode-source-map
schemaVersion: 1
sourceMapId: ${SOURCE_MAP_ID}
window:
  startMs: 1787500000000
  endMs: 1787510000000
episodes:
  - episodeId: f303-phase-c-pr3901
    featureId: F303
    admissionRef: repo:docs/plans/2026-08-23-f303-phase-c-sop-evidence.md#finish-line
    triggerContractRef: repo:docs/features/F083-design-gate-sop.md#f303-architecture-contract-integrity-admission维护加固
    consumerBoundaryRefs:
      - repo:packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts
      - repo:packages/mcp-server/src/tools/publish-verdict-tool.ts
    pullRequestRef: github:pr:zts212653/cat-cafe#3901
    exactHeadRef: git:${HEAD}
    gateReceiptRef: github:pr:zts212653/cat-cafe#3901@${HEAD}#validation/pnpm-gate
    reviewMessageRef: cat-cafe:thread:thread_mt5xeb8e7qs467i2/message:${REVIEW_MESSAGE_ID}
    reviewVerdictRef: local-review:${REVIEW_MESSAGE_ID}:g1:approved
    landedAlphaReceiptRef: repo:docs/harness-feedback/design-gate/receipts/f303-phase-c-pr3901-alpha.yaml
`,
  );
  return root;
}

function pullRequest(overrides = {}) {
  return {
    repoFullName: 'zts212653/cat-cafe',
    number: 3901,
    state: 'MERGED',
    headSha: HEAD,
    mergeSha: MERGE,
    body: `## Architecture ownership\n- Map delta: none\n## Validation\nExact target: \`${HEAD}\`\n- \`pnpm gate\` — PASS at exact HEAD`,
    changedFiles: [
      'packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts',
      'packages/mcp-server/src/tools/publish-verdict-tool.ts',
    ],
    ...overrides,
  };
}

function reviewMessage(overrides = {}) {
  return {
    id: REVIEW_MESSAGE_ID,
    threadId: 'thread_mt5xeb8e7qs467i2',
    catId: 'opus-47',
    content: `Local Review Verdict: APPROVED\nExact HEAD: \`${HEAD}\``,
    extra: { localReviewVerdict: { verdict: 'approved', clientMessageId: 'review-f303-phase-c' } },
    ...overrides,
  };
}

function provider(root, overrides = {}) {
  return new DesignGateEpisodeSourceProviderImpl({
    repoRoot: root,
    pullRequestReader: {
      resolve: async () => pullRequest(overrides.pullRequest),
    },
    reviewMessageReader: {
      getById: async () => reviewMessage(overrides.reviewMessage),
    },
    gitTruth: overrides.gitTruth ?? {
      isOriginMainAncestor: async (revision) => revision === LANDED || revision === MERGE,
      isAncestor: async (ancestor, descendant) => ancestor === MERGE && descendant === LANDED,
    },
  });
}

test('selector admits only a bounded server-owned source map id', () => {
  assert.equal(
    validateDesignGateEpisodeSelector({ kind: 'design-gate-episode-source-map', sourceMapId: SOURCE_MAP_ID }),
    null,
  );
  assert.match(
    validateDesignGateEpisodeSelector({
      kind: 'design-gate-episode-source-map',
      sourceMapId: '../f303-phase-c-pr3901',
    }),
    /sourceMapId/,
  );
});

test('canonical #3901 refs reconstruct one complete preservation-boundary episode', async () => {
  const bundle = await provider(createRepo()).resolve({
    kind: 'design-gate-episode-source-map',
    sourceMapId: SOURCE_MAP_ID,
  });

  assert.equal(bundle.sourceMapRef, `docs/harness-feedback/design-gate/source-maps/${SOURCE_MAP_ID}.yaml`);
  assert.equal(bundle.episodes.length, 1);
  assert.deepEqual(bundle.episodes[0].validation, { status: 'valid', reasons: [] });
  assert.equal(bundle.episodes[0].eligibility.trigger, 'preservation_boundary_delta');
  assert.equal(bundle.episodes[0].authorCatId, 'codex-sol');
  assert.equal(bundle.episodes[0].reviewerCatId, 'opus-47');
  assert.equal(bundle.episodes[0].consequence.kind, 'alpha_no_escape');
  assert.deepEqual(bundle.vector, {
    eligibleEpisodes: 1,
    preReviewUniqueCatches: null,
    postMergeDivergenceEscapes: 0,
    falsePositiveBlocks: null,
    extraActiveMinutes: null,
    extraReviewRounds: null,
  });
  assert.equal(bundle.validity.status, 'insufficient');
  assert.equal(bundle.observation.status, 'observing');
  assert.equal(bundle.observation.mature, false);
  assert.equal('score' in bundle, false);
});

test('admission and trigger evidence must live inside their referenced anchor sections', async () => {
  const root = createRepo();
  write(
    root,
    'docs/plans/2026-08-23-f303-phase-c-sop-evidence.md',
    `---\ndescription_author: codex-sol\n---\n# Plan\n## Finish line\nArchitecture cell: harness-eval\n## Unrelated evidence\nMap delta: none\nCanonical source: canonical\nConsumer evidence: consumer\nClaim guard: guard\n`,
  );
  write(
    root,
    'docs/features/F083-design-gate-sop.md',
    '# F083\n## F303 architecture / contract integrity admission（维护加固）\nNo trigger here.\n## Unrelated trigger\n- preservation_boundary_delta\n',
  );

  const bundle = await provider(root).resolve({
    kind: 'design-gate-episode-source-map',
    sourceMapId: SOURCE_MAP_ID,
  });

  assert.equal(bundle.episodes[0].eligibility.eligible, false);
  assert.equal(bundle.episodes[0].validation.status, 'invalid');
  assert.match(bundle.episodes[0].validation.reasons.join('\n'), /preservation evidence packet/);
  assert.match(bundle.episodes[0].validation.reasons.join('\n'), /preservation_boundary_delta/);
});

test('a stale source-map selector fails closed instead of freezing the observation window', async () => {
  const root = createRepo();
  const current = readFileSync(
    join(root, `docs/harness-feedback/design-gate/source-maps/${SOURCE_MAP_ID}.yaml`),
    'utf8',
  );
  write(
    root,
    'docs/harness-feedback/design-gate/source-maps/f303-observation-next.yaml',
    current
      .replace(`sourceMapId: ${SOURCE_MAP_ID}`, 'sourceMapId: f303-observation-next')
      .replace('endMs: 1787510000000', 'endMs: 1787520000000'),
  );

  await assert.rejects(
    provider(root).resolve({ kind: 'design-gate-episode-source-map', sourceMapId: SOURCE_MAP_ID }),
    /stale.*source map/i,
  );
});

test('an empty source-map catalog reports the unavailable selector before catalog ordering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f303-design-gate-empty-source-'));
  mkdirSync(join(root, 'docs/harness-feedback/design-gate/source-maps'), { recursive: true });

  await assert.rejects(
    provider(root).resolve({ kind: 'design-gate-episode-source-map', sourceMapId: SOURCE_MAP_ID }),
    /source map unavailable/i,
  );
});

test('a tied latest source-map window fails closed as ambiguous', async () => {
  const root = createRepo();
  const current = readFileSync(
    join(root, `docs/harness-feedback/design-gate/source-maps/${SOURCE_MAP_ID}.yaml`),
    'utf8',
  );
  write(
    root,
    'docs/harness-feedback/design-gate/source-maps/f303-observation-tied.yaml',
    current.replace(`sourceMapId: ${SOURCE_MAP_ID}`, 'sourceMapId: f303-observation-tied'),
  );

  await assert.rejects(
    provider(root).resolve({ kind: 'design-gate-episode-source-map', sourceMapId: SOURCE_MAP_ID }),
    /ambiguous latest window/i,
  );
});

test('a latest source map that omits an older episode fails closed as non-cumulative', async () => {
  const root = createRepo();
  const current = readFileSync(
    join(root, `docs/harness-feedback/design-gate/source-maps/${SOURCE_MAP_ID}.yaml`),
    'utf8',
  );
  write(
    root,
    'docs/harness-feedback/design-gate/source-maps/f303-observation-next.yaml',
    current
      .replace(`sourceMapId: ${SOURCE_MAP_ID}`, 'sourceMapId: f303-observation-next')
      .replace('endMs: 1787510000000', 'endMs: 1787520000000')
      .replace('episodeId: f303-phase-c-pr3901', 'episodeId: f303-observation-next-episode'),
  );

  await assert.rejects(
    provider(root).resolve({ kind: 'design-gate-episode-source-map', sourceMapId: 'f303-observation-next' }),
    /not cumulative.*f303-phase-c-pr3901/i,
  );
});

test('a source-map id that disagrees with its filename fails closed', async () => {
  const root = createRepo();
  const current = readFileSync(
    join(root, `docs/harness-feedback/design-gate/source-maps/${SOURCE_MAP_ID}.yaml`),
    'utf8',
  );
  write(root, 'docs/harness-feedback/design-gate/source-maps/f303-mismatch.yaml', current);

  await assert.rejects(
    provider(root).resolve({ kind: 'design-gate-episode-source-map', sourceMapId: SOURCE_MAP_ID }),
    /source map id does not match filename/i,
  );
});

test('missing explicit Alpha consequence invalidates the episode instead of inferring success from silence', async () => {
  const root = createRepo();
  write(
    root,
    'docs/harness-feedback/design-gate/receipts/f303-phase-c-pr3901-alpha.yaml',
    `kind: f303-landed-alpha-receipt\nschemaVersion: 1\nreceiptId: f303-phase-c-pr3901-alpha\nobservedAt: "2026-08-23T16:52:00.000Z"\nchannel: alpha\nlandedRevision: ${LANDED}\nincludedMergeRevision: ${MERGE}\nearlierSelfCheckRef: github:pr:zts212653/cat-cafe#3901@${HEAD}#validation/pnpm-gate\nservices:\n  - { name: api, endpoint: "http://localhost:3012/health", statusCode: 200 }\nredisPort: 6398\n`,
  );

  const bundle = await provider(root).resolve({
    kind: 'design-gate-episode-source-map',
    sourceMapId: SOURCE_MAP_ID,
  });
  assert.equal(bundle.episodes[0].validation.status, 'invalid');
  assert.match(bundle.episodes[0].validation.reasons.join('\n'), /consequence/i);
  assert.equal(bundle.validity.status, 'invalid');
});

test('review by the admission author is invalid even when prose says approved', async () => {
  const bundle = await provider(createRepo(), { reviewMessage: { catId: 'codex-sol' } }).resolve({
    kind: 'design-gate-episode-source-map',
    sourceMapId: SOURCE_MAP_ID,
  });
  assert.equal(bundle.episodes[0].validation.status, 'invalid');
  assert.match(bundle.episodes[0].validation.reasons.join('\n'), /non-author/i);
});

test('an Alpha revision that does not contain the merge invalidates landed truth', async () => {
  const root = createRepo();
  const candidate = provider(root, {
    gitTruth: { isOriginMainAncestor: async () => true, isAncestor: async () => false },
  });
  const bundle = await candidate.resolve({
    kind: 'design-gate-episode-source-map',
    sourceMapId: SOURCE_MAP_ID,
  });
  assert.equal(bundle.episodes[0].validation.status, 'invalid');
  assert.match(bundle.episodes[0].validation.reasons.join('\n'), /merge revision/i);
});

test('a declared consumer boundary missing from the PR diff invalidates the episode', async () => {
  const bundle = await provider(createRepo(), {
    pullRequest: { changedFiles: ['packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts'] },
  }).resolve({ kind: 'design-gate-episode-source-map', sourceMapId: SOURCE_MAP_ID });

  assert.equal(bundle.episodes[0].validation.status, 'invalid');
  assert.match(bundle.episodes[0].validation.reasons.join('\n'), /consumer boundary.*absent/i);
});

test('a gate receipt bound to a different HEAD invalidates the episode', async () => {
  const root = createRepo();
  const sourceMapPath = `docs/harness-feedback/design-gate/source-maps/${SOURCE_MAP_ID}.yaml`;
  write(
    root,
    sourceMapPath,
    readFileSync(join(root, sourceMapPath), 'utf8').replace(
      `gateReceiptRef: github:pr:zts212653/cat-cafe#3901@${HEAD}#validation/pnpm-gate`,
      'gateReceiptRef: github:pr:zts212653/cat-cafe#3901@0000000000000000000000000000000000000000#validation/pnpm-gate',
    ),
  );

  const bundle = await provider(root).resolve({ kind: 'design-gate-episode-source-map', sourceMapId: SOURCE_MAP_ID });
  assert.equal(bundle.episodes[0].validation.status, 'invalid');
  assert.match(bundle.episodes[0].validation.reasons.join('\n'), /gate receipt ref.*exact HEAD/i);
});

test('latest transition derives 1→20 eligible episodes from one cumulative resolved set', async () => {
  const root = createRepo();
  const sourceMapPath = `docs/harness-feedback/design-gate/source-maps/${SOURCE_MAP_ID}.yaml`;
  const current = readFileSync(join(root, sourceMapPath), 'utf8');
  const episodeStart = current.indexOf('  - episodeId:');
  const header = current
    .slice(0, episodeStart)
    .replace(`sourceMapId: ${SOURCE_MAP_ID}`, 'sourceMapId: f303-observation-twenty')
    .replace('endMs: 1787510000000', 'endMs: 1787520000000');
  const episode = current.slice(episodeStart);
  const episodes = Array.from({ length: 20 }, (_, index) =>
    episode.replace('episodeId: f303-phase-c-pr3901', `episodeId: f303-eligible-${String(index + 1).padStart(2, '0')}`),
  ).join('');
  // Keep the original episode id in the cumulative successor so the prior map is a subset.
  const cumulativeEpisodes = episodes.replace('episodeId: f303-eligible-01', 'episodeId: f303-phase-c-pr3901');
  write(
    root,
    'docs/harness-feedback/design-gate/source-maps/f303-observation-twenty.yaml',
    `${header}${cumulativeEpisodes}`,
  );

  const transition = await provider(root).resolveLatestTransition();

  assert.equal(transition.sourceMapId, 'f303-observation-twenty');
  assert.equal(transition.eventId, 'design-gate-source-map:f303-observation-twenty');
  assert.equal(transition.previousEligibleEpisodes, 1);
  assert.equal(transition.currentEligibleEpisodes, 20);
  assert.equal(transition.sourceValid, true);
});
