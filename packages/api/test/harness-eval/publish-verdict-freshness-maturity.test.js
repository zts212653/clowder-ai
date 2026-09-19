import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { InMemoryFreshnessClosureStore } from '../../dist/domains/cats/services/freshness/closure/FreshnessClosureStore.js';
import { generateFreshnessLiveVerdict } from '../../dist/infrastructure/harness-eval/freshness/eval-freshness-live-verdict.js';
import { FreshnessReplayProviderImpl } from '../../dist/infrastructure/harness-eval/freshness/freshness-replay-provider.js';
import { createFreshnessGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/freshness-generator-adapter.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { buildPacket, seedCanonicalMeasurementCensusState } from './publish-verdict-fixtures.js';

const root = mkdtempSync(join(tmpdir(), 'publish-verdict-freshness-maturity-'));
const harnessFeedbackRoot = join(root, 'live', 'docs', 'harness-feedback');
const repoRoot = join(import.meta.dirname, '../../../..');
const fixtureRoot = join(repoRoot, 'docs', 'harness-feedback', 'fixtures', 'f254');
const domainYaml = `domainId: eval:freshness
displayName: Freshness Gate Eval
systemThreadId: thread_eval_freshness
evalCat: { catId: gpt52, handle: '@gpt52', model: gpt-5.4 }
frequency: weekly
sourceAdapter: f254-freshness-replay
sourceRefsKind: freshness-closure-replay
threadPolicy: { role: working-home, stateSot: registry, allowedContent: [longitudinal-analysis] }
legacyScheduledTaskIds: []
handoffTargetResolver: { featureId: F254, ownerCatId: codex-sol, threadLookup: feature-thread }
sla: { acknowledgeHours: 48, reevalWithinHours: 168 }
fixtures: []
enabled: true
`;
const sourceRefs = { kind: 'freshness-closure-replay', windowStartMs: 1_000, windowEndMs: 2_000 };
const domain = {
  domainId: 'eval:freshness',
  displayName: 'Freshness Gate Eval',
  systemThreadId: 'thread_eval_freshness',
  evalCat: { catId: 'gpt52', handle: '@gpt52', model: 'gpt-5.4' },
  frequency: 'weekly',
  sourceAdapter: 'f254-freshness-replay',
  sourceRefsKind: 'freshness-closure-replay',
  threadPolicy: { role: 'working-home', stateSot: 'registry', allowedContent: ['longitudinal-analysis'] },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F254', ownerCatId: 'codex-sol', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
  fixtures: [],
  enabled: true,
};

function packet(id) {
  return buildPacket({
    id,
    domainId: 'eval:freshness',
    harnessUnderEval: { featureId: 'F254', componentId: 'freshness-closure-replay', name: 'freshness replay' },
    ownerAsk: { targetFeatureId: 'F254', targetOwnerCatId: 'codex-sol', requestedAction: 'observe' },
  });
}

function signalReplay(replay, selector, maturity) {
  return {
    ...replay,
    windowedSignals: {
      window: { startMs: selector.windowStartMs, endMs: selector.windowEndMs },
      queue: {
        entryTargetCount: 1,
        admittedCount: 1,
        seenCount: 1,
        handledCount: 0,
        withdrawnCount: 0,
        failedCount: 0,
        seenUnhandledAtWindowEndCount: 1,
        pendingAtWindowEndCount: 1,
        legacyUntimedCount: 0,
        lifecycles: [],
      },
      supplements: {
        offeredCount: 1,
        claimedCount: 1,
        terminalCount: 0,
        committedCount: 0,
        declinedCount: 0,
        failedCount: 0,
        unresolvedAtWindowEndCount: 1,
        budgetExhaustedCount: 0,
        legacyUntimedCount: 0,
        lifecycles: [],
      },
      attention: { eventCount: 2, counts: { held_decision: 1, notice_attached: 1 } },
      observedActivityCount: 6,
    },
    measurementMaturity: maturity,
  };
}

function allSources(status = 'complete') {
  return {
    legacy_closures: { status },
    queue_custody: { status },
    freshness_supplements: { status },
    attention_events: { status },
  };
}

function isolatedPublisher(isolatedRoot, onCommitted = () => {}) {
  return {
    async publishOnIsolatedWorktree(opts) {
      rmSync(isolatedRoot, { recursive: true, force: true });
      mkdirSync(join(isolatedRoot, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
      writeFileSync(join(isolatedRoot, 'docs', 'harness-feedback', 'eval-domains', 'eval-freshness.yaml'), domainYaml);
      seedCanonicalMeasurementCensusState(isolatedRoot);
      await opts.stage(isolatedRoot);
      onCommitted();
      return { commitSha: 'freshness-sha', prUrl: 'https://example.test/freshness' };
    },
  };
}

async function providerWithWindowedActivity(coverage) {
  const store = new InMemoryFreshnessClosureStore();
  const offered = await store.offerSupplement({
    lineageId: 'message-original',
    originalMessageId: 'message-original',
    userId: 'user-1',
    threadId: 'thread-live',
    catId: 'codex-sol',
    requiredMessageIds: ['message-update'],
    requiredFrontierMessageId: 'message-update',
    replayUnsafeToolNames: [],
    now: 1_100,
  });
  await store.claimSupplement(offered.supplement.id, { invocationId: 'inv-supplement', now: 1_200 });
  return new FreshnessReplayProviderImpl({
    store,
    fixtureRoot,
    queueLifecycleSource: {
      async listOwnerDurableEntries() {
        return [
          {
            id: 'entry-queue',
            threadId: 'thread-live',
            userId: 'user-1',
            targets: ['codex-sol'],
            enqueuedAt: 1_050,
            claimedAt: 1_250,
            processingStartedAt: 1_250,
            payload: { messageId: 'message-queue' },
          },
        ];
      },
    },
    messageLifecycleSource: {
      async listOwnerMessagesInWindow() {
        return [];
      },
    },
    attentionEventLog: {
      async queryWindowBetween() {
        return {
          events: [
            {
              kind: 'held_decision',
              threadId: 'thread-live',
              catId: 'codex-sol',
              invocationId: 'inv-queue',
              timestamp: 1_300,
              toolName: 'cat_cafe_post_message',
              unseenCount: 1,
              reason: 'queued_messages_pending',
            },
          ],
          coverage,
        };
      },
    },
  });
}

before(() => {
  mkdirSync(join(harnessFeedbackRoot, 'eval-domains'), { recursive: true });
  writeFileSync(join(harnessFeedbackRoot, 'eval-domains', 'eval-freshness.yaml'), domainYaml);
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('publish_verdict eval:freshness measurement maturity', () => {
  it('refuses Queue and Supplement activity when attention window coverage is incomplete', async () => {
    const provider = await providerWithWindowedActivity({
      status: 'incomplete',
      reason: 'window_starts_before_coverage',
      completeFromMs: sourceRefs.windowStartMs + 500,
      observedThroughMs: sourceRefs.windowEndMs,
    });
    const generator = createFreshnessGeneratorAdapter(provider);
    let committed = false;
    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot,
        generator,
        gitPublisher: isolatedPublisher(join(root, 'blocked'), () => {
          committed = true;
        }),
      },
      {
        packet: packet('freshness-blocked'),
        domain: 'eval:freshness',
        catId: 'gpt52',
        ownerUserId: 'user-1',
        sourceRefs,
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 409);
    assert.equal(result.error, 'measurement_validity_gate');
    assert.match(result.detail, /attention_events:window_starts_before_coverage/);
    assert.equal(committed, false);
  });

  it('exports windowed lifecycle metrics when all sources prove complete coverage', async () => {
    const provider = await providerWithWindowedActivity({
      status: 'complete',
      completeFromMs: sourceRefs.windowStartMs,
      observedThroughMs: sourceRefs.windowEndMs,
    });
    const generator = createFreshnessGeneratorAdapter(provider);
    const isolatedRoot = join(root, 'ready');
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot, generator, gitPublisher: isolatedPublisher(isolatedRoot) },
      {
        packet: packet('freshness-ready'),
        domain: 'eval:freshness',
        catId: 'gpt52',
        ownerUserId: 'user-1',
        sourceRefs,
      },
    );

    assert.ok(!('error' in result), JSON.stringify(result));
    const bundle = join(isolatedRoot, 'docs', 'harness-feedback', 'bundles', 'freshness-ready');
    const snapshot = JSON.parse(readFileSync(join(bundle, 'snapshot.json'), 'utf8'));
    const attribution = JSON.parse(readFileSync(join(bundle, 'attribution.json'), 'utf8'));
    const signalComponent = snapshot.components.find((item) => item.id === 'freshness-windowed-signal-plane');
    assert.equal(snapshot.measurementMaturity.status, 'ready');
    assert.deepEqual(Object.keys(snapshot.measurementMaturity.sources).sort(), [
      'attention_events',
      'freshness_supplements',
      'legacy_closures',
      'queue_custody',
    ]);
    assert.equal(signalComponent.activationCounts.queued_seen, 1);
    assert.equal(signalComponent.activationCounts.supplement_offered, 1);
    assert.equal(signalComponent.frictionCounts.queue_seen_unhandled, 1);
    assert.equal(attribution.noFindingRecord.reason, 'no_legacy_closure_samples');
    assert.match(attribution.noFindingRecord.evidence, /owner-scoped lifecycle\/signal observations resolved/);
  });

  it('writes Queue, Supplement, gate, notice, and reinvoke signals into the verdict trend packet', async () => {
    const base = new FreshnessReplayProviderImpl({ store: new InMemoryFreshnessClosureStore(), fixtureRoot });
    const replay = signalReplay(await base.resolve(sourceRefs), sourceRefs, {
      status: 'ready',
      sources: allSources(),
      reasons: [],
    });
    const artifact = generateFreshnessLiveVerdict({
      verdictId: 'freshness-windowed-trend',
      harnessFeedbackRoot: join(root, 'direct', 'docs', 'harness-feedback'),
      domain,
      replay,
      submittedPacket: packet('freshness-windowed-trend'),
      generatedAt: '2026-09-05T12:00:00.000Z',
    });

    assert.equal(artifact.packet.dailyTrend.current.queued_seen, 1);
    assert.equal(artifact.packet.dailyTrend.current.queue_seen_unhandled_at_window_end, 1);
    assert.equal(artifact.packet.dailyTrend.current.supplement_offered, 1);
    assert.equal(artifact.packet.dailyTrend.current.gate_held, 1);
    assert.equal(artifact.packet.dailyTrend.current.notice_attached, 1);
    assert.equal(artifact.packet.dailyTrend.current.reinvoke_skipped, 0);
    assert.ok(artifact.packet.evidencePacket.metricRefs.includes('metric:freshness.queued_seen'));
    assert.ok(artifact.packet.evidencePacket.metricRefs.includes('metric:freshness.supplement_offered'));
    assert.ok(artifact.packet.evidencePacket.metricRefs.includes('metric:freshness.provider_notice_missed'));
  });
});
