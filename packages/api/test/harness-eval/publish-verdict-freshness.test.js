import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { InMemoryFreshnessClosureStore } from '../../dist/domains/cats/services/freshness/FreshnessClosureStore.js';
import { FreshnessReplayProviderImpl } from '../../dist/infrastructure/harness-eval/freshness/freshness-replay-provider.js';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
import { createFreshnessGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/freshness-generator-adapter.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { buildPacket, seedCanonicalMeasurementCensusState } from './publish-verdict-fixtures.js';

const root = mkdtempSync(join(tmpdir(), 'publish-verdict-freshness-'));
const harnessFeedbackRoot = join(root, 'docs', 'harness-feedback');
const repoRoot = join(import.meta.dirname, '../../../..');
const fixtureRoot = join(repoRoot, 'docs', 'harness-feedback', 'fixtures', 'f254');
const domainYaml = `domainId: eval:freshness
displayName: Freshness Gate Eval
systemThreadId: thread_eval_freshness
evalCat:
  catId: gpt52
  handle: '@gpt52'
  model: gpt-5.4
frequency: weekly
sourceAdapter: f254-freshness-replay
sourceRefsKind: freshness-closure-replay
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent: [longitudinal-analysis, verdict-discussion, handoff-drafts]
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F254
  ownerCatId: codex-sol
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
fixtures: []
enabled: true
`;

function freshnessPacket(overrides = {}) {
  return buildPacket({
    id: 'vhp-freshness-e2e-test',
    domainId: 'eval:freshness',
    harnessUnderEval: {
      featureId: 'F254',
      componentId: 'freshness-closure-replay',
      name: 'freshness closure replay',
    },
    evidencePacket: {
      snapshotRefs: ['placeholder:overridden'],
      attributionRefs: ['placeholder:overridden'],
      metricRefs: ['freshness.replay_failed_samples'],
      sampleTraceRefs: ['trace:f254-ac-e9/original-double-message-dogfood'],
    },
    ownerAsk: { targetFeatureId: 'F254', targetOwnerCatId: 'codex-sol', requestedAction: 'observe' },
    ...overrides,
  });
}

const sourceRefs = {
  kind: 'freshness-closure-replay',
  windowStartMs: 1_000,
  windowEndMs: 2_000,
};

before(() => {
  mkdirSync(join(harnessFeedbackRoot, 'eval-domains'), { recursive: true });
  mkdirSync(join(harnessFeedbackRoot, 'verdicts'), { recursive: true });
  mkdirSync(join(harnessFeedbackRoot, 'bundles'), { recursive: true });
  writeFileSync(join(harnessFeedbackRoot, 'eval-domains', 'eval-freshness.yaml'), domainYaml);
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('publish_verdict eval:freshness', () => {
  it('resolves server-owned replay evidence and writes a hashed four-part bundle', async () => {
    const store = new InMemoryFreshnessClosureStore();
    await store.openOrAdvance({
      closureId: 'closure-live-healthy',
      userId: 'user-1',
      threadId: 'thread-live',
      catId: 'codex-sol',
      invocationId: 'base-1',
      originTriggerMessageId: 'msg-origin',
      draftContent: 'base',
      requiredMessageIds: ['msg-frontier'],
      requiredFrontierMessageId: 'msg-frontier',
      observedRawFrontierMessageId: 'msg-frontier',
      now: 1_100,
    });
    await store.claimAttempt('closure-live-healthy', {
      invocationId: 'success-1',
      inputFrontierMessageId: 'msg-frontier',
      observedRawFrontierMessageId: 'msg-frontier',
      now: 1_200,
    });
    await store.commit('closure-live-healthy', {
      invocationId: 'success-1',
      messageId: 'message-final',
      observedRawFrontierMessageId: 'msg-frontier',
      evidenceRefs: ['append:message-final'],
      now: 1_300,
    });
    const provider = new FreshnessReplayProviderImpl({
      store,
      fixtureRoot,
    });
    const generator = createFreshnessGeneratorAdapter(provider);
    let isolatedRoot;
    const gitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        isolatedRoot = join(root, 'isolated');
        rmSync(isolatedRoot, { recursive: true, force: true });
        mkdirSync(join(isolatedRoot, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
        writeFileSync(
          join(isolatedRoot, 'docs', 'harness-feedback', 'eval-domains', 'eval-freshness.yaml'),
          domainYaml,
        );
        seedCanonicalMeasurementCensusState(isolatedRoot);
        rmSync(join(isolatedRoot, 'docs', 'harness-feedback', 'verdicts'), { recursive: true, force: true });
        mkdirSync(join(isolatedRoot, 'docs', 'harness-feedback', 'verdicts'), { recursive: true });
        await opts.stage(isolatedRoot);
        return { commitSha: 'freshness-sha', prUrl: 'https://example.test/pr/1' };
      },
    };

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot, generator, gitPublisher },
      { packet: freshnessPacket(), domain: 'eval:freshness', catId: 'gpt52', sourceRefs },
    );

    assert.ok(!('error' in result), JSON.stringify(result));
    const bundle = join(isolatedRoot, 'docs', 'harness-feedback', 'bundles', 'vhp-freshness-e2e-test');
    for (const file of ['snapshot.json', 'attribution.json', 'provenance.json', 'raw/replay-events.json']) {
      assert.ok(existsSync(join(bundle, file)), `${file} must exist`);
    }
    const snapshot = JSON.parse(readFileSync(join(bundle, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.replayVerdict, 'healthy');
    assert.equal(snapshot.healthy, true);
    assert.equal(snapshot.components[0].activationCounts.eligible_samples, 9);
    assert.equal(snapshot.components[0].activationCounts.fixture_samples, 8);
    assert.equal(snapshot.components[0].activationCounts.live_samples, 1);
    const provenance = JSON.parse(readFileSync(join(bundle, 'provenance.json'), 'utf8'));
    assert.match(provenance.rawInputs[0].sha256, /^[0-9a-f]{64}$/);
    const verdictPath = join(isolatedRoot, 'docs', 'harness-feedback', 'verdicts', 'vhp-freshness-e2e-test.md');
    const markdown = readFileSync(verdictPath, 'utf8');
    assert.match(markdown, /- Verdict: `keep_observe`/);
    assert.match(markdown, /- Harness: F254\/freshness-closure-replay \(freshness closure replay\)/);
    assert.match(markdown, /- Re-eval: no friction at 2026-06-12T11:00:00.000Z/);
    assert.match(markdown, /\nEvidence:\n/);
    assert.match(markdown, /- Derived replay: `healthy`/);

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: join(isolatedRoot, 'docs', 'harness-feedback'),
      now: new Date('2026-06-06T00:00:00.000Z'),
    });
    const item = summary.items.find((candidate) => candidate.id === 'vhp-freshness-e2e-test');
    assert.ok(item, 'generated freshness verdict must round-trip through the Eval Hub read model');
    assert.equal(item.verdict, 'keep_observe');
    assert.equal(item.domainId, 'eval:freshness');
    assert.deepEqual(item.harnessUnderEval, {
      featureId: 'F254',
      componentId: 'freshness-closure-replay',
      name: 'freshness closure replay',
    });
    assert.equal(item.reeval.nextEvalAt, '2026-06-12T11:00:00.000Z');
    assert.deepEqual(item.evidence.snapshotRefs, ['snapshot:bundle/vhp-freshness-e2e-test/snapshot']);
  });

  it('rejects malformed selectors before the generator runs', async () => {
    const generator = createFreshnessGeneratorAdapter({ resolve: async () => assert.fail('must not resolve') });
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot, generator },
      {
        packet: freshnessPacket({ id: 'vhp-freshness-bad-selector' }),
        domain: 'eval:freshness',
        catId: 'gpt52',
        sourceRefs: { ...sourceRefs, windowEndMs: sourceRefs.windowStartMs },
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'invalid_source_ref');
  });

  it('rejects caller-selected fixture subsets instead of letting the subject choose coverage', async () => {
    const generator = createFreshnessGeneratorAdapter({ resolve: async () => assert.fail('must not resolve') });
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot, generator },
      {
        packet: freshnessPacket({ id: 'vhp-freshness-fixture-subset' }),
        domain: 'eval:freshness',
        catId: 'gpt52',
        sourceRefs: { ...sourceRefs, fixtureIds: ['original-double-message-dogfood'] },
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'invalid_source_ref');
  });

  it('publishes an empty replay window as no-data with healthy=false', async () => {
    const generator = createFreshnessGeneratorAdapter(
      new FreshnessReplayProviderImpl({ store: new InMemoryFreshnessClosureStore(), fixtureRoot }),
    );
    const isolatedRoot = join(root, 'isolated-no-data');
    const gitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        rmSync(isolatedRoot, { recursive: true, force: true });
        mkdirSync(join(isolatedRoot, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
        writeFileSync(
          join(isolatedRoot, 'docs', 'harness-feedback', 'eval-domains', 'eval-freshness.yaml'),
          domainYaml,
        );
        seedCanonicalMeasurementCensusState(isolatedRoot);
        await opts.stage(isolatedRoot);
        return { commitSha: 'freshness-no-data-sha', prUrl: 'https://example.test/pr/2' };
      },
    };
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot, generator, gitPublisher },
      {
        packet: freshnessPacket({ id: 'vhp-freshness-no-data' }),
        domain: 'eval:freshness',
        catId: 'gpt52',
        sourceRefs: { kind: 'freshness-closure-replay', windowStartMs: 3_000, windowEndMs: 4_000 },
      },
    );
    assert.ok(!('error' in result), JSON.stringify(result));
    const bundle = join(isolatedRoot, 'docs', 'harness-feedback', 'bundles', 'vhp-freshness-no-data');
    const snapshot = JSON.parse(readFileSync(join(bundle, 'snapshot.json'), 'utf8'));
    const attribution = JSON.parse(readFileSync(join(bundle, 'attribution.json'), 'utf8'));
    assert.equal(snapshot.replayVerdict, 'no_data');
    assert.equal(snapshot.healthy, false);
    assert.equal(attribution.noFindingRecord.reason, 'no_eligible_samples');
  });

  it('rejects incomplete verdict packets before resolving replay evidence', async () => {
    const generator = createFreshnessGeneratorAdapter({ resolve: async () => assert.fail('must not resolve') });
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot, generator },
      {
        packet: freshnessPacket({
          id: 'vhp-freshness-bad-packet',
          evidencePacket: {
            snapshotRefs: ['placeholder'],
            attributionRefs: ['placeholder'],
            metricRefs: ['freshness.replay_failed_samples'],
            sampleTraceRefs: [],
          },
        }),
        domain: 'eval:freshness',
        catId: 'gpt52',
        sourceRefs,
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'handoff_incomplete');
  });
});
